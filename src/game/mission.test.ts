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
  createStandaloneMission,
  defaultActivitySettings,
  GAME_TASK_KINDS,
  prepareStandaloneRound,
  setActivitySettings,
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

// The push-variety activities only roll from level 2 (level 1 is pure
// vector training), so these tests bump the mission to level 2 and let
// the initial orders expire; the replacements roll with level-2 bands:
// console (0.75, 1], cow (0.65, 0.75], review (0.55, 0.65].
function levelTwoPushTask(roller: number | (() => number)) {
  let fn: () => number = () => 0.5;
  let nextId = 0;
  const dependencies: MissionDependencies = {
    random: () => fn(),
    makeId: () => {
      nextId += 1;
      return `task-${nextId}`;
    },
  };
  // Push task first: reader uf8 -> target push
  const mission = createMission(
    1_000,
    ["uf8", "push", "streamdeck"],
    dependencies,
  );
  mission.level = 2;
  const firstTask = orders(mission).tasks[0];
  if (firstTask === undefined) {
    throw new Error("Mission has no tasks");
  }
  fn = typeof roller === "function" ? roller : () => roller;
  advanceMission(mission, firstTask.deadlineAt, dependencies);
  return { mission, dependencies };
}

describe("activity settings and standalone launcher", () => {
  test("rejects settings that disable every game of a station", () => {
    const settings = defaultActivitySettings();
    settings["push-path"] = false;
    settings["push-defend"] = false;
    settings["push-console"] = false;
    settings["push-review"] = false;
    settings["push-cow"] = false;

    expect(setActivitySettings(settings)).toBe(false);
  });

  test("disabled games never roll as orders", () => {
    const settings = defaultActivitySettings();
    settings["push-console"] = false;
    expect(setActivitySettings(settings)).toBe(true);
    try {
      // 0.8 would land in the level-2 console band when enabled
      const { mission } = levelTwoPushTask(0.8);
      const pushTask = orders(mission).tasks.find(
        (task) => stationForTask(task) === "push",
      );
      expect(pushTask?.kind).toBe("push-path");
    } finally {
      setActivitySettings(defaultActivitySettings());
    }
  });

  test("creates one full-surface round for every standalone game", () => {
    const dependencies = deterministicDependencies();
    for (const kind of GAME_TASK_KINDS) {
      const mission = createStandaloneMission(
        kind,
        1_000,
        dependencies,
      );
      expect(mission.level).toBe(5);
      expect(orders(mission).tasks).toHaveLength(1);
      expect(orders(mission).tasks[0]?.kind).toBe(kind);
    }
  });

  test("starts a fresh selected round without wiping the session score", () => {
    const dependencies = deterministicDependencies();
    const mission = createStandaloneMission(
      "push-path",
      1_000,
      dependencies,
    );
    mission.score = 420;
    mission.combo = 3;
    mission.integrity = 12;
    mission.levelObjectivesCompleted = 7;

    prepareStandaloneRound(
      mission,
      ["uf8-fader"],
      2_000,
      dependencies,
    );

    expect(orders(mission).tasks[0]?.kind).toBe("uf8-fader");
    expect(mission.levelObjectivesCompleted).toBe(0);
    expect(mission.integrity).toBe(100);
    expect(mission.score).toBe(420);
    expect(mission.combo).toBe(3);
  });
});

