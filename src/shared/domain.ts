export const STATIONS = ["streamdeck", "uf8", "push"] as const;

export type Station = (typeof STATIONS)[number];

export type MissionStations =
  | readonly [Station, Station]
  | readonly [Station, Station, Station];

export const MISSION_LEVELS = [1, 2, 3, 4, 5] as const;

export type MissionLevel = (typeof MISSION_LEVELS)[number];

export type MissionLevelProfile = {
  level: MissionLevel;
  objectiveTarget: number;
  streamDeckColumns: number;
  uf8Channels: number;
  pushGridSize: number;
  streamDeckSequenceChance: number;
  pushDefendChance: number;
  pushConsoleChance: number;
  pushCowChance: number;
  pushReviewChance: number;
  pushPathLength: number;
  taskDurationMs: number;
  uf8Tolerance: number;
  uf8HoldMs: number;
  pushDefendSpeed: number;
  pushDefendSpawnIntervalMs: number;
};

export const MISSION_LEVEL_PROFILES = [
  {
    level: 1,
    objectiveTarget: 3,
    streamDeckColumns: 2,
    uf8Channels: 2,
    pushGridSize: 3,
    streamDeckSequenceChance: 0,
    pushDefendChance: 0,
    pushConsoleChance: 0.0,
    pushCowChance: 0.0,
    pushReviewChance: 0.0,
    pushPathLength: 3,
    taskDurationMs: 15_000,
    uf8Tolerance: 4,
    uf8HoldMs: 350,
    pushDefendSpeed: 1.4,
    pushDefendSpawnIntervalMs: 1_300,
  },
  {
    level: 2,
    objectiveTarget: 4,
    streamDeckColumns: 3,
    uf8Channels: 3,
    pushGridSize: 4,
    streamDeckSequenceChance: 0.25,
    pushDefendChance: 0,
    pushConsoleChance: 0.25,
    pushCowChance: 0.1,
    pushReviewChance: 0.1,
    pushPathLength: 3,
    taskDurationMs: 14_000,
    uf8Tolerance: 4,
    uf8HoldMs: 400,
    pushDefendSpeed: 1.4,
    pushDefendSpawnIntervalMs: 1_300,
  },
  {
    level: 3,
    objectiveTarget: 5,
    streamDeckColumns: 4,
    uf8Channels: 4,
    pushGridSize: 6,
    streamDeckSequenceChance: 0.4,
    pushDefendChance: 0,
    pushConsoleChance: 0.25,
    pushCowChance: 0.1,
    pushReviewChance: 0.1,
    pushPathLength: 4,
    taskDurationMs: 13_000,
    uf8Tolerance: 3,
    uf8HoldMs: 450,
    pushDefendSpeed: 1.4,
    pushDefendSpawnIntervalMs: 1_300,
  },
  {
    level: 4,
    objectiveTarget: 6,
    streamDeckColumns: 6,
    uf8Channels: 6,
    pushGridSize: 8,
    streamDeckSequenceChance: 0.5,
    pushDefendChance: 0.2,
    pushConsoleChance: 0.2,
    pushCowChance: 0.1,
    pushReviewChance: 0.1,
    pushPathLength: 5,
    taskDurationMs: 12_000,
    uf8Tolerance: 3,
    uf8HoldMs: 500,
    pushDefendSpeed: 2.4,
    pushDefendSpawnIntervalMs: 900,
  },
  {
    level: 5,
    objectiveTarget: 8,
    streamDeckColumns: 8,
    uf8Channels: 8,
    pushGridSize: 8,
    streamDeckSequenceChance: 0.6,
    pushDefendChance: 0.35,
    pushConsoleChance: 0.2,
    pushCowChance: 0.05,
    pushReviewChance: 0.05,
    pushPathLength: 6,
    taskDurationMs: 11_000,
    uf8Tolerance: 2,
    uf8HoldMs: 600,
    pushDefendSpeed: 3.2,
    pushDefendSpawnIntervalMs: 550,
  },
] as const satisfies readonly MissionLevelProfile[];

export function missionLevelProfile(level: MissionLevel): MissionLevelProfile {
  const profile = MISSION_LEVEL_PROFILES[level - 1];
  if (profile === undefined || profile.level !== level) {
    throw new Error(`Mission level ${level} has no difficulty profile`);
  }
  return profile;
}

