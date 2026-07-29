export const STATIONS = ["streamdeck", "uf8", "push"] as const;

export type Station = (typeof STATIONS)[number];

export type MissionStations =
  | readonly [Station, Station]
  | readonly [Station, Station, Station];

export type CrewMember = {
  id: string;
  name: string;
  station: Station;
  connected: boolean;
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

export type ActivePushTask = PushPathTask | PushDefendTask;

export type ActiveTask =
  | StreamDeckRouteTask
  | StreamDeckSequenceTask
  | Uf8FaderTask
  | PushPathTask
  | PushDefendTask;

export type OrdersBeat = "opening" | "pressure" | "final";

export type OrdersActivity = {
  kind: "orders";
  beat: OrdersBeat;
  startedAt: number;
  endsAt: number;
  tasks: ActiveTask[];
};

type LocalOverrideBase = {
  id: string;
  startedAt: number;
  deadlineAt: number;
  completed: boolean;
};

export type StreamDeckHitOverride = LocalOverrideBase & {
  kind: "streamdeck-hit";
  station: "streamdeck";
  keyIndex: number;
};

export type Uf8BottomOutOverride = LocalOverrideBase & {
  kind: "uf8-bottom-out";
  station: "uf8";
  threshold: number;
};

export type PushCornersOverride = LocalOverrideBase & {
  kind: "push-corners";
  station: "push";
  pressed: GridPoint[];
};

export type LocalOverrideTask =
  | StreamDeckHitOverride
  | Uf8BottomOutOverride
  | PushCornersOverride;

export type LocalOverridesActivity = {
  kind: "local-overrides";
  startedAt: number;
  endsAt: number;
  tasks: LocalOverrideTask[];
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
  | LocalOverridesActivity
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

export type HardwareEvent =
  | StreamDeckHardwareEvent
  | Uf8HardwareEvent
  | PushHardwareEvent
  | PushDefendFailedEvent;

export type MissionState = {
  startedAt: number;
  endsAt: number;
  stations: MissionStations;
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
      kind: "local-override-completed";
      taskId: string;
      station: Station;
      points: number;
    }
  | {
      kind: "local-override-expired";
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
  }
}
