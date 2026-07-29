import type {
  ActiveTask,
  GridPoint,
  HardwareEvent,
  InterstitialActivity,
  InterstitialTask,
  MissionLevel,
  MissionLevelProfile,
  MissionOutcome,
  MissionState,
  MissionStations,
  MissionUpdate,
  OrdersActivity,
  PushPathColor,
  ReactorProcedureActivity,
  Station,
  StreamDeckKey,
  StreamDeckKeyColor,
  Uf8FaderValues,
} from "../shared/domain.ts";
import {
  isActivePushPoint,
  isActiveStreamDeckKey,
  isActiveUf8Channel,
  missionLevelProfile,
  REACTOR_PROFILES,
  STATIONS,
  stationForTask,
  UF8_CONTROL_LABELS,
  UF8_FADER_STOPS,
} from "../shared/domain.ts";

const INTERSTITIAL_DURATION_MS = 6_000;
const WRONG_ACTION_DAMAGE = 3;
const EXPIRED_TASK_DAMAGE = 12;
const INTERSTITIAL_DAMAGE = 3;
const REACTOR_PROCEDURE_DAMAGE = 18;
const COMPLETION_REPAIR = 2;
const REACTOR_PROCEDURE_REPAIR = 8;
const INTERSTITIAL_POINTS = 50;
const REACTOR_PROCEDURE_POINTS = 500;
const REACTOR_PROCEDURE_DURATION_MS = 20_000;
const REACTOR_HOLD_MS = 650;
const UF8_BOTTOM_THRESHOLD = 5;
const PUSH_DEFEND_HULL = 8;

const STREAM_DECK_LABELS = [
  "BERYL",
  "NINE",
  "OXIDE",
  "LYRA",
  "KITE",
  "PRISM",
  "MICA",
  "GHOST",
  "AUX 4",
  "RIFT",
  "ORBIT",
  "COMET",
  "NOVA",
  "LATCH",
  "ION",
  "HUSH",
  "EMBER",
  "POLAR",
  "ZETA",
  "VAULT",
  "ECHO",
  "DELTA",
  "SHUNT",
  "VECTOR",
  "QUILL",
  "STATIC",
  "HELIX",
  "PULSE",
  "TANGENT",
  "CINDER",
  "PHASE",
  "RELAY",
] as const;

const STREAM_DECK_COLORS: readonly StreamDeckKeyColor[] = [
  "cyan",
  "amber",
  "magenta",
  "green",
];

const PUSH_COLORS: readonly PushPathColor[] = [
  "violet",
  "cyan",
  "amber",
  "lime",
];

const DEFAULT_UF8_FADERS: Uf8FaderValues = [0, 0, 0, 0, 0, 0, 0, 0];

export type MissionDependencies = {
  random: () => number;
  makeId: () => string;
};

const DEFAULT_DEPENDENCIES: MissionDependencies = {
  random: Math.random,
  makeId: () => crypto.randomUUID(),
};

export function createMission(
  now: number,
  stations: MissionStations = STATIONS,
  dependencies: MissionDependencies = DEFAULT_DEPENDENCIES,
  initialUf8Faders: Uf8FaderValues = DEFAULT_UF8_FADERS,
): MissionState {
  assertUniqueStations(stations);
  const level: MissionLevel = 1;
  return {
    startedAt: now,
    stations,
    level,
    levelObjectivesCompleted: 0,
    score: 0,
    integrity: 100,
    combo: 0,
    streamDeckKeys: createStreamDeckLayout(),
    uf8Faders: copyUf8Faders(initialUf8Faders),
    activity: createOrdersActivity(
      stations,
      now,
      dependencies,
      missionLevelProfile(level),
    ),
  };
}

