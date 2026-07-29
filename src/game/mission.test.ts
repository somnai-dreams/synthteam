import { describe, expect, test } from "bun:test";
import type {
  ActiveTask,
  LocalOverrideTask,
  MissionState,
  MissionStations,
  OrdersActivity,
  PushPathTask,
  ReactorProcedureActivity,
  StreamDeckRouteTask,
  StreamDeckSequenceTask,
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

function deterministicDependencies(random = 0.25): MissionDependencies {
  let nextId = 0;
  return {
    random: () => random,
    makeId: () => {
      nextId += 1;
      return `task-${nextId}`;
    },
  };
}

function orders(mission: MissionState): OrdersActivity {
  if (mission.activity.kind !== "orders") {
    throw new Error(`Expected orders, got ${mission.activity.kind}`);
  }
  return mission.activity;
}

function procedure(mission: MissionState): ReactorProcedureActivity {
  if (mission.activity.kind !== "reactor-procedure") {
    throw new Error(`Expected procedure, got ${mission.activity.kind}`);
  }
  return mission.activity;
}

function taskOfKind<T extends ActiveTask["kind"]>(
  activity: OrdersActivity,
  kind: T,
): Extract<ActiveTask, { kind: T }> {
  const task = activity.tasks.find(
    (candidate): candidate is Extract<ActiveTask, { kind: T }> =>
      candidate.kind === kind,
  );
  if (task === undefined) {
    throw new Error(`Missing ${kind} task`);
  }
  return task;
}

function overrideOfKind<T extends LocalOverrideTask["kind"]>(
  mission: MissionState,
  kind: T,
): Extract<LocalOverrideTask, { kind: T }> {
  if (mission.activity.kind !== "local-overrides") {
    throw new Error(`Expected local overrides, got ${mission.activity.kind}`);
  }
  const task = mission.activity.tasks.find(
    (candidate): candidate is Extract<LocalOverrideTask, { kind: T }> =>
      candidate.kind === kind,
  );
  if (task === undefined) {
    throw new Error(`Missing ${kind} override`);
  }
  return task;
}

function beginLocalOverrides(
  mission: MissionState,
  dependencies: MissionDependencies,
): void {
  const update = advanceMission(mission, 19_000, dependencies);
  expect(update.outcomes).toContainEqual({
    kind: "activity-started",
    activity: "local-overrides",
  });
}

function completeLocalOverrides(
  mission: MissionState,
  dependencies: MissionDependencies,
  now: number,
): void {
  const deck = overrideOfKind(mission, "streamdeck-hit");
  applyHardwareEvent(
    mission,
    {
      kind: "streamdeck-key",
      keyIndex: deck.keyIndex,
      phase: "down",
    },
    now,
    dependencies,
  );

  applyHardwareEvent(
    mission,
    { kind: "uf8-fader", channel: 0, value: 0 },
    now + 1,
    dependencies,
  );

  for (const [index, point] of [
    { x: 0, y: 0 },
    { x: 7, y: 0 },
    { x: 0, y: 7 },
    { x: 7, y: 7 },
  ].entries()) {
    applyHardwareEvent(
      mission,
      { kind: "push-pad", point, phase: "down", velocity: 100 },
      now + 2 + index,
      dependencies,
    );
  }
}

describe("mission creation", () => {
  test("creates one cross-routed order per reader", () => {
    const mission = createMission(1_000, STATIONS, deterministicDependencies());
    const activity = orders(mission);

    expect(activity.tasks).toHaveLength(3);
    for (const reader of ["streamdeck", "uf8", "push"] as const) {
      expect(stationForTask(taskForReader(activity, reader))).not.toBe(reader);
    }
  });

  test("cross-routes exactly two selected controller stations", () => {
    const stations: MissionStations = ["streamdeck", "uf8"];
    const mission = createMission(
      1_000,
      stations,
      deterministicDependencies(),
    );
    const activity = orders(mission);

    expect(mission.stations).toEqual(stations);
    expect(activity.tasks).toHaveLength(2);
    expect(stationForTask(taskForReader(activity, "streamdeck"))).toBe("uf8");
    expect(stationForTask(taskForReader(activity, "uf8"))).toBe("streamdeck");
    expect(activity.tasks.some((task) => task.reader === "push")).toBe(false);
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

describe("cross-routed orders", () => {
  test("completes a Stream Deck route in source-destination order", () => {
    const dependencies = deterministicDependencies(0.75);
    const mission = createMission(1_000, STATIONS, dependencies);
    const task = taskOfKind(
      orders(mission),
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

  test("requires hold, tap, and release for a Stream Deck sequence", () => {
    const dependencies = deterministicDependencies(0.25);
    const mission = createMission(1_000, STATIONS, dependencies);
    const task = taskOfKind(
      orders(mission),
      "streamdeck-sequence",
    ) as StreamDeckSequenceTask;

    applyHardwareEvent(
      mission,
      {
        kind: "streamdeck-key",
        keyIndex: task.holdKeyIndex,
        phase: "down",
      },
      2_000,
      dependencies,
    );
    applyHardwareEvent(
      mission,
      {
        kind: "streamdeck-key",
        keyIndex: task.tapKeyIndex,
        phase: "down",
      },
      2_010,
      dependencies,
    );
    expect(task.progress).toBe(2);

    const update = applyHardwareEvent(
      mission,
      {
        kind: "streamdeck-key",
        keyIndex: task.holdKeyIndex,
        phase: "up",
      },
      2_020,
      dependencies,
    );

    expect(update.outcomes[0]?.kind).toBe("completed");
  });

  test("requires a UF8 fader to remain in tolerance", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const task = taskOfKind(
      orders(mission),
      "uf8-fader",
    ) as Uf8FaderTask;

    applyHardwareEvent(
      mission,
      {
        kind: "uf8-fader",
        channel: task.channel,
        value: task.target.value,
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
    const task = taskOfKind(
      orders(mission),
      "push-path",
    ) as PushPathTask;

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
    const task = taskOfKind(orders(mission), "push-defend");

    expect(task.missileSpeed).toBe(1.4);
    expect(task.spawnIntervalMs).toBe(1_300);
    expect(task.hull).toBe(8);
  });

  test("completes when the survival clock runs out", () => {
    const dependencies = defendDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const task = taskOfKind(orders(mission), "push-defend");

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
    const task = taskOfKind(orders(mission), "push-defend");

    const update = applyHardwareEvent(
      mission,
      { kind: "push-defend-failed" },
      2_000,
      dependencies,
    );

    expect(update.outcomes[0]?.kind).toBe("expired");
    expect(mission.integrity).toBe(88);
    expect(taskOfKind(orders(mission), "push-defend").id).not.toBe(task.id);
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

    const replacement = taskOfKind(orders(mission), "push-defend");
    expect(replacement.missileSpeed).toBe(2.3);
    expect(replacement.spawnIntervalMs).toBe(925);
  });
});

describe("mission rhythm", () => {
  test("moves from shouted orders into simultaneous local overrides", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);

    beginLocalOverrides(mission, dependencies);

    expect(mission.activity.kind).toBe("local-overrides");
    if (mission.activity.kind !== "local-overrides") {
      throw new Error("Expected local overrides");
    }
    expect(mission.activity.tasks.map((task) => task.station)).toEqual([
      ...STATIONS,
    ]);
  });

  test("returns to orders as soon as every local override clears", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    beginLocalOverrides(mission, dependencies);

    completeLocalOverrides(mission, dependencies, 19_100);

    expect(mission.activity.kind).toBe("orders");
    expect(orders(mission).beat).toBe("pressure");
    expect(mission.score).toBe(150);
  });

  test("makes missed microgames cheap and continues the mission", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    beginLocalOverrides(mission, dependencies);

    const update = advanceMission(mission, 25_000, dependencies);

    expect(
      update.outcomes.filter(
        (outcome) => outcome.kind === "local-override-expired",
      ),
    ).toHaveLength(3);
    expect(mission.integrity).toBe(91);
    expect(orders(mission).beat).toBe("pressure");
  });

  test("runs the shared reactor procedure before final orders", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    beginLocalOverrides(mission, dependencies);
    completeLocalOverrides(mission, dependencies, 19_100);
    advanceMission(mission, 37_105, dependencies);
    const activeProcedure = procedure(mission);
    const first = activeProcedure.procedure.profile.targets[0];
    const second = activeProcedure.procedure.profile.targets[1];

    applyHardwareEvent(
      mission,
      {
        kind: "uf8-fader",
        channel: first.channel,
        value: first.stop.value,
      },
      37_200,
      dependencies,
    );
    applyHardwareEvent(
      mission,
      {
        kind: "uf8-fader",
        channel: second.channel,
        value: second.stop.value,
      },
      37_210,
      dependencies,
    );
    const update = advanceMission(mission, 37_900, dependencies);

    expect(update.outcomes[0]?.kind).toBe("procedure-completed");
    expect(orders(mission).beat).toBe("final");
    expect(mission.score).toBe(650);
  });
});

describe("mission pressure", () => {
  test("damages integrity and replaces expired orders", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const oldIds = orders(mission).tasks.map((task) => task.id);

    const update = advanceMission(mission, 15_000, dependencies);

    expect(
      update.outcomes.filter((outcome) => outcome.kind === "expired"),
    ).toHaveLength(3);
    expect(mission.integrity).toBe(64);
    expect(orders(mission).tasks.map((task) => task.id)).not.toEqual(oldIds);
  });
});
