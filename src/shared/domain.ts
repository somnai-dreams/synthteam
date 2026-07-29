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

export type Uf8FaderTask = TaskBase & {
  kind: "uf8-fader";
  channel: number;
  label: string;
  target: number;
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

export type ActiveTask =
  | StreamDeckRouteTask
  | Uf8FaderTask
  | PushPathTask;

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

export type HardwareEvent =
  | StreamDeckHardwareEvent
  | Uf8HardwareEvent
  | PushHardwareEvent;

export type MissionState = {
  startedAt: number;
  endsAt: number;
  stations: MissionStations;
  score: number;
  integrity: number;
  combo: number;
  tasks: ActiveTask[];
  streamDeckKeys: readonly StreamDeckKey[];
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
      kind: "mission-ended";
      reason: "survived" | "integrity";
    };

export type MissionUpdate = {
  outcomes: MissionOutcome[];
};

export function stationForTask(task: ActiveTask): Station {
  switch (task.kind) {
    case "streamdeck-route":
      return "streamdeck";
    case "uf8-fader":
      return "uf8";
    case "push-path":
      return "push";
  }
}

export function taskForReader(
  mission: MissionState,
  reader: Station,
): ActiveTask {
  const task = mission.tasks.find((candidate) => candidate.reader === reader);
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
    case "uf8-fader":
      return `SET ${task.label} TO ${task.target}`;
    case "push-path":
      return `TRACE THE ${task.color.toUpperCase()} VECTOR`;
  }
}