export function applyHardwareEvent(
  mission: MissionState,
  event: HardwareEvent,
  now: number,
  dependencies: MissionDependencies = DEFAULT_DEPENDENCIES,
): MissionUpdate {
  const profile = missionLevelProfile(mission.level);
  if (
    mission.integrity <= 0 ||
    !mission.stations.some((station) => station === stationForEvent(event)) ||
    !isEventActive(profile, event)
  ) {
    return { outcomes: [] };
  }

  if (event.kind === "uf8-fader") {
    mission.uf8Faders[event.channel] = event.value;
  }

  switch (mission.activity.kind) {
    case "orders":
      return applyOrderEvent(mission, mission.activity, event, now, dependencies);
    case "interstitial":
      return applyInterstitialEvent(
        mission,
        mission.activity,
        event,
        now,
        dependencies,
      );
    case "reactor-procedure":
      updateReactorHold(mission, mission.activity, event, now);
      return { outcomes: [] };
  }
}

export function advanceMission(
  mission: MissionState,
  now: number,
  dependencies: MissionDependencies = DEFAULT_DEPENDENCIES,
): MissionUpdate {
  if (mission.integrity <= 0) {
    return {
      outcomes: [{ kind: "mission-ended", reason: "integrity" }],
    };
  }

  let outcomes: MissionOutcome[];
  switch (mission.activity.kind) {
    case "orders":
      outcomes = advanceOrders(mission, mission.activity, now, dependencies);
      break;
    case "interstitial":
      outcomes = advanceInterstitial(
        mission,
        mission.activity,
        now,
        dependencies,
      );
      break;
    case "reactor-procedure":
      outcomes = advanceReactorProcedure(mission, mission.activity, now);
      break;
  }

  if (
    mission.integrity <= 0 &&
    !outcomes.some((outcome) => outcome.kind === "mission-ended")
  ) {
    outcomes.push({ kind: "mission-ended", reason: "integrity" });
  }
  return { outcomes };
}

function createStreamDeckLayout(): readonly StreamDeckKey[] {
  return STREAM_DECK_LABELS.map((label, index) => ({
    index,
    label,
    color: STREAM_DECK_COLORS[Math.floor(index / 8)] ?? "cyan",
  }));
}

function createOrdersActivity(
  stations: MissionStations,
  now: number,
  dependencies: MissionDependencies,
  profile: MissionLevelProfile,
): OrdersActivity {
  const tasks: ActiveTask[] = [];
  for (let index = 0; index < stations.length; index += 1) {
    const reader = stations[index];
    const target = stations[(index + 1) % stations.length];
    if (reader === undefined || target === undefined) {
      throw new Error("Mission route is missing a station");
    }
    tasks.push(createTaskForRoute(reader, target, now, dependencies, profile));
  }
  return { kind: "orders", startedAt: now, tasks };
}

function createInterstitialActivity(
  mission: MissionState,
  now: number,
  dependencies: MissionDependencies,
): InterstitialActivity {
  const profile = missionLevelProfile(mission.level);
  const station = mission.stations[(mission.level - 1) % mission.stations.length];
  if (station === undefined) {
    throw new Error("Interstitial rotation is missing a crew station");
  }
  const deadlineAt = now + INTERSTITIAL_DURATION_MS;
  return {
    kind: "interstitial",
    startedAt: now,
    endsAt: deadlineAt,
    completedLevel: mission.level,
    nextLevel: nextMissionLevel(mission.level),
    task: createInterstitialTask(
      station,
      profile,
      now,
      deadlineAt,
      dependencies,
    ),
  };
}

function createInterstitialTask(
  station: Station,
  profile: MissionLevelProfile,
  now: number,
  deadlineAt: number,
  dependencies: MissionDependencies,
): InterstitialTask {
  const base = {
    id: dependencies.makeId(),
    startedAt: now,
    deadlineAt,
    completed: false,
  };
  switch (station) {
    case "streamdeck": {
      const activeKeys = activeStreamDeckKeyIndices(profile);
      const keyIndex =
        activeKeys[
          randomInteger(dependencies.random, 0, activeKeys.length - 1)
        ];
      if (keyIndex === undefined) {
        throw new Error("Interstitial has no active Stream Deck key");
      }
      return {
        ...base,
        kind: "streamdeck-hit",
        station,
        keyIndex,
      };
    }
    case "uf8":
      return {
        ...base,
        kind: "uf8-bottom-out",
        station,
        channelCount: profile.uf8Channels,
        threshold: UF8_BOTTOM_THRESHOLD,
      };
    case "push":
      return {
        ...base,
        kind: "push-corners",
        station,
        gridSize: profile.pushGridSize,
        pressed: [],
      };
  }
}

