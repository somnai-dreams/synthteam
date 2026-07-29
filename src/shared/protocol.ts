import type {
  ActivePushTask,
  CrewSlots,
  HardwareEvent,
  LocalOverrideTask,
  MissionActivity,
  MissionState,
  ReactorProfile,
  Station,
  StreamDeckHitOverride,
  StreamDeckKey,
  StreamDeckRouteTask,
  StreamDeckSequenceTask,
  Uf8ConnectionState,
} from "./domain.ts";
import {
  describeTask,
  REACTOR_PROFILES,
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
      activity: MissionActivity["kind"];
    }
  | {
      kind: "game-over";
      reason: "survived" | "integrity";
      score: number;
    };

type DirectiveBase = {
  id: string;
  startedAt: number;
  deadlineAt: number;
};

export type OrderDirective = DirectiveBase & {
  kind: "order";
  target: Station;
  prompt: string;
};

export type LocalOverrideDirective = DirectiveBase & {
  kind: "local-override";
  station: Station;
  prompt: string;
};

export type ReactorManualDirective = DirectiveBase & {
  kind: "reactor-manual";
  target: "uf8";
  profiles: readonly ReactorProfile[];
};

export type ReactorOperatorDirective = DirectiveBase & {
  kind: "reactor-operator";
  station: "uf8";
  prompt: string;
};

export type ReactorSupportDirective = DirectiveBase & {
  kind: "reactor-support";
  prompt: string;
};

export type PhoneDirective =
  | OrderDirective
  | LocalOverrideDirective
  | ReactorManualDirective
  | ReactorOperatorDirective
  | ReactorSupportDirective;

export type ConsoleMissionView = {
  activity: MissionActivity;
  streamDeckKeys: readonly StreamDeckKey[];
};

type SnapshotBase = {
  crew: CrewSlots;
  phase: MissionPhaseView;
  activity: readonly ActivityItem[];
  phoneUrls: readonly string[];
  streamDeckConnected: boolean;
  pushBridgeConnected: boolean;
  uf8Connection: Uf8ConnectionState;
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
  directive: PhoneDirective | null;
};

export type ConsoleSnapshot = SnapshotBase & {
  viewer: { kind: "console" };
  mission: ConsoleMissionView | null;
  uf8Faders: readonly number[];
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
  | { type: "push-join" }
  | { type: "start-mission" }
  | { type: "reset-mission" }
  | { type: "hardware-event"; event: HardwareEvent }
  | { type: "ping" };

export type ServerMessage =
  | { type: "snapshot"; snapshot: ViewSnapshot }
  | { type: "streamdeck-state"; state: StreamDeckStateView }
  | { type: "push-state"; state: PushStateView }
  | { type: "error"; message: string }
  | { type: "pong" };

export type StreamDeckStateView = {
  keys: readonly StreamDeckKey[];
  task:
    | StreamDeckRouteTask
    | StreamDeckSequenceTask
    | StreamDeckHitOverride
    | null;
};

export type PushStateView = {
  phase: MissionPhaseView;
  task: ActivePushTask | null;
};

export function publicDirectiveForStation(
  mission: MissionState,
  station: Station,
): PhoneDirective {
  switch (mission.activity.kind) {
    case "orders": {
      const task = taskForReader(mission.activity, station);
      return {
        kind: "order",
        id: task.id,
        startedAt: task.createdAt,
        deadlineAt: task.deadlineAt,
        target: stationForTask(task),
        prompt: describeTask(task, mission.streamDeckKeys),
      };
    }
    case "local-overrides": {
      const task = mission.activity.tasks.find(
        (candidate) => candidate.station === station,
      );
      if (task === undefined) {
        throw new Error(`Missing local override for ${station}`);
      }
      return {
        kind: "local-override",
        id: task.id,
        startedAt: task.startedAt,
        deadlineAt: task.deadlineAt,
        station,
        prompt: localOverridePrompt(task, mission.streamDeckKeys),
      };
    }
    case "reactor-procedure": {
      const procedure = mission.activity.procedure;
      const base = {
        id: procedure.id,
        startedAt: procedure.createdAt,
        deadlineAt: procedure.deadlineAt,
      };
      if (station === procedure.reader) {
        return {
          ...base,
          kind: "reactor-manual",
          target: "uf8",
          profiles: REACTOR_PROFILES,
        };
      }
      if (station === "uf8") {
        return {
          ...base,
          kind: "reactor-operator",
          station,
          prompt: "READ THE REACTOR CODE ALOUD",
        };
      }
      return {
        ...base,
        kind: "reactor-support",
        prompt: "HELP THE CREW CALIBRATE THE REACTOR",
      };
    }
  }
}

function localOverridePrompt(
  task: LocalOverrideTask,
  keys: readonly StreamDeckKey[],
): string {
  switch (task.kind) {
    case "streamdeck-hit": {
      const key = keys[task.keyIndex];
      if (key === undefined) {
        throw new Error("Stream Deck override points outside the key layout");
      }
      return `HIT ${key.label}!`;
    }
    case "uf8-bottom-out":
      return "BOTTOM OUT!";
    case "push-corners":
      return "CORNERS!";
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  const value = parseJson(raw);
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "console-join":
    case "streamdeck-join":
    case "push-join":
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
    case "push-state":
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
    case "push-defend-failed":
      return { kind: "push-defend-failed" };
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
    typeof value.streamDeckConnected !== "boolean" ||
    typeof value.pushBridgeConnected !== "boolean" ||
    !isUf8ConnectionState(value["uf8Connection"])
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
        (value["directive"] === null ||
          isPhoneDirective(value["directive"]))
      );
    case "console":
      return (
        "mission" in value &&
        isNumberArrayInRange(value["uf8Faders"], 8, 0, 100)
      );
    default:
      return false;
  }
}