export function isActiveStreamDeckKey(
  profile: MissionLevelProfile,
  keyIndex: number,
): boolean {
  return keyIndex >= 0 && keyIndex < 32 && keyIndex % 8 < profile.streamDeckColumns;
}

export function isActiveUf8Channel(
  profile: MissionLevelProfile,
  channel: number,
): boolean {
  return channel >= 0 && channel < profile.uf8Channels;
}

export function isActivePushPoint(
  profile: MissionLevelProfile,
  point: GridPoint,
): boolean {
  return (
    point.x >= 0 &&
    point.x < profile.pushGridSize &&
    point.y >= 0 &&
    point.y < profile.pushGridSize
  );
}

export type CrewConnection =
  | { kind: "connected" }
  | { kind: "reserved"; endsAt: number };

export type CrewMember = {
  id: string;
  name: string;
  station: Station;
  connection: CrewConnection;
};

export type CrewSlots = Record<Station, CrewMember | null>;

export type Uf8ConnectionState =
  | {
      kind: "disconnected";
      message: string;
    }
  | {
      kind: "connected";
      serial: string;
    };

export const UF8_CONTROL_LABELS = [
  "HULL SHEAR",
  "ION BIAS",
  "CORE PRESSURE",
  "DRIFT",
  "COOLANT",
  "GRAVITY",
  "PHASE LOAD",
  "RESONANCE",
] as const;

export const UF8_ZERO_FADER_STOP = { label: "0 DB", value: 75 } as const;

export const UF8_FADER_STOPS = [
  { label: "+12 DB", value: 100 },
  { label: "+6 DB", value: 86 },
  UF8_ZERO_FADER_STOP,
  { label: "-5 DB", value: 67 },
  { label: "-10 DB", value: 58 },
  { label: "-20 DB", value: 44 },
  { label: "-30 DB", value: 32 },
  { label: "-40 DB", value: 22 },
  { label: "-60 DB", value: 10 },
  { label: "-INF", value: 0 },
] as const;

export type Uf8FaderStop = (typeof UF8_FADER_STOPS)[number];

export type Uf8FaderValues = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const REACTOR_PROFILES = [
  {
    code: "ALPHA",
    targets: [
      { channel: 4, label: "COOLANT", stop: UF8_FADER_STOPS[5] },
      { channel: 3, label: "DRIFT", stop: UF8_FADER_STOPS[7] },
    ],
  },
  {
    code: "BETA",
    targets: [
      { channel: 4, label: "COOLANT", stop: UF8_FADER_STOPS[4] },
      { channel: 3, label: "DRIFT", stop: UF8_FADER_STOPS[6] },
    ],
  },
  {
    code: "GAMMA",
    targets: [
      { channel: 4, label: "COOLANT", stop: UF8_FADER_STOPS[6] },
      { channel: 3, label: "DRIFT", stop: UF8_FADER_STOPS[3] },
    ],
  },
  {
    code: "DELTA",
    targets: [
      { channel: 4, label: "COOLANT", stop: UF8_FADER_STOPS[7] },
      { channel: 3, label: "DRIFT", stop: UF8_ZERO_FADER_STOP },
    ],
  },
] as const;

export type ReactorProfile = (typeof REACTOR_PROFILES)[number];

export type StreamDeckKeyColor = "cyan" | "amber" | "magenta" | "green";

export type StreamDeckKey = {
  index: number;
  label: string;
  color: StreamDeckKeyColor;
};

export type GridPoint = {
  x: number;
  y: number;
};

export type PushPathColor = "violet" | "cyan" | "amber" | "lime";

type TaskBase = {
  id: string;
  reader: Station;
  createdAt: number;
  deadlineAt: number;
};

export type StreamDeckRouteTask = TaskBase & {
  kind: "streamdeck-route";
  sourceKeyIndex: number;
  targetKeyIndex: number;
  progress: 0 | 1;
};

export type StreamDeckSequenceTask = TaskBase & {
  kind: "streamdeck-sequence";
  holdKeyIndex: number;
  tapKeyIndex: number;
  progress: 0 | 1 | 2;
};

export type Uf8FaderTask = TaskBase & {
  kind: "uf8-fader";
  channel: number;
  label: string;
  target: Uf8FaderStop;
  tolerance: number;
  holdMs: number;
  withinSince: number | null;
};

export type PushPathTask = TaskBase & {
  kind: "push-path";
  color: PushPathColor;
  path: readonly GridPoint[];
  progress: number;
};