function createReactorProcedureActivity(
  mission: MissionState,
  now: number,
  dependencies: MissionDependencies,
): ReactorProcedureActivity {
  const profile =
    REACTOR_PROFILES[
      randomInteger(dependencies.random, 0, REACTOR_PROFILES.length - 1)
    ];
  if (profile === undefined) {
    throw new Error("Reactor procedure has no calibration profile");
  }
  const deadlineAt = now + REACTOR_PROCEDURE_DURATION_MS;
  const reader = readerForTarget(mission.stations, "uf8");
  const activity: ReactorProcedureActivity = {
    kind: "reactor-procedure",
    startedAt: now,
    endsAt: deadlineAt,
    procedure: {
      id: dependencies.makeId(),
      reader,
      createdAt: now,
      deadlineAt,
      profile,
      tolerance: 3,
      holdMs: REACTOR_HOLD_MS,
      withinSince: null,
    },
  };
  if (reactorTargetsAreSet(mission, activity)) {
    activity.procedure.withinSince = now;
  }
  return activity;
}

function createTaskForRoute(
  reader: Station,
  target: Station,
  now: number,
  dependencies: MissionDependencies,
  profile: MissionLevelProfile,
): ActiveTask {
  switch (target) {
    case "streamdeck":
      return dependencies.random() < profile.streamDeckSequenceChance
        ? createStreamDeckSequenceTask(reader, now, dependencies, profile)
        : createStreamDeckRouteTask(reader, now, dependencies, profile);
    case "uf8":
      return createUf8Task(reader, now, dependencies, profile);
    case "push":
      return createPushTask(reader, now, dependencies, profile);
  }
}

function createStreamDeckRouteTask(
  reader: Station,
  now: number,
  dependencies: MissionDependencies,
  profile: MissionLevelProfile,
): ActiveTask {
  const [sourceKeyIndex, targetKeyIndex] = twoActiveStreamDeckKeys(
    profile,
    dependencies.random,
  );
  return {
    kind: "streamdeck-route",
    id: dependencies.makeId(),
    reader,
    createdAt: now,
    deadlineAt: now + profile.taskDurationMs,
    sourceKeyIndex,
    targetKeyIndex,
    progress: 0,
  };
}

function createStreamDeckSequenceTask(
  reader: Station,
  now: number,
  dependencies: MissionDependencies,
  profile: MissionLevelProfile,
): ActiveTask {
  const [holdKeyIndex, tapKeyIndex] = twoActiveStreamDeckKeys(
    profile,
    dependencies.random,
  );
  return {
    kind: "streamdeck-sequence",
    id: dependencies.makeId(),
    reader,
    createdAt: now,
    deadlineAt: now + profile.taskDurationMs,
    holdKeyIndex,
    tapKeyIndex,
    progress: 0,
  };
}

function twoActiveStreamDeckKeys(
  profile: MissionLevelProfile,
  random: () => number,
): readonly [number, number] {
  const activeKeys = activeStreamDeckKeyIndices(profile);
  const sourcePosition = randomInteger(random, 0, activeKeys.length - 1);
  const offset = randomInteger(random, 1, activeKeys.length - 1);
  const source = activeKeys[sourcePosition];
  const target = activeKeys[(sourcePosition + offset) % activeKeys.length];
  if (source === undefined || target === undefined) {
    throw new Error("Stream Deck task has no active key pair");
  }
  return [source, target];
}

function activeStreamDeckKeyIndices(
  profile: MissionLevelProfile,
): readonly number[] {
  const indices: number[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < profile.streamDeckColumns; column += 1) {
      indices.push(row * 8 + column);
    }
  }
  return indices;
}