function isPhoneDirective(value: unknown): value is PhoneDirective {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value["id"] !== "string" ||
    typeof value["startedAt"] !== "number" ||
    typeof value["deadlineAt"] !== "number"
  ) {
    return false;
  }
  switch (value.kind) {
    case "order":
      return isStation(value["target"]) && typeof value["prompt"] === "string";
    case "local-override":
      return isStation(value["station"]) && typeof value["prompt"] === "string";
    case "reactor-manual":
      return value["target"] === "uf8" && isReactorProfiles(value["profiles"]);
    case "reactor-operator":
      return value["station"] === "uf8" && typeof value["prompt"] === "string";
    case "reactor-support":
      return typeof value["prompt"] === "string";
    default:
      return false;
  }
}

function isReactorProfiles(value: unknown): value is readonly ReactorProfile[] {
  return (
    Array.isArray(value) &&
    value.length === REACTOR_PROFILES.length &&
    value.every((profile) => {
      if (
        !isRecord(profile) ||
        typeof profile["code"] !== "string" ||
        !Array.isArray(profile["targets"]) ||
        profile["targets"].length !== 2
      ) {
        return false;
      }
      return profile["targets"].every(
        (target: unknown) =>
          isRecord(target) &&
          isIntegerInRange(target["channel"], 0, 7) &&
          typeof target["label"] === "string" &&
          isRecord(target["stop"]) &&
          typeof target["stop"]["label"] === "string" &&
          isNumberInRange(target["stop"]["value"], 0, 100),
      );
    })
  );
}

function isUf8ConnectionState(
  value: unknown,
): value is Uf8ConnectionState {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  switch (value.kind) {
    case "disconnected":
      return typeof value.message === "string";
    case "connected":
      return typeof value["serial"] === "string";
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
        typeof value.combo === "number" &&
        isOneOf(value["activity"], [
          "orders",
          "local-overrides",
          "reactor-procedure",
        ])
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

function isNumberArrayInRange(
  value: unknown,
  length: number,
  minimum: number,
  maximum: number,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => isNumberInRange(item, minimum, maximum))
  );
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
  pushBridgeConnected?: unknown;
  directive?: unknown;
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
