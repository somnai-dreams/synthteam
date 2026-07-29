import type {
  ActiveTask,
  GridPoint,
  HardwareEvent,
  LocalOverrideTask,
  LocalOverridesActivity,
  MissionOutcome,
  MissionState,
  MissionStations,
  MissionUpdate,
  OrdersActivity,
  OrdersBeat,
  PushPathColor,
  ReactorProcedureActivity,
  Station,
  StreamDeckKey,
  StreamDeckKeyColor,
  Uf8FaderValues,
} from "../shared/domain.ts";
import {
  REACTOR_PROFILES,
  STATIONS,
  stationForTask,
  UF8_CONTROL_LABELS,
  UF8_FADER_STOPS,
} from "../shared/domain.ts";

const MISSION_DURATION_MS = 90_000;
const ORDER_BLOCK_DURATION_MS = 18_000;
const LOCAL_OVERRIDE_DURATION_MS = 6_000;
const REACTOR_PROCEDURE_DURATION_MS = 20_000;
const TASK_DURATION_MS = 13_000;
const WRONG_ACTION_DAMAGE = 3;
const EXPIRED_TASK_DAMAGE = 12;
const LOCAL_OVERRIDE_DAMAGE = 3;
const REACTOR_PROCEDURE_DAMAGE = 18;
const COMPLETION_REPAIR = 2;
const REACTOR_PROCEDURE_REPAIR = 8;
const LOCAL_OVERRIDE_POINTS = 50;
const REACTOR_PROCEDURE_POINTS = 500;
const UF8_HOLD_MS = 450;
const REACTOR_HOLD_MS = 650;
const UF8_BOTTOM_THRESHOLD = 5;

// Push defend activity: chance of rolling it instead of a path task,
// and how its missile parameters scale as the mission progresses
// (difficulty 0 at mission start, 1 at mission end).
const PUSH_DEFEND_CHANCE = 0.35;
const PUSH_DEFEND_HULL = 8;
const PUSH_DEFEND_SPEED_BASE = 1.4; // pads per second
const PUSH_DEFEND_SPEED_RAMP = 1.8;
const PUSH_DEFEND_SPAWN_BASE_MS = 1300;
const PUSH_DEFEND_SPAWN_RAMP_MS = 750;

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

const PUSH_CORNERS: readonly GridPoint[] = [
  { x: 0, y: 0 },
  { x: 7, y: 0 },
  { x: 0, y: 7 },
  { x: 7, y: 7 },
];

const DEFAULT_UF8_FADERS: Uf8FaderValues = [0, 0, 0, 0, 0, 0, 0, 0];

export type MissionDependencies = {
  random: () => number;
  makeId: () => string;
};

export function createMission(
  now: number,
  stations: MissionStations = STATIONS,
  dependencies: MissionDependencies = {
    random: Math.random,
    makeId: () => crypto.randomUUID(),
  },
  initialUf8Faders: Uf8FaderValues = DEFAULT_UF8_FADERS,
): MissionState {
  assertUniqueStations(stations);
  const endsAt = now + MISSION_DURATION_MS;
  return {
    startedAt: now,
    endsAt,
    stations,
    score: 0,
    integrity: 100,
    combo: 0,
    streamDeckKeys: createStreamDeckLayout(),
    uf8Faders: copyUf8Faders(initialUf8Faders),
    activity: createOrdersActivity(
      stations,
      "opening",
      now,
      now + ORDER_BLOCK_DURATION_MS,
      dependencies,
    ),
  };
}

