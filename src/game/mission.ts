import type {
  ActiveTask,
  GridPoint,
  HardwareEvent,
  MissionOutcome,
  MissionState,
  MissionStations,
  MissionUpdate,
  PushPathColor,
  Station,
  StreamDeckKey,
  StreamDeckKeyColor,
} from "../shared/domain.ts";
import { STATIONS, stationForTask } from "../shared/domain.ts";

const MISSION_DURATION_MS = 90_000;
const TASK_DURATION_MS = 13_000;
const WRONG_ACTION_DAMAGE = 3;
const EXPIRED_TASK_DAMAGE = 12;
const COMPLETION_REPAIR = 2;
const UF8_HOLD_MS = 450;

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

const UF8_LABELS = [
  "HULL SHEAR",
  "ION BIAS",
  "CORE PRESSURE",
  "DRIFT",
  "COOLANT",
  "GRAVITY",
  "PHASE LOAD",
  "RESONANCE",
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
): MissionState {
  assertUniqueStations(stations);
  const streamDeckKeys = createStreamDeckLayout();
  const mission: MissionState = {
    startedAt: now,
    endsAt: now + MISSION_DURATION_MS,
    stations,
    score: 0,
    integrity: 100,
    combo: 0,
    tasks: [],
    streamDeckKeys,
  };

  for (let index = 0; index < stations.length; index += 1) {
    const reader = stations[index];
    const target = stations[(index + 1) % stations.length];
    if (reader === undefined || target === undefined) {
      throw new Error("Mission route is missing a station");
    }
    mission.tasks.push(createTaskForRoute(reader, target, now, dependencies));
  }

  return mission;
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
  if (mission.integrity <= 0 || now >= mission.endsAt) {
    return { outcomes: [] };
  }

  const taskIndex = mission.tasks.findIndex(
    (task) => stationForTask(task) === stationForEvent(event),
  );
  const task = mission.tasks[taskIndex];
  if (task === undefined) {
    return { outcomes: [] };
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
      return completeTaskAt(mission, taskIndex, now, dependencies);
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

  const outcomes: MissionOutcome[] = [];
  for (let index = 0; index < mission.tasks.length; index += 1) {
    const task = mission.tasks[index];
    if (task === undefined) {
      throw new Error("Mission task array changed during tick");
    }

    if (
      task.kind === "uf8-fader" &&
      task.withinSince !== null &&
      now - task.withinSince >= task.holdMs
    ) {
      outcomes.push(
        ...completeTaskAt(mission, index, now, dependencies).outcomes,
      );
      continue;
    }

    if (now >= task.deadlineAt) {
      outcomes.push(expireTaskAt(mission, index, now, dependencies));
    }
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

function createTaskForRoute(
  reader: Station,
  target: Station,
  now: number,
  dependencies: MissionDependencies,
): ActiveTask {
  switch (target) {
    case "streamdeck":
      return createStreamDeckTask(reader, now, dependencies);
    case "uf8":
      return createUf8Task(reader, now, dependencies);
    case "push":
      return createPushTask(reader, now, dependencies);
  }
}

function createStreamDeckTask(
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

function createUf8Task(
  reader: Station,
  now: number,
  dependencies: MissionDependencies,
): ActiveTask {
  const channel = randomInteger(dependencies.random, 0, 7);
  const label = UF8_LABELS[channel];
  if (label === undefined) {
    throw new Error("UF8 channel has no system label");
  }
  return {
    kind: "uf8-fader",
    id: dependencies.makeId(),
    reader,
    createdAt: now,
    deadlineAt: now + TASK_DURATION_MS,
    channel,
    label,
    target: randomInteger(dependencies.random, 2, 18) * 5,
    tolerance: 3,
    holdMs: UF8_HOLD_MS,
    withinSince: null,
  };
}

function createPushTask(
  reader: Station,
  now: number,
  dependencies: MissionDependencies,
): ActiveTask {
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

    case "uf8-fader":
      if (event.kind !== "uf8-fader" || event.channel !== task.channel) {
        return "ignored";
      }
      if (Math.abs(event.value - task.target) <= task.tolerance) {
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
  }
}

function stationForEvent(event: HardwareEvent): Station {
  switch (event.kind) {
    case "streamdeck-key":
      return "streamdeck";
    case "uf8-fader":
      return "uf8";
    case "push-pad":
      return "push";
  }
}

function completeTaskAt(
  mission: MissionState,
  taskIndex: number,
  now: number,
  dependencies: MissionDependencies,
): MissionUpdate {
  const completed = mission.tasks[taskIndex];
  if (completed === undefined) {
    throw new Error("Cannot complete a missing task");
  }
  const points = 100 + mission.combo * 20;
  mission.score += points;
  mission.combo += 1;
  mission.integrity = Math.min(100, mission.integrity + COMPLETION_REPAIR);
  mission.tasks[taskIndex] = createTaskForRoute(
    completed.reader,
    stationForTask(completed),
    now,
    dependencies,
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
  taskIndex: number,
  now: number,
  dependencies: MissionDependencies,
): MissionOutcome {
  const expired = mission.tasks[taskIndex];
  if (expired === undefined) {
    throw new Error("Cannot expire a missing task");
  }
  mission.integrity = Math.max(0, mission.integrity - EXPIRED_TASK_DAMAGE);
  mission.combo = 0;
  mission.tasks[taskIndex] = createTaskForRoute(
    expired.reader,
    stationForTask(expired),
    now,
    dependencies,
  );
  return {
    kind: "expired",
    taskId: expired.id,
    reader: expired.reader,
    target: stationForTask(expired),
  };
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
