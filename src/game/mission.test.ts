import { describe, expect, test } from "bun:test";
import type {
  ActiveTask,
  InterstitialActivity,
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
  missionLevelProfile,
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

function interstitial(mission: MissionState): InterstitialActivity {
  if (mission.activity.kind !== "interstitial") {
    throw new Error(`Expected interstitial, got ${mission.activity.kind}`);
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

function completeStreamDeckOrder(
  mission: MissionState,
  dependencies: MissionDependencies,
  now: number,
) {
  const task = orders(mission).tasks.find(
    (
      candidate,
    ): candidate is StreamDeckRouteTask | StreamDeckSequenceTask =>
      candidate.kind === "streamdeck-route" ||
      candidate.kind === "streamdeck-sequence",
  );
  if (task === undefined) {
    throw new Error("Mission has no Stream Deck order");
  }
  switch (task.kind) {
    case "streamdeck-route":
      applyHardwareEvent(
        mission,
        {
          kind: "streamdeck-key",
          keyIndex: task.sourceKeyIndex,
          phase: "down",
        },
        now,
        dependencies,
      );
      return applyHardwareEvent(
        mission,
        {
          kind: "streamdeck-key",
          keyIndex: task.targetKeyIndex,
          phase: "down",
        },
        now + 1,
        dependencies,
      );
    case "streamdeck-sequence":
      applyHardwareEvent(
        mission,
        {
          kind: "streamdeck-key",
          keyIndex: task.holdKeyIndex,
          phase: "down",
        },
        now,
        dependencies,
      );
      applyHardwareEvent(
        mission,
        {
          kind: "streamdeck-key",
          keyIndex: task.tapKeyIndex,
          phase: "down",
        },
        now + 1,
        dependencies,
      );
      return applyHardwareEvent(
        mission,
        {
          kind: "streamdeck-key",
          keyIndex: task.holdKeyIndex,
          phase: "up",
        },
        now + 2,
        dependencies,
      );
  }
}

function completeInterstitial(
  mission: MissionState,
  dependencies: MissionDependencies,
  now: number,
): void {
  const task = interstitial(mission).task;
  switch (task.kind) {
    case "streamdeck-hit":
      applyHardwareEvent(
        mission,
        {
          kind: "streamdeck-key",
          keyIndex: task.keyIndex,
          phase: "down",
        },
        now,
        dependencies,
      );
      return;
    case "uf8-bottom-out":
      for (let channel = 0; channel < task.channelCount; channel += 1) {
        applyHardwareEvent(
          mission,
          { kind: "uf8-fader", channel, value: 0 },
          now + channel,
          dependencies,
        );
        if (mission.activity.kind !== "interstitial") {
          return;
        }
      }
      return;
    case "push-corners": {
      const farEdge = task.gridSize - 1;
      for (const [index, point] of [
        { x: 0, y: 0 },
        { x: farEdge, y: 0 },
        { x: 0, y: farEdge },
        { x: farEdge, y: farEdge },
      ].entries()) {
        applyHardwareEvent(
          mission,
          { kind: "push-pad", point, phase: "down", velocity: 100 },
          now + index,
          dependencies,
        );
      }
      return;
    }
  }
}

function reachNextLevel(
  mission: MissionState,
  dependencies: MissionDependencies,
  now: number,
): void {
  const currentLevel = mission.level;
  const profile = missionLevelProfile(currentLevel);
  mission.levelObjectivesCompleted = profile.objectiveTarget - 1;
  completeStreamDeckOrder(mission, dependencies, now);
  expect(mission.activity.kind).toBe("interstitial");
  completeInterstitial(mission, dependencies, now + 100);
  expect(Number(mission.level)).toBe(currentLevel + 1);
  expect(mission.activity.kind).toBe("orders");
}

describe("mission level profiles", () => {
  test("starts at level one with only the smallest control regions active", () => {
    const mission = createMission(1_000, STATIONS, deterministicDependencies());
    const profile = missionLevelProfile(mission.level);

    expect(mission.level).toBe(1);
    expect(mission.levelObjectivesCompleted).toBe(0);
    expect(profile.streamDeckColumns).toBe(2);
    expect(profile.uf8Channels).toBe(2);
    expect(profile.pushGridSize).toBe(3);
    expect(profile.objectiveTarget).toBe(3);
  });

  test("keeps every generated task inside each level's active controls", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);

    for (const level of [1, 2, 3, 4, 5] as const) {
      expect(mission.level).toBe(level);
      const profile = missionLevelProfile(level);
      for (const task of orders(mission).tasks) {
        switch (task.kind) {
          case "streamdeck-route":
            expect(task.sourceKeyIndex % 8).toBeLessThan(
              profile.streamDeckColumns,
            );
            expect(task.targetKeyIndex % 8).toBeLessThan(
              profile.streamDeckColumns,
            );
            break;
          case "streamdeck-sequence":
            expect(task.holdKeyIndex % 8).toBeLessThan(
              profile.streamDeckColumns,
            );
            expect(task.tapKeyIndex % 8).toBeLessThan(
              profile.streamDeckColumns,
            );
            break;
          case "uf8-fader":
            expect(task.channel).toBeLessThan(profile.uf8Channels);
            break;
          case "push-path":
            expect(task.path).toHaveLength(profile.pushPathLength);
            expect(
              task.path.every(
                (point) =>
                  point.x < profile.pushGridSize &&
                  point.y < profile.pushGridSize,
              ),
            ).toBe(true);
            break;
          case "push-defend":
            expect(profile.pushGridSize).toBe(8);
            break;
        }
      }
      if (level < 5) {
        reachNextLevel(mission, dependencies, 10_000 * level);
      }
    }
  });

  test("ignores input from locked controls without treating it as a mistake", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);

    const update = applyHardwareEvent(
      mission,
      { kind: "streamdeck-key", keyIndex: 7, phase: "down" },
      2_000,
      dependencies,
    );

    expect(update.outcomes).toEqual([]);
    expect(mission.integrity).toBe(100);
  });
});