export function applyHardwareEvent(
  mission: MissionState,
  event: HardwareEvent,
  now: number,
  dependencies: MissionDependencies = {
    random: Math.random,
    makeId: () => crypto.randomUUID(),
  },
): MissionUpdate {
  if (
    mission.integrity <= 0 ||
    now >= mission.endsAt ||
    !mission.stations.some((station) => station === stationForEvent(event))
  ) {
    return { outcomes: [] };
  }

  if (event.kind === "uf8-fader") {
    mission.uf8Faders[event.channel] = event.value;
  }

  switch (mission.activity.kind) {
    case "orders":
      return applyOrderEvent(mission, mission.activity, event, now, dependencies);
    case "local-overrides":
      return applyLocalOverrideEvent(
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
  dependencies: MissionDependencies = {
    random: Math.random,
    makeId: () => crypto.randomUUID(),
  },
): MissionUpdate {
  if (mission.integrity <= 0) {
    return {
      outcomes: [{ kind: "mission-ended", reason: "integrity" }],
    };
  }
  if (now >= mission.endsAt) {
    return {
      outcomes: [{ kind: "mission-ended", reason: "survived" }],
    };
  }

  let outcomes: MissionOutcome[];
  switch (mission.activity.kind) {
    case "orders":
      outcomes = advanceOrders(mission, mission.activity, now, dependencies);
      break;
    case "local-overrides":
      outcomes = advanceLocalOverrides(
        mission,
        mission.activity,
        now,
        dependencies,
      );
      break;
    case "reactor-procedure":
      outcomes = advanceReactorProcedure(
        mission,
        mission.activity,
        now,
        dependencies,
      );
      break;
  }

  if (mission.integrity <= 0) {
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
  beat: OrdersBeat,
  now: number,
  endsAt: number,
  dependencies: MissionDependencies,
): OrdersActivity {
  const tasks: ActiveTask[] = [];
  for (let index = 0; index < stations.length; index += 1) {
    const reader = stations[index];
    const target = stations[(index + 1) % stations.length];
    if (reader === undefined || target === undefined) {
      throw new Error("Mission route is missing a station");
    }
    tasks.push(createTaskForRoute(reader, target, now, dependencies));
  }
  return { kind: "orders", beat, startedAt: now, endsAt, tasks };
}

function createLocalOverridesActivity(
  mission: MissionState,
  now: number,
  dependencies: MissionDependencies,
): LocalOverridesActivity {
  const deadlineAt = now + LOCAL_OVERRIDE_DURATION_MS;
  const tasks: LocalOverrideTask[] = [];
  for (const station of mission.stations) {
    switch (station) {
      case "streamdeck":
        tasks.push({
          kind: "streamdeck-hit",
          station,
          id: dependencies.makeId(),
          startedAt: now,
          deadlineAt,
          completed: false,
          keyIndex: randomInteger(dependencies.random, 0, 31),
        });
        break;
      case "uf8":
        tasks.push({
          kind: "uf8-bottom-out",
          station,
          id: dependencies.makeId(),
          startedAt: now,
          deadlineAt,
          completed: false,
          threshold: UF8_BOTTOM_THRESHOLD,
        });
        break;
      case "push":
        tasks.push({
          kind: "push-corners",
          station,
          id: dependencies.makeId(),
          startedAt: now,
          deadlineAt,
          completed: false,
          pressed: [],
        });
        break;
    }
  }
  return {
    kind: "local-overrides",
    startedAt: now,
    endsAt: deadlineAt,
    tasks,
  };
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
  difficulty = 0,
): ActiveTask {
  switch (target) {
    case "streamdeck":
      return dependencies.random() < 0.5
        ? createStreamDeckSequenceTask(reader, now, dependencies)
        : createStreamDeckRouteTask(reader, now, dependencies);
    case "uf8":
      return createUf8Task(reader, now, dependencies);
    case "push":
      return createPushTask(reader, now, dependencies, difficulty);
  }
}

function missionDifficulty(mission: MissionState, now: number): number {
  const elapsed = (now - mission.startedAt) / MISSION_DURATION_MS;
  return Math.min(1, Math.max(0, elapsed));
}

function createStreamDeckRouteTask(
  reader: Station,
  now: number,
  dependencies: MissionDependencies,
): ActiveTask {
  const sourceKeyIndex = randomInteger(dependencies.random, 0, 31);
  const offset = randomInteger(dependencies.random, 1, 31);
  return {
    kind: "streamdeck-route",
    id: dependencies.makeId(),
    reader,
    createdAt: now,
    deadlineAt: now + TASK_DURATION_MS,
    sourceKeyIndex,
    targetKeyIndex: (sourceKeyIndex + offset) % 32,
    progress: 0,
  };
}

function createStreamDeckSequenceTask(
  reader: Station,
  now: number,
  dependencies: MissionDependencies,
): ActiveTask {
  const holdKeyIndex = randomInteger(dependencies.random, 0, 31);
  const offset = randomInteger(dependencies.random, 1, 31);
  return {
    kind: "streamdeck-sequence",
    id: dependencies.makeId(),
    reader,
    createdAt: now,
    deadlineAt: now + TASK_DURATION_MS,
    holdKeyIndex,
    tapKeyIndex: (holdKeyIndex + offset) % 32,
    progress: 0,
  };
}

function createUf8Task(
  reader: Station,
  now: number,
  dependencies: MissionDependencies,
): ActiveTask {
  const channel = randomInteger(dependencies.random, 0, 7);
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
    deadlineAt: now + TASK_DURATION_MS,
    channel,
    label,
    target,
    tolerance: 3,
    holdMs: UF8_HOLD_MS,
    withinSince: null,
  };
}

function createPushTask(
  reader: Station,
  now: number,
  dependencies: MissionDependencies,
  difficulty: number,
): ActiveTask {
  if (dependencies.random() > 1 - PUSH_DEFEND_CHANCE) {
    return {
      kind: "push-defend",
      id: dependencies.makeId(),
      reader,
      createdAt: now,
      deadlineAt: now + TASK_DURATION_MS, // survive until here to pass
      missileSpeed:
        Math.round(
          (PUSH_DEFEND_SPEED_BASE + PUSH_DEFEND_SPEED_RAMP * difficulty) * 100,
        ) / 100,
      spawnIntervalMs: Math.round(
        PUSH_DEFEND_SPAWN_BASE_MS - PUSH_DEFEND_SPAWN_RAMP_MS * difficulty,
      ),
      hull: PUSH_DEFEND_HULL,
    };
  }
  return {
    kind: "push-path",
    id: dependencies.makeId(),
    reader,
    createdAt: now,
    deadlineAt: now + TASK_DURATION_MS,
    color:
      PUSH_COLORS[randomInteger(dependencies.random, 0, PUSH_COLORS.length - 1)] ??
      "violet",
    path: createPushPath(dependencies.random),
    progress: 0,
  };
}

function createPushPath(random: () => number): readonly GridPoint[] {
  const start = {
    x: randomInteger(random, 1, 6),
    y: randomInteger(random, 1, 6),
  };
  const directions: readonly GridPoint[] = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];
  const path: GridPoint[] = [start];

  while (path.length < 4) {
    const previous = path[path.length - 1];
    if (previous === undefined) {
      throw new Error("Push path lost its starting point");
    }
    const firstDirection = randomInteger(random, 0, directions.length - 1);
    let advanced = false;
    for (let offset = 0; offset < directions.length; offset += 1) {
      const direction = directions[(firstDirection + offset) % directions.length];
      if (direction === undefined) {
        throw new Error("Push path direction is missing");
      }
      const next = {
        x: previous.x + direction.x,
        y: previous.y + direction.y,
      };
      const insideGrid =
        next.x >= 0 && next.x <= 7 && next.y >= 0 && next.y <= 7;
      const alreadyUsed = path.some(
        (point) => point.x === next.x && point.y === next.y,
      );
      if (insideGrid && !alreadyUsed) {
        path.push(next);
        advanced = true;
        break;
      }
    }
    if (!advanced) {
      throw new Error("Push path could not advance");
    }
  }
  return path;
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
          if (
            event.phase === "down" &&
            event.keyIndex === task.tapKeyIndex
          ) {
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
      // Pads are handled locally by the bridge during the defend
      // activity; only push-defend-failed matters, handled upstream.
      return "ignored";
  }
}

function applyLocalOverrideEvent(
  mission: MissionState,
  activity: LocalOverridesActivity,
  event: HardwareEvent,
  now: number,
  dependencies: MissionDependencies,
): MissionUpdate {
  const station = stationForEvent(event);
  const task = activity.tasks.find(
    (candidate) => candidate.station === station,
  );
  if (task === undefined || task.completed) {
    return { outcomes: [] };
  }

  switch (task.kind) {
    case "streamdeck-hit":
      task.completed =
        event.kind === "streamdeck-key" &&
        event.phase === "down" &&
        event.keyIndex === task.keyIndex;
      break;
    case "uf8-bottom-out":
      task.completed =
        event.kind === "uf8-fader" &&
        mission.uf8Faders.every((value) => value <= task.threshold);
      break;
    case "push-corners":
      if (
        event.kind === "push-pad" &&
        event.phase === "down" &&
        isPushCorner(event.point) &&
        !task.pressed.some((point) => samePoint(point, event.point))
      ) {
        task.pressed.push(event.point);
      }
      task.completed = task.pressed.length === PUSH_CORNERS.length;
      break;
  }

  if (!task.completed) {
    return { outcomes: [] };
  }
  mission.score += LOCAL_OVERRIDE_POINTS;
  const outcomes: MissionOutcome[] = [
    {
      kind: "local-override-completed",
      taskId: task.id,
      station,
      points: LOCAL_OVERRIDE_POINTS,
    },
  ];
  if (activity.tasks.every((candidate) => candidate.completed)) {
    mission.activity = createOrdersActivity(
      mission.stations,
      "pressure",
      now,
      now + ORDER_BLOCK_DURATION_MS,
      dependencies,
    );
    mission.combo = 0;
    outcomes.push({ kind: "activity-started", activity: "orders" });
  }
  return { outcomes };
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
  if (now >= activity.endsAt) {
    switch (activity.beat) {
      case "opening":
        mission.activity = createLocalOverridesActivity(
          mission,
          now,
          dependencies,
        );
        mission.combo = 0;
        return [
          { kind: "activity-started", activity: "local-overrides" },
        ];
      case "pressure":
        if (mission.stations.some((station) => station === "uf8")) {
          mission.activity = createReactorProcedureActivity(
            mission,
            now,
            dependencies,
          );
          mission.combo = 0;
          return [
            { kind: "activity-started", activity: "reactor-procedure" },
          ];
        }
        mission.activity = createOrdersActivity(
          mission.stations,
          "final",
          now,
          mission.endsAt,
          dependencies,
        );
        return [{ kind: "activity-started", activity: "orders" }];
      case "final":
        return [];
    }
  }

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
      } else {
        outcomes.push(
          expireTaskAt(mission, activity, index, now, dependencies),
        );
      }
    }
  }
  return outcomes;
}