function createUf8Task(
  reader: Station,
  now: number,
  dependencies: MissionDependencies,
  profile: MissionLevelProfile,
): ActiveTask {
  const channel = randomInteger(
    dependencies.random,
    0,
    profile.uf8Channels - 1,
  );
  const label = UF8_CONTROL_LABELS[channel];
  if (label === undefined) {
    throw new Error("UF8 channel has no system label");
  }
  const target =
    UF8_FADER_STOPS[
      randomInteger(dependencies.random, 0, UF8_FADER_STOPS.length - 1)
    ];
  if (target === undefined) {
    throw new Error("UF8 task has no physical fader stop");
  }
  return {
    kind: "uf8-fader",
    id: dependencies.makeId(),
    reader,
    createdAt: now,
    deadlineAt: now + profile.taskDurationMs,
    channel,
    label,
    target,
    tolerance: profile.uf8Tolerance,
    holdMs: profile.uf8HoldMs,
    withinSince: null,
  };
}

function createPushTask(
  reader: Station,
  now: number,
  dependencies: MissionDependencies,
  profile: MissionLevelProfile,
): ActiveTask {
  if (dependencies.random() > 1 - profile.pushDefendChance) {
    return {
      kind: "push-defend",
      id: dependencies.makeId(),
      reader,
      createdAt: now,
      deadlineAt: now + profile.taskDurationMs,
      missileSpeed: profile.pushDefendSpeed,
      spawnIntervalMs: profile.pushDefendSpawnIntervalMs,
      hull: PUSH_DEFEND_HULL,
    };
  }
  return {
    kind: "push-path",
    id: dependencies.makeId(),
    reader,
    createdAt: now,
    deadlineAt: now + profile.taskDurationMs,
    color:
      PUSH_COLORS[randomInteger(dependencies.random, 0, PUSH_COLORS.length - 1)] ??
      "violet",
    path: createPushPath(
      dependencies.random,
      profile.pushGridSize,
      profile.pushPathLength,
    ),
    progress: 0,
  };
}

function createPushPath(
  random: () => number,
  gridSize: number,
  pathLength: number,
): readonly GridPoint[] {
  const cells: GridPoint[] = [];
  for (let y = 0; y < gridSize; y += 1) {
    if (y % 2 === 0) {
      for (let x = 0; x < gridSize; x += 1) {
        cells.push({ x, y });
      }
    } else {
      for (let x = gridSize - 1; x >= 0; x -= 1) {
        cells.push({ x, y });
      }
    }
  }
  const start = randomInteger(random, 0, cells.length - pathLength);
  return cells.slice(start, start + pathLength);
}

type TaskEventResult = "ignored" | "progress" | "mistake" | "completed";

function applyOrderEvent(
  mission: MissionState,
  activity: OrdersActivity,
  event: HardwareEvent,
  now: number,
  dependencies: MissionDependencies,
): MissionUpdate {
  const taskIndex = activity.tasks.findIndex(
    (task) => stationForTask(task) === stationForEvent(event),
  );
  const task = activity.tasks[taskIndex];
  if (task === undefined) {
    return { outcomes: [] };
  }

  if (event.kind === "push-defend-failed") {
    if (task.kind !== "push-defend") {
      return { outcomes: [] };
    }
    return {
      outcomes: [
        expireTaskAt(mission, activity, taskIndex, now, dependencies),
      ],
    };
  }

  const result = applyEventToTask(task, event, now);
  switch (result) {
    case "ignored":
    case "progress":
      return { outcomes: [] };
    case "mistake":
      mission.integrity = Math.max(0, mission.integrity - WRONG_ACTION_DAMAGE);
      mission.combo = 0;
      return {
        outcomes: [
          {
            kind: "mistake",
            taskId: task.id,
            reader: task.reader,
            target: stationForTask(task),
          },
        ],
      };
    case "completed":
      return completeTaskAt(mission, activity, taskIndex, now, dependencies);
  }
}