describe("cross-routed orders", () => {
  test("creates one cross-routed order per reader", () => {
    const mission = createMission(1_000, STATIONS, deterministicDependencies());
    const activity = orders(mission);

    expect(activity.tasks).toHaveLength(3);
    for (const reader of STATIONS) {
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

    expect(activity.tasks).toHaveLength(2);
    expect(stationForTask(taskForReader(activity, "streamdeck"))).toBe("uf8");
    expect(stationForTask(taskForReader(activity, "uf8"))).toBe("streamdeck");
  });

  test("completes a Stream Deck route in source-destination order", () => {
    const dependencies = deterministicDependencies(0.75);
    const mission = createMission(1_000, STATIONS, dependencies);

    const update = completeStreamDeckOrder(mission, dependencies, 2_000);

    expect(update.outcomes[0]?.kind).toBe("completed");
    expect(mission.score).toBe(100);
    expect(mission.levelObjectivesCompleted).toBe(1);
  });

  test("requires a UF8 fader to remain in tolerance", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const task = taskOfKind(orders(mission), "uf8-fader") as Uf8FaderTask;

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
    expect(advanceMission(mission, 2_400, dependencies).outcomes[0]?.kind).toBe(
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
      expect(update.outcomes).toHaveLength(
        index === task.path.length - 1 ? 1 : 0,
      );
    }
  });
});