describe("push console activity", () => {
  test("rolls a console order with 16 unique labels", () => {
    const { mission } = levelTwoPushTask(0.8);
    const task = taskOfKind(orders(mission), "push-console");

    expect(task.labels).toHaveLength(16);
    expect(new Set(task.labels).size).toBe(16);
    expect(task.action.kind).toBe("press");
    expect(task.verbDone).toBe(false);
    expect(task.labelDone).toBe(false);
  });

  test("completes a press order with verb and label in either order", () => {
    const { mission, dependencies } = levelTwoPushTask(0.8);
    const task = taskOfKind(orders(mission), "push-console");
    if (task.action.kind !== "press") {
      throw new Error("Expected a press action");
    }

    expect(
      applyHardwareEvent(
        mission,
        { kind: "push-console-label", index: task.targetIndex },
        20_000,
        dependencies,
      ).outcomes,
    ).toEqual([]);

    const update = applyHardwareEvent(
      mission,
      { kind: "push-console-verb", cc: task.action.verbCc },
      20_100,
      dependencies,
    );

    expect(update.outcomes[0]?.kind).toBe("completed");
  });

  test("a wrong control is a mistake and resets the order", () => {
    const { mission, dependencies } = levelTwoPushTask(0.8);
    const task = taskOfKind(orders(mission), "push-console");
    const integrityBefore = mission.integrity;

    applyHardwareEvent(
      mission,
      { kind: "push-console-label", index: task.targetIndex },
      20_000,
      dependencies,
    );
    const update = applyHardwareEvent(
      mission,
      { kind: "push-console-label", index: (task.targetIndex + 1) % 16 },
      20_100,
      dependencies,
    );

    expect(update.outcomes[0]?.kind).toBe("mistake");
    expect(mission.integrity).toBeLessThan(integrityBefore);
    expect(task.labelDone).toBe(false);
  });

  test("a scale order completes when the dial reaches the target", () => {
    // Replacement rolls: roll, 16 labels, verb, then the action roll
    // at call 19 (0.3 -> scale).
    let calls = -1;
    const { mission, dependencies } = levelTwoPushTask(() => {
      calls += 1;
      return calls === 19 ? 0.3 : 0.8;
    });
    const task = taskOfKind(orders(mission), "push-console");
    if (task.action.kind !== "scale") {
      throw new Error("Expected a scale action");
    }

    applyHardwareEvent(
      mission,
      { kind: "push-console-verb", cc: 58 }, // SCALES
      20_000,
      dependencies,
    );
    applyHardwareEvent(
      mission,
      { kind: "push-console-label", index: task.targetIndex },
      20_100,
      dependencies,
    );

    const wrongValue = task.action.value - 1;
    expect(
      applyHardwareEvent(
        mission,
        { kind: "push-console-set", value: wrongValue },
        20_200,
        dependencies,
      ).outcomes,
    ).toEqual([]);
    expect(task.value).toBe(wrongValue);

    const update = applyHardwareEvent(
      mission,
      { kind: "push-console-set", value: task.action.value },
      20_300,
      dependencies,
    );
    expect(update.outcomes[0]?.kind).toBe("completed");
  });
});

describe("push review activity", () => {
  // 0.6 lands in the level-2 review band and picks decision "save".
  test("rolls an announcement with a decision", () => {
    const { mission } = levelTwoPushTask(0.6);
    const task = taskOfKind(orders(mission), "push-review");

    expect(task.subject.length).toBeGreaterThan(0);
    expect(task.verb.length).toBeGreaterThan(0);
    expect(task.decision).toBe("save");
  });

  test("the ordered choice completes it; the other is a mistake", () => {
    const { mission, dependencies } = levelTwoPushTask(0.6);
    const task = taskOfKind(orders(mission), "push-review");
    const integrityBefore = mission.integrity;

    const wrong = applyHardwareEvent(
      mission,
      { kind: "push-review-choice", choice: "undo" },
      20_000,
      dependencies,
    );
    expect(wrong.outcomes[0]?.kind).toBe("mistake");
    expect(mission.integrity).toBeLessThan(integrityBefore);

    const update = applyHardwareEvent(
      mission,
      { kind: "push-review-choice", choice: task.decision },
      20_100,
      dependencies,
    );
    expect(update.outcomes[0]?.kind).toBe("completed");
  });
});

describe("push cow activity", () => {
  // 0.7 lands in the level-2 cow band and picks action "release".
  test("rolls a tractor beam order", () => {
    const { mission } = levelTwoPushTask(0.7);
    const task = taskOfKind(orders(mission), "push-cow");

    expect(task.action).toBe("release");
  });

  test("the reported direction decides the outcome", () => {
    const { mission, dependencies } = levelTwoPushTask(0.7);
    const task = taskOfKind(orders(mission), "push-cow");
    const integrityBefore = mission.integrity;

    const wrong = applyHardwareEvent(
      mission,
      { kind: "push-cow-done", action: "abduct" },
      20_000,
      dependencies,
    );
    expect(wrong.outcomes[0]?.kind).toBe("mistake");
    expect(mission.integrity).toBeLessThan(integrityBefore);

    const update = applyHardwareEvent(
      mission,
      { kind: "push-cow-done", action: task.action },
      20_100,
      dependencies,
    );
    expect(update.outcomes[0]?.kind).toBe("completed");
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