function applyEventToTask(
  task: ActiveTask,
  event: HardwareEvent,
  now: number,
): TaskEventResult {
  switch (task.kind) {
    case "streamdeck-route":
      if (event.kind !== "streamdeck-key" || event.phase === "up") {
        return "ignored";
      }
      if (task.progress === 0 && event.keyIndex === task.sourceKeyIndex) {
        task.progress = 1;
        return "progress";
      }
      if (task.progress === 1 && event.keyIndex === task.targetKeyIndex) {
        return "completed";
      }
      task.progress = 0;
      return "mistake";

    case "streamdeck-sequence":
      if (event.kind !== "streamdeck-key") {
        return "ignored";
      }
      switch (task.progress) {
        case 0:
          if (event.phase === "up") {
            return "ignored";
          }
          if (event.keyIndex === task.holdKeyIndex) {
            task.progress = 1;
            return "progress";
          }
          return "mistake";
        case 1:
          if (event.phase === "down" && event.keyIndex === task.tapKeyIndex) {
            task.progress = 2;
            return "progress";
          }
          if (event.phase === "up" && event.keyIndex !== task.holdKeyIndex) {
            return "ignored";
          }
          task.progress = 0;
          return "mistake";
        case 2:
          if (event.phase === "up" && event.keyIndex === task.holdKeyIndex) {
            return "completed";
          }
          if (event.phase === "up" && event.keyIndex === task.tapKeyIndex) {
            return "ignored";
          }
          task.progress = 0;
          return "mistake";
      }

    case "uf8-fader":
      if (event.kind !== "uf8-fader" || event.channel !== task.channel) {
        return "ignored";
      }
      if (Math.abs(event.value - task.target.value) <= task.tolerance) {
        task.withinSince ??= now;
      } else {
        task.withinSince = null;
      }
      return "progress";

    case "push-path": {
      if (event.kind !== "push-pad" || event.phase === "up") {
        return "ignored";
      }
      const expected = task.path[task.progress];
      if (
        expected !== undefined &&
        expected.x === event.point.x &&
        expected.y === event.point.y
      ) {
        task.progress += 1;
        return task.progress === task.path.length ? "completed" : "progress";
      }
      task.progress = 0;
      return "mistake";
    }

    case "push-defend":
      return "ignored";
  }
}

function applyInterstitialEvent(
  mission: MissionState,
  activity: InterstitialActivity,
  event: HardwareEvent,
  now: number,
  dependencies: MissionDependencies,
): MissionUpdate {
  const task = activity.task;
  if (task.station !== stationForEvent(event)) {
    return { outcomes: [] };
  }

  switch (task.kind) {
    case "streamdeck-hit":
      task.completed =
        event.kind === "streamdeck-key" &&
        event.phase === "down" &&
        event.keyIndex === task.keyIndex;
      break;
    case "uf8-bottom-out": {
      task.completed = event.kind === "uf8-fader";
      for (let channel = 0; channel < task.channelCount; channel += 1) {
        const value = mission.uf8Faders[channel];
        if (value === undefined || value > task.threshold) {
          task.completed = false;
          break;
        }
      }
      break;
    }
    case "push-corners":
      if (
        event.kind === "push-pad" &&
        event.phase === "down" &&
        isPushCorner(event.point, task.gridSize) &&
        !task.pressed.some((point) => samePoint(point, event.point))
      ) {
        task.pressed.push(event.point);
      }
      task.completed = task.pressed.length === 4;
      break;
  }

  if (!task.completed) {
    return { outcomes: [] };
  }
  mission.score += INTERSTITIAL_POINTS;
  return {
    outcomes: [
      {
        kind: "interstitial-completed",
        taskId: task.id,
        station: task.station,
        points: INTERSTITIAL_POINTS,
      },
      ...startNextLevel(mission, activity.nextLevel, now, dependencies),
    ],
  };
}

function updateReactorHold(
  mission: MissionState,
  activity: ReactorProcedureActivity,
  event: HardwareEvent,
  now: number,
): void {
  if (event.kind !== "uf8-fader") {
    return;
  }
  if (reactorTargetsAreSet(mission, activity)) {
    activity.procedure.withinSince ??= now;
  } else {
    activity.procedure.withinSince = null;
  }
}