function advanceLocalOverrides(
  mission: MissionState,
  activity: LocalOverridesActivity,
  now: number,
  dependencies: MissionDependencies,
): MissionOutcome[] {
  if (now < activity.endsAt) {
    return [];
  }
  const outcomes: MissionOutcome[] = [];
  for (const task of activity.tasks) {
    if (task.completed) {
      continue;
    }
    mission.integrity = Math.max(
      0,
      mission.integrity - LOCAL_OVERRIDE_DAMAGE,
    );
    outcomes.push({
      kind: "local-override-expired",
      taskId: task.id,
      station: task.station,
    });
  }
  mission.activity = createOrdersActivity(
    mission.stations,
    "pressure",
    now,
    now + ORDER_BLOCK_DURATION_MS,
    dependencies,
  );
  mission.combo = 0;
  outcomes.push({ kind: "activity-started", activity: "orders" });
  return outcomes;
}

function advanceReactorProcedure(
  mission: MissionState,
  activity: ReactorProcedureActivity,
  now: number,
  dependencies: MissionDependencies,
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
    mission.activity = createOrdersActivity(
      mission.stations,
      "final",
      now,
      mission.endsAt,
      dependencies,
    );
    return [
      {
        kind: "procedure-completed",
        procedureId: activity.procedure.id,
        points: REACTOR_PROCEDURE_POINTS,
      },
      { kind: "activity-started", activity: "orders" },
    ];
  }
  if (now < activity.endsAt) {
    return [];
  }
  mission.integrity = Math.max(
    0,
    mission.integrity - REACTOR_PROCEDURE_DAMAGE,
  );
  mission.activity = createOrdersActivity(
    mission.stations,
    "final",
    now,
    mission.endsAt,
    dependencies,
  );
  return [
    {
      kind: "procedure-expired",
      procedureId: activity.procedure.id,
    },
    { kind: "activity-started", activity: "orders" },
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
  activity.tasks[taskIndex] = createTaskForRoute(
    completed.reader,
    stationForTask(completed),
    now,
    dependencies,
    missionDifficulty(mission, now),
  );
  return {
    outcomes: [
      {
        kind: "completed",
        taskId: completed.id,
        reader: completed.reader,
        target: stationForTask(completed),
        points,
      },
    ],
  };
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
    missionDifficulty(mission, now),
  );
  return {
    kind: "expired",
    taskId: expired.id,
    reader: expired.reader,
    target: stationForTask(expired),
  };
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

function isPushCorner(point: GridPoint): boolean {
  return PUSH_CORNERS.some((corner) => samePoint(corner, point));
}

function samePoint(left: GridPoint, right: GridPoint): boolean {
  return left.x === right.x && left.y === right.y;
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

function randomInteger(random: () => number, minimum: number, maximum: number) {
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