describe("level progression and interstitials", () => {
  test("clears a quota into one focused six-second interstitial", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    mission.levelObjectivesCompleted = 2;

    const update = completeStreamDeckOrder(mission, dependencies, 2_000);
    const activeInterstitial = interstitial(mission);

    expect(update.outcomes).toContainEqual({
      kind: "level-completed",
      level: 1,
    });
    expect(activeInterstitial.task.station).toBe("streamdeck");
    expect(activeInterstitial.endsAt - activeInterstitial.startedAt).toBe(
      6_000,
    );
    expect(mission.level).toBe(1);
  });

  test("successful interstitials award a bonus and unlock the next level", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    mission.levelObjectivesCompleted = 2;
    completeStreamDeckOrder(mission, dependencies, 2_000);

    completeInterstitial(mission, dependencies, 2_100);

    expect(mission.level).toBe(2);
    expect(mission.levelObjectivesCompleted).toBe(0);
    expect(mission.score).toBe(150);
  });

  test("missed interstitials apply a mild penalty but never block progression", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    mission.levelObjectivesCompleted = 2;
    completeStreamDeckOrder(mission, dependencies, 2_000);
    const endsAt = interstitial(mission).endsAt;

    const update = advanceMission(mission, endsAt, dependencies);

    expect(update.outcomes[0]?.kind).toBe("interstitial-expired");
    expect(mission.integrity).toBe(97);
    expect(mission.level).toBe(2);
  });

  test("rotates solo interstitials across the connected stations", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const focusStations = [];

    for (let level = 1; level < 5; level += 1) {
      mission.levelObjectivesCompleted =
        missionLevelProfile(mission.level).objectiveTarget - 1;
      completeStreamDeckOrder(mission, dependencies, 10_000 * level);
      focusStations.push(interstitial(mission).task.station);
      completeInterstitial(mission, dependencies, 10_000 * level + 100);
    }

    expect(focusStations).toEqual([
      "streamdeck",
      "uf8",
      "push",
      "streamdeck",
    ]);
  });

  test("runs the reactor procedure as the level-five finale", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    reachNextLevel(mission, dependencies, 10_000);
    reachNextLevel(mission, dependencies, 20_000);
    reachNextLevel(mission, dependencies, 30_000);
    reachNextLevel(mission, dependencies, 40_000);
    mission.levelObjectivesCompleted = 7;
    completeStreamDeckOrder(mission, dependencies, 50_000);
    const activeProcedure = procedure(mission);

    for (const [index, target] of activeProcedure.procedure.profile.targets.entries()) {
      applyHardwareEvent(
        mission,
        {
          kind: "uf8-fader",
          channel: target.channel,
          value: target.stop.value,
        },
        50_100 + index,
        dependencies,
      );
    }
    const update = advanceMission(mission, 50_800, dependencies);

    expect(update.outcomes[0]?.kind).toBe("procedure-completed");
    expect(update.outcomes).toContainEqual({
      kind: "mission-ended",
      reason: "survived",
    });
  });

  test("finishes level five directly when the two-person crew has no UF8", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(
      1_000,
      ["streamdeck", "push"],
      dependencies,
    );
    reachNextLevel(mission, dependencies, 10_000);
    reachNextLevel(mission, dependencies, 20_000);
    reachNextLevel(mission, dependencies, 30_000);
    reachNextLevel(mission, dependencies, 40_000);
    mission.levelObjectivesCompleted = 7;

    const update = completeStreamDeckOrder(mission, dependencies, 50_000);

    expect(update.outcomes).toContainEqual({
      kind: "mission-ended",
      reason: "survived",
    });
  });
});

describe("mission pressure", () => {
  test("damages integrity and replaces expired orders", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);
    const oldIds = orders(mission).tasks.map((task) => task.id);

    const update = advanceMission(mission, 20_000, dependencies);

    expect(
      update.outcomes.filter((outcome) => outcome.kind === "expired"),
    ).toHaveLength(3);
    expect(mission.integrity).toBe(64);
    expect(orders(mission).tasks.map((task) => task.id)).not.toEqual(oldIds);
  });

  test("introduces Push defend only once the full grid unlocks", () => {
    const dependencies = deterministicDependencies(0.9);
    const mission = createMission(1_000, STATIONS, dependencies);
    reachNextLevel(mission, dependencies, 10_000);
    reachNextLevel(mission, dependencies, 20_000);
    reachNextLevel(mission, dependencies, 30_000);
    const defend = taskOfKind(orders(mission), "push-defend");

    expect(mission.level).toBe(4);
    expect(defend.missileSpeed).toBe(2.4);
    expect(defend.spawnIntervalMs).toBe(900);
    expect(defend.hull).toBe(8);
  });
});
