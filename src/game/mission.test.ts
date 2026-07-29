import { describe, expect, test } from "bun:test";
import type {
  ActiveTask,
  MissionStations,
  PushPathTask,
  StreamDeckRouteTask,
  Uf8FaderTask,
} from "../shared/domain.ts";
import {
  STATIONS,
  stationForTask,
  taskForReader,
} from "../shared/domain.ts";
import {
  advanceMission,
  applyHardwareEvent,
  createMission,
  type MissionDependencies,
} from "./mission.ts";

function deterministicDependencies(): MissionDependencies {
  let nextId = 0;
  return {
    random: () => 0.25,
    makeId: () => {
      nextId += 1;
      return `task-${nextId}`;
    },
  };
}

function taskOfKind<T extends ActiveTask["kind"]>(
  tasks: ActiveTask[],
  kind: T,
): Extract<ActiveTask, { kind: T }> {
  const task = tasks.find(
    (candidate): candidate is Extract<ActiveTask, { kind: T }> =>
      candidate.kind === kind,
  );
  if (task === undefined) {
    throw new Error(`Missing ${kind} task`);
  }
  return task;
}

describe("mission creation", () => {
  test("creates one cross-routed task per reader", () => {
    const mission = createMission(1_000, STATIONS, deterministicDependencies());

    expect(mission.tasks).toHaveLength(3);
    for (const reader of ["streamdeck", "uf8", "push"] as const) {
      expect(stationForTask(taskForReader(mission, reader))).not.toBe(reader);
    }
  });

  test("cross-routes exactly two selected controller stations", () => {
    const stations: MissionStations = ["streamdeck", "uf8"];
    const mission = createMission(
      1_000,
      stations,
      deterministicDependencies(),
    );

    expect(mission.stations).toEqual(stations);
    expect(mission.tasks).toHaveLength(2);
    expect(stationForTask(taskForReader(mission, "streamdeck"))).toBe("uf8");
    expect(stationForTask(taskForReader(mission, "uf8"))).toBe("streamdeck");
    expect(mission.tasks.some((task) => task.reader === "push")).toBe(false);
  });

  test("ignores input from a controller outside the two-crew mission", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(
      1_000,
      ["streamdeck", "uf8"],
      dependencies,
    );

    const update = applyHardwareEvent(
      mission,
      {
        kind: "push-pad",
        point: { x: 2, y: 2 },
        phase: "down",
        velocity: 100,
      },
      2_000,
      dependencies,
    );

    expect(update.outcomes).toEqual([]);
    expect(mission.integrity).toBe(100);
  });

  test("creates a complete 8 by 4 Stream Deck layout", () => {
    const mission = createMission(1_000, STATIONS, deterministicDependencies());

    expect(mission.streamDeckKeys).toHaveLength(32);
    expect(new Set(mission.streamDeckKeys.map((key) => key.label)).size).toBe(
      32,
    );
  });
});

describe("controller-specific tasks", () => {
  test("completes a Stream Deck route in source-destination order", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const task = taskOfKind(
      mission.tasks,
      "streamdeck-route",
    ) as StreamDeckRouteTask;

    expect(
      applyHardwareEvent(
        mission,
        {
          kind: "streamdeck-key",
          keyIndex: task.sourceKeyIndex,
          phase: "down",
        },
        2_000,
        dependencies,
      ).outcomes,
    ).toEqual([]);

    const update = applyHardwareEvent(
      mission,
      {
        kind: "streamdeck-key",
        keyIndex: task.targetKeyIndex,
        phase: "down",
      },
      2_100,
      dependencies,
    );

    expect(update.outcomes[0]?.kind).toBe("completed");
    expect(mission.score).toBe(100);
  });

  test("requires a UF8 fader to remain in tolerance", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const task = taskOfKind(mission.tasks, "uf8-fader") as Uf8FaderTask;

    applyHardwareEvent(
      mission,
      {
        kind: "uf8-fader",
        channel: task.channel,
        value: task.target,
      },
      2_000,
      dependencies,
    );

    expect(advanceMission(mission, 2_300, dependencies).outcomes).toEqual([]);
    expect(advanceMission(mission, 2_500, dependencies).outcomes[0]?.kind).toBe(
      "completed",
    );
  });

  test("completes a Push path in spatial order", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const task = taskOfKind(mission.tasks, "push-path") as PushPathTask;

    for (const [index, point] of task.path.entries()) {
      const update = applyHardwareEvent(
        mission,
        { kind: "push-pad", point, phase: "down", velocity: 100 },
        2_000 + index,
        dependencies,
      );
      if (index < task.path.length - 1) {
        expect(update.outcomes).toEqual([]);
      } else {
        expect(update.outcomes[0]?.kind).toBe("completed");
      }
    }
  });
});

describe("push defend activity", () => {
  function defendDependencies(): MissionDependencies {
    let nextId = 0;
    return {
      random: () => 0.9, // rolls the defend variant for the Push station
      makeId: () => {
        nextId += 1;
        return `task-${nextId}`;
      },
    };
  }

  test("rolls a defend task with base parameters at mission start", () => {
    const mission = createMission(1_000, STATIONS, defendDependencies());
    const task = taskOfKind(mission.tasks, "push-defend");

    expect(task.missileSpeed).toBe(1.4);
    expect(task.spawnIntervalMs).toBe(1_300);
    expect(task.hull).toBe(8);
  });

  test("completes when the survival clock runs out", () => {
    const dependencies = defendDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const task = taskOfKind(mission.tasks, "push-defend");

    const update = advanceMission(mission, task.deadlineAt, dependencies);

    expect(
      update.outcomes.some(
        (outcome) => outcome.kind === "completed" && outcome.target === "push",
      ),
    ).toBe(true);
    expect(mission.score).toBe(100);
  });

  test("a bridge failure report ends it like an expired order", () => {
    const dependencies = defendDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const task = taskOfKind(mission.tasks, "push-defend");

    const update = applyHardwareEvent(
      mission,
      { kind: "push-defend-failed" },
      2_000,
      dependencies,
    );

    expect(update.outcomes[0]?.kind).toBe("expired");
    expect(mission.integrity).toBe(88);
    expect(taskOfKind(mission.tasks, "push-defend").id).not.toBe(task.id);
  });

  test("replacement tasks get faster later in the mission", () => {
    const dependencies = defendDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);

    applyHardwareEvent(
      mission,
      { kind: "push-defend-failed" },
      46_000, // halfway through the 90s mission
      dependencies,
    );

    const replacement = taskOfKind(mission.tasks, "push-defend");
    expect(replacement.missileSpeed).toBe(2.3);
    expect(replacement.spawnIntervalMs).toBe(925);
  });
});

describe("mission pressure", () => {
  test("damages integrity and replaces expired orders", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const oldIds = mission.tasks.map((task) => task.id);

    const update = advanceMission(mission, 15_000, dependencies);

    expect(
      update.outcomes.filter((outcome) => outcome.kind === "expired"),
    ).toHaveLength(3);
    expect(mission.integrity).toBe(64);
    expect(mission.tasks.map((task) => task.id)).not.toEqual(oldIds);
  });
});