export type PushDefendTask = TaskBase & {
  kind: "push-defend";
  missileSpeed: number; // pads per second
  spawnIntervalMs: number;
  hull: number; // segments the bridge starts with
};

/**
 * The verb of a console order is a real labelled button on the Push
 * (QUANTIZE, MUTE, DUPLICATE, ...). Scale orders use the SCALES
 * button plus the big dial.
 */
export type PushConsoleAction =
  | { kind: "press"; verb: string; verbCc: number }
  | { kind: "scale"; value: number };

export type PushConsoleTask = TaskBase & {
  kind: "push-console";
  /** 16 labels: 0-7 above the display, 8-15 below it. */
  labels: readonly string[];
  targetIndex: number;
  action: PushConsoleAction;
  verbDone: boolean;
  labelDone: boolean;
  /** Big-dial counter while a scale order is dialing (starts at 0). */
  value: number;
};

/**
 * A snap judgement: the Push screen announces "<subject> <verb>!"
 * (e.g. WORMHOLE DELETED) and the shouted order says whether to
 * UNDO it or SAVE it — pressed on the Push's real Undo/Save buttons.
 */
export type PushReviewTask = TaskBase & {
  kind: "push-review";
  subject: string;
  verb: string; // past tense: DELETED, SCRAMBLED, ...
  decision: "undo" | "save";
};

/**
 * Tractor-beam duty: something is caught in the beam. The phone order
 * says whether to ABDUCT it (slide the touch strip up) or RELEASE it
 * (slide down). What's in the beam stays hidden until it moves.
 */
export type PushCowTask = TaskBase & {
  kind: "push-cow";
  action: "abduct" | "release";
};

export type ActivePushTask =
  | PushPathTask
  | PushDefendTask
  | PushConsoleTask
  | PushReviewTask
  | PushCowTask;

export type ActiveTask =
  | StreamDeckRouteTask
  | StreamDeckSequenceTask
  | Uf8FaderTask
  | PushPathTask
  | PushDefendTask
  | PushConsoleTask
  | PushReviewTask
  | PushCowTask;

export type OrdersActivity = {
  kind: "orders";
  startedAt: number;
  tasks: ActiveTask[];
};

type InterstitialTaskBase = {
  id: string;
  startedAt: number;
  deadlineAt: number;
  completed: boolean;
};

export type StreamDeckHitInterstitial = InterstitialTaskBase & {
  kind: "streamdeck-hit";
  station: "streamdeck";
  keyIndex: number;
};

export type Uf8BottomOutInterstitial = InterstitialTaskBase & {
  kind: "uf8-bottom-out";
  station: "uf8";
  channelCount: number;
  threshold: number;
};

export type PushCornersInterstitial = InterstitialTaskBase & {
  kind: "push-corners";
  station: "push";
  gridSize: number;
  pressed: GridPoint[];
};

export type InterstitialTask =
  | StreamDeckHitInterstitial
  | Uf8BottomOutInterstitial
  | PushCornersInterstitial;

export type InterstitialActivity = {
  kind: "interstitial";
  startedAt: number;
  endsAt: number;
  completedLevel: MissionLevel;
  nextLevel: MissionLevel;
  task: InterstitialTask;
};

export type ReactorProcedure = {
  id: string;
  reader: Station;
  createdAt: number;
  deadlineAt: number;
  profile: ReactorProfile;
  tolerance: number;
  holdMs: number;
  withinSince: number | null;
};

export type ReactorProcedureActivity = {
  kind: "reactor-procedure";
  startedAt: number;
  endsAt: number;
  procedure: ReactorProcedure;
};

export type MissionActivity =
  | OrdersActivity
  | InterstitialActivity
  | ReactorProcedureActivity;

export type StreamDeckHardwareEvent = {
  kind: "streamdeck-key";
  keyIndex: number;
  phase: "down" | "up";
};

export type Uf8HardwareEvent = {
  kind: "uf8-fader";
  channel: number;
  value: number;
};

export type PushHardwareEvent = {
  kind: "push-pad";
  point: GridPoint;
  phase: "down" | "up";
  velocity: number;
};

export type PushDefendFailedEvent = {
  kind: "push-defend-failed";
};

export type PushConsoleVerbEvent = {
  kind: "push-console-verb";
  cc: number;
};

export type PushConsoleLabelEvent = {
  kind: "push-console-label";
  index: number;
};