function advanceOrders(
  mission: MissionState,
  activity: OrdersActivity,
  now: number,
  dependencies: MissionDependencies,
): MissionOutcome[] {
  const outcomes: MissionOutcome[] = [];
  for (let index = 0; index < activity.tasks.length; index += 1) {
    const task = activity.tasks[index];
    if (task === undefined) {
      throw new Error("Mission task array changed during tick");
    }

    if (
      task.kind === "uf8-fader" &&
      task.withinSince !== null &&
      now - task.withinSince >= task.holdMs
    ) {
      outcomes.push(
        ...completeTaskAt(
          mission,
          activity,
          index,
          now,
          dependencies,
        ).outcomes,
      );
      if (mission.activity !== activity) {
        break;
      }
      continue;
    }

    if (now >= task.deadlineAt) {
      if (task.kind === "push-defend") {
        outcomes.push(
          ...completeTaskAt(
            mission,
            activity,
            index,
            now,
            dependencies,
          ).outcomes,
        );
        if (mission.activity !== activity) {
          break;
        }
      } else {
        outcomes.push(
          expireTaskAt(mission, activity, index, now, dependencies),
        );
      }
    }
  }
  return outcomes;
}

function advanceInterstitial(
  mission: MissionState,
  activity: InterstitialActivity,
  now: number,
  dependencies: MissionDependencies,
): MissionOutcome[] {
  if (now < activity.endsAt) {
    return [];
  }
  mission.integrity = Math.max(0, mission.integrity - INTERSTITIAL_DAMAGE);
  return [
    {
      kind: "interstitial-expired",
      taskId: activity.task.id,
      station: activity.task.station,
    },
    ...startNextLevel(mission, activity.nextLevel, now, dependencies),
  ];
}

function advanceReactorProcedure(
  mission: MissionState,
  activity: ReactorProcedureActivity,
  now: number,
): MissionOutcome[] {
  const withinSince = activity.procedure.withinSince;
  if (
    withinSince !== null &&
    now - withinSince >= activity.procedure.holdMs
  ) {
    mission.score += REACTOR_PROCEDURE_POINTS;
    mission.integrity = Math.min(
      100,
      mission.integrity + REACTOR_PROCEDURE_REPAIR,
    );
    return [
      {
        kind: "procedure-completed",
        procedureId: activity.procedure.id,
        points: REACTOR_PROCEDURE_POINTS,
      },
      { kind: "mission-ended", reason: "survived" },
    ];
  }
  if (now < activity.endsAt) {
    return [];
  }
  mission.integrity = Math.max(
    0,
    mission.integrity - REACTOR_PROCEDURE_DAMAGE,
  );
  return [
    {
      kind: "procedure-expired",
      procedureId: activity.procedure.id,
    },
    {
      kind: "mission-ended",
      reason: mission.integrity <= 0 ? "integrity" : "survived",
    },
  ];
}

function completeTaskAt(
  mission: MissionState,
  activity: OrdersActivity,
  taskIndex: number,
  now: number,
  dependencies: MissionDependencies,
): MissionUpdate {
  const completed = activity.tasks[taskIndex];
  if (completed === undefined) {
    throw new Error("Cannot complete a missing task");
  }
  const points = 100 + mission.combo * 20;
  mission.score += points;
  mission.combo += 1;
  mission.integrity = Math.min(100, mission.integrity + COMPLETION_REPAIR);
  mission.levelObjectivesCompleted += 1;
  const outcomes: MissionOutcome[] = [
    {
      kind: "completed",
      taskId: completed.id,
      reader: completed.reader,
      target: stationForTask(completed),
      points,
    },
  ];

  const profile = missionLevelProfile(mission.level);
  if (mission.levelObjectivesCompleted >= profile.objectiveTarget) {
    outcomes.push({ kind: "level-completed", level: mission.level });
    mission.combo = 0;
    if (mission.level === 5) {
      if (mission.stations.some((station) => station === "uf8")) {
        mission.activity = createReactorProcedureActivity(
          mission,
          now,
          dependencies,
        );
        outcomes.push({
          kind: "activity-started",
          activity: "reactor-procedure",
        });
      } else {
        outcomes.push({ kind: "mission-ended", reason: "survived" });
      }
    } else {
      mission.activity = createInterstitialActivity(
        mission,
        now,
        dependencies,
      );
      outcomes.push({ kind: "activity-started", activity: "interstitial" });
    }
    return { outcomes };
  }

  activity.tasks[taskIndex] = createTaskForRoute(
    completed.reader,
    stationForTask(completed),
    now,
    dependencies,
    profile,
  );
  return { outcomes };
}

