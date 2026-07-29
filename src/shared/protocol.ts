import type {
  ActiveTask,
  CrewSlots,
  HardwareEvent,
  MissionState,
  Station,
  StreamDeckKey,
  StreamDeckRouteTask,
} from "./domain.ts";
import {
  describeTask,
  STATIONS,
  stationForTask,
  taskForReader,
} from "./domain.ts";

export type ActivityTone = "neutral" | "success" | "danger";

export type ActivityItem = {
  id: string;
  at: number;
  text: string;
  tone: ActivityTone;
};

export type MissionPhaseView =
  | { kind: "lobby" }
  | { kind: "countdown"; endsAt: number }
  | {
      kind: "playing";
      endsAt: number;
      score: number;
      integrity: number;
      combo: number;
    }
  | {
      kind: "game-over";
      reason: "survived" | "integrity";
      score: number;
    };

export type PublicOrder = {
  id: string;
  target: Station;
  prompt: string;
  deadlineAt: number;
};

export type ConsoleMissionView = {
  tasks: readonly ActiveTask[];
  streamDeckKeys: readonly StreamDeckKey[];
};

type SnapshotBase = {
  crew: CrewSlots;
  phase: MissionPhaseView;
  activity: readonly ActivityItem[];
  phoneUrls: readonly string[];
  streamDeckConnected: boolean;
};

export type AnonymousSnapshot = SnapshotBase & {
  viewer: { kind: "anonymous" };
};

export type PhoneSnapshot = SnapshotBase & {
  viewer: {
    kind: "phone";
    crewId: string;
    station: Station;
  };
  order: PublicOrder | null;
};

export type ConsoleSnapshot = SnapshotBase & {
  viewer: { kind: "console" };
  mission: ConsoleMissionView | null;
};

export type ViewSnapshot =
  | AnonymousSnapshot
  | PhoneSnapshot
  | ConsoleSnapshot;

export type ClientMessage =
  | {
      type: "phone-join";
      name: string;
      resumeCrewId: string | null;
    }
  | { type: "console-join" }
  | { type: "streamdeck-join" }
  | { type: "start-mission" }
  | { type: "reset-mission" }
  | { type: "hardware-event"; event: HardwareEvent }
  | { type: "ping" };

export type ServerMessage =
  | { type: "snapshot"; snapshot: ViewSnapshot }
  | { type: "streamdeck-state"; state: StreamDeckStateView }
  | { type: "error"; message: string }
  | { type: "pong" };

export type StreamDeckStateView = {
  keys: readonly StreamDeckKey[];
  task: StreamDeckRouteTask | null;
};

export function publicOrderForReader(
  mission: MissionState,
  reader: Station,
): PublicOrder {
  const task = taskForReader(mission, reader);
  return {
    id: task.id,
    target: stationForTask(task),
    prompt: describeTask(task, mission.streamDeckKeys),
    deadlineAt: task.deadlineAt,
  };
}

export function parseClientMessage(raw: string): ClientMessage | null {
  const value = parseJson(raw);
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "console-join":
    case "streamdeck-join":
    case "start-mission":
    case "reset-mission":
    case "ping":
      return { type: value.type };
    case "phone-join": {
      if (
        typeof value.name !== "string" ||
        !isNullableString(value.resumeCrewId)
      ) {
        return null;
      }
      return {
        type: "phone-join",
        name: value.name,
        resumeCrewId: value.resumeCrewId,
      };
    }
    case "hardware-event": {
      const event = parseHardwareEvent(value.event);
      return event === null ? null : { type: "hardware-event", event };
    }
    default:
      return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const value = parseJson(raw);
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  switch (value.type) {
    case "pong":
      return { type: "pong" };
    case "error":
      return typeof value.message === "string"
        ? { type: "error", message: value.message }
        : null;
    case "snapshot":
      return isSnapshot(value.snapshot)
        ? { type: "snapshot", snapshot: value.snapshot }
        : null;
    case "streamdeck-state":
      return null;
    default:
      return null;
  }
}

function parseHardwareEvent(value: unknown): HardwareEvent | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  switch (value.kind) {
    case "streamdeck-key":
      return isIntegerInRange(value.keyIndex, 0, 31) &&
        isOneOf(value.phase, ["down", "up"])
        ? {
            kind: "streamdeck-key",
            keyIndex: value.keyIndex,
            phase: value.phase,
          }
        : null;
    case "uf8-fader":
      return isIntegerInRange(value.channel, 0, 7) &&
        isNumberInRange(value.value, 0, 100)
        ? {
            kind: "uf8-fader",
            channel: value.channel,
            value: value.value,
          }
        : null;
    case "push-pad": {
      if (
        !isRecord(value.point) ||
        !isIntegerInRange(value.point.x, 0, 7) ||
        !isIntegerInRange(value.point.y, 0, 7) ||
        !isOneOf(value.phase, ["down", "up"]) ||
        !isNumberInRange(value.velocity, 0, 127)
      ) {
        return null;
      }
      return {
        kind: "push-pad",
        point: { x: value.point.x, y: value.point.y },
        phase: value.phase,
        velocity: value.velocity,
      };
    }
    default:
      return null;
  }
}

function isSnapshot(value: unknown): value is ViewSnapshot {
  if (
    !isRecord(value) ||
    !isRecord(value.viewer) ||
    !isRecord(value.crew) ||
    !isPhase(value.phase) ||
    !Array.isArray(value.activity) ||
    !isStringArray(value.phoneUrls) ||
    typeof value.streamDeckConnected !== "boolean"
  ) {
    return false;
  }
  switch (value.viewer.kind) {
    case "anonymous":
      return true;
    case "phone":
      return (
        typeof value.viewer.crewId === "string" &&
        isStation(value.viewer.station) &&
        ("order" in value)
      );
    case "console":
      return "mission" in value;
    default:
      return false;
  }
}

function isPhase(value: unknown): value is MissionPhaseView {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  switch (value.kind) {
    case "lobby":
      return true;
    case "countdown":
      return typeof value.endsAt === "number";
    case "playing":
      return (
        typeof value.endsAt === "number" &&
        typeof value.score === "number" &&
        typeof value.integrity === "number" &&
        typeof value.combo === "number"
      );
    case "game-over":
      return (
        isOneOf(value.reason, ["survived", "integrity"]) &&
        typeof value.score === "number"
      );
    default:
      return false;
  }
}

function isStation(value: unknown): value is Station {
  return STATIONS.some((station) => station === value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

type JsonRecord = {
  type?: unknown;
  name?: unknown;
  station?: unknown;
  resumeCrewId?: unknown;
  event?: unknown;
  message?: unknown;
  snapshot?: unknown;
  kind?: unknown;
  keyIndex?: unknown;
  phase?: unknown;
  channel?: unknown;
  value?: unknown;
  point?: unknown;
  x?: unknown;
  y?: unknown;
  velocity?: unknown;
  viewer?: unknown;
  crew?: unknown;
  activity?: unknown;
  phoneUrls?: unknown;
  streamDeckConnected?: unknown;
  order?: unknown;
  mission?: unknown;
  crewId?: unknown;
  endsAt?: unknown;
  score?: unknown;
  integrity?: unknown;
  combo?: unknown;
  reason?: unknown;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

function isIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isOneOf<const T extends string>(
  value: unknown,
  options: readonly T[],
): value is T {
  return typeof value === "string" && options.some((option) => option === value);
}