export type PushConsoleSetEvent = {
  kind: "push-console-set";
  value: number;
};

export type PushReviewChoiceEvent = {
  kind: "push-review-choice";
  choice: "undo" | "save";
};

export type PushCowDoneEvent = {
  kind: "push-cow-done";
  action: "abduct" | "release";
};

export type HardwareEvent =
  | StreamDeckHardwareEvent
  | Uf8HardwareEvent
  | PushHardwareEvent
  | PushDefendFailedEvent
  | PushConsoleVerbEvent
  | PushConsoleLabelEvent
  | PushConsoleSetEvent
  | PushReviewChoiceEvent
  | PushCowDoneEvent;

export type MissionState = {
  startedAt: number;
  stations: MissionStations;
  level: MissionLevel;
  levelObjectivesCompleted: number;
  score: number;
  integrity: number;
  combo: number;
  streamDeckKeys: readonly StreamDeckKey[];
  uf8Faders: Uf8FaderValues;
  activity: MissionActivity;
};

export type MissionOutcome =
  | {
      kind: "completed";
      taskId: string;
      reader: Station;
      target: Station;
      points: number;
    }
  | {
      kind: "mistake";
      taskId: string;
      reader: Station;
      target: Station;
    }
  | {
      kind: "expired";
      taskId: string;
      reader: Station;
      target: Station;
    }
  | {
      kind: "activity-started";
      activity: MissionActivity["kind"];
    }
  | {
      kind: "level-completed";
      level: MissionLevel;
    }
  | {
      kind: "level-started";
      level: MissionLevel;
    }
  | {
      kind: "interstitial-completed";
      taskId: string;
      station: Station;
      points: number;
    }
  | {
      kind: "interstitial-expired";
      taskId: string;
      station: Station;
    }
  | {
      kind: "procedure-completed";
      procedureId: string;
      points: number;
    }
  | {
      kind: "procedure-expired";
      procedureId: string;
    }
  | {
      kind: "mission-ended";
      reason: "survived" | "integrity";
    };

export type MissionUpdate = {
  outcomes: MissionOutcome[];
};

export function stationForTask(task: ActiveTask): Station {
  switch (task.kind) {
    case "streamdeck-route":
    case "streamdeck-sequence":
      return "streamdeck";
    case "uf8-fader":
      return "uf8";
    case "push-path":
    case "push-defend":
    case "push-console":
    case "push-review":
    case "push-cow":
      return "push";
  }
}

export function taskForReader(
  activity: OrdersActivity,
  reader: Station,
): ActiveTask {
  const task = activity.tasks.find((candidate) => candidate.reader === reader);
  if (task === undefined) {
    throw new Error(`Missing active task for ${reader}`);
  }
  return task;
}

export function describeTask(
  task: ActiveTask,
  keys: readonly StreamDeckKey[],
): string {
  switch (task.kind) {
    case "streamdeck-route": {
      const source = keys[task.sourceKeyIndex];
      const target = keys[task.targetKeyIndex];
      if (source === undefined || target === undefined) {
        throw new Error("Stream Deck task points outside the active key layout");
      }
      return `ROUTE ${source.label} THROUGH ${target.label}`;
    }
    case "streamdeck-sequence": {
      const hold = keys[task.holdKeyIndex];
      const tap = keys[task.tapKeyIndex];
      if (hold === undefined || tap === undefined) {
        throw new Error("Stream Deck sequence points outside the active key layout");
      }
      return `HOLD ${hold.label}, TAP ${tap.label}, RELEASE ${hold.label}`;
    }
    case "uf8-fader":
      return `SET ${task.label} TO ${task.target.label}`;
    case "push-path":
      return `TRACE THE ${task.color.toUpperCase()} VECTOR`;
    case "push-defend":
      return "DEFEND THE MOTHERSHIP";
    case "push-console": {
      const label = task.labels[task.targetIndex];
      if (label === undefined) {
        throw new Error("Console task target is outside its labels");
      }
      return task.action.kind === "scale"
        ? `SCALE ${label} TO ${task.action.value}`
        : `${task.action.verb} ${label}`;
    }
    case "push-review":
      return `${task.decision.toUpperCase()} "${task.subject} ${task.verb}"`;
    case "push-cow":
      return task.action === "abduct"
        ? "ABDUCT THE COW"
        : "RELEASE THE COW";
  }
}