function expireTaskAt(
  mission: MissionState,
  activity: OrdersActivity,
  taskIndex: number,
  now: number,
  dependencies: MissionDependencies,
): MissionOutcome {
  const expired = activity.tasks[taskIndex];
  if (expired === undefined) {
    throw new Error("Cannot expire a missing task");
  }
  mission.integrity = Math.max(0, mission.integrity - EXPIRED_TASK_DAMAGE);
  mission.combo = 0;
  activity.tasks[taskIndex] = createTaskForRoute(
    expired.reader,
    stationForTask(expired),
    now,
    dependencies,
    missionLevelProfile(mission.level),
  );
  return {
    kind: "expired",
    taskId: expired.id,
    reader: expired.reader,
    target: stationForTask(expired),
  };
}

function startNextLevel(
  mission: MissionState,
  level: MissionLevel,
  now: number,
  dependencies: MissionDependencies,
): MissionOutcome[] {
  mission.level = level;
  mission.levelObjectivesCompleted = 0;
  mission.combo = 0;
  mission.activity = createOrdersActivity(
    mission.stations,
    now,
    dependencies,
    missionLevelProfile(level),
  );
  return [
    { kind: "level-started", level },
    { kind: "activity-started", activity: "orders" },
  ];
}

function reactorTargetsAreSet(
  mission: MissionState,
  activity: ReactorProcedureActivity,
): boolean {
  return activity.procedure.profile.targets.every(
    (target) =>
      Math.abs(mission.uf8Faders[target.channel] - target.stop.value) <=
      activity.procedure.tolerance,
  );
}

function readerForTarget(
  stations: MissionStations,
  target: Station,
): Station {
  for (let index = 0; index < stations.length; index += 1) {
    if (stations[(index + 1) % stations.length] === target) {
      const reader = stations[index];
      if (reader === undefined) {
        throw new Error("Procedure reader route is missing");
      }
      return reader;
    }
  }
  throw new Error(`No reader routes to ${target}`);
}

function isEventActive(
  profile: MissionLevelProfile,
  event: HardwareEvent,
): boolean {
  switch (event.kind) {
    case "streamdeck-key":
      return isActiveStreamDeckKey(profile, event.keyIndex);
    case "uf8-fader":
      return isActiveUf8Channel(profile, event.channel);
    case "push-pad":
      return isActivePushPoint(profile, event.point);
    case "push-defend-failed":
      return profile.pushDefendChance > 0;
  }
}

function stationForEvent(event: HardwareEvent): Station {
  switch (event.kind) {
    case "streamdeck-key":
      return "streamdeck";
    case "uf8-fader":
      return "uf8";
    case "push-pad":
    case "push-defend-failed":
      return "push";
  }
}

function isPushCorner(point: GridPoint, gridSize: number): boolean {
  const farEdge = gridSize - 1;
  return (
    (point.x === 0 || point.x === farEdge) &&
    (point.y === 0 || point.y === farEdge)
  );
}

function samePoint(left: GridPoint, right: GridPoint): boolean {
  return left.x === right.x && left.y === right.y;
}

function nextMissionLevel(level: MissionLevel): MissionLevel {
  switch (level) {
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 4;
    case 4:
      return 5;
    case 5:
      throw new Error("Final level has no interstitial successor");
  }
}

function copyUf8Faders(values: Uf8FaderValues): Uf8FaderValues {
  return [
    values[0],
    values[1],
    values[2],
    values[3],
    values[4],
    values[5],
    values[6],
    values[7],
  ];
}

function randomInteger(
  random: () => number,
  minimum: number,
  maximum: number,
): number {
  return Math.floor(random() * (maximum - minimum + 1)) + minimum;
}

function assertUniqueStations(stations: MissionStations): void {
  if (
    stations[0] === stations[1] ||
    (stations.length === 3 &&
      (stations[0] === stations[2] || stations[1] === stations[2]))
  ) {
    throw new Error("Mission stations must be unique");
  }
}
