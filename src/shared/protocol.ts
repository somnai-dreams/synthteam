import type {
  ActivitySettings,
  ConfigurableGameTaskKind,
  GameTaskKind,
} from "../game/mission.ts";
import {
  CONFIGURABLE_GAME_TASK_KINDS,
  GAME_TASK_KINDS,
} from "../game/mission.ts";
import type {
  ActivePushTask,
  CrewSlots,
  HardwareEvent,
  InterstitialTask,
  MissionActivity,
  MissionLevel,
  MissionState,
  PushCornersInterstitial,
  ReactorProfile,
  Station,
  StreamDeckHitInterstitial,
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

export type MissionRunMode =
  | { kind: "campaign" }
  | { kind: "standalone"; game: GameTaskKind };

export type MissionPhaseView =
  | { kind: "lobby" }
  | { kind: "countdown"; endsAt: number }
  | {
      kind: "playing";
      level: MissionLevel;
      levelObjectivesCompleted: number;
      levelObjectiveTarget: number;
      activeControls: ActiveControlsView;
      runMode: MissionRunMode;
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

export type ActiveControlsView = {
  streamDeckColumns: number;
  uf8Channels: number;
  pushGridSize: number;
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

export type InterstitialDirective = DirectiveBase & {
  kind: "interstitial";
  station: Station;
  prompt: string;
};

export type InterstitialSupportDirective = DirectiveBase & {
  kind: "interstitial-support";
  focusStation: Station;
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
  | InterstitialDirective
  | InterstitialSupportDirective
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
  activitySettings: ActivitySettings;
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
      type: "phone-claim";
      name: string;
      station: Station;
    }
  | { type: "phone-resume"; crewId: string }
  | { type: "console-join" }
  | { type: "streamdeck-join" }
  | { type: "push-join" }
  | { type: "start-mission" }
  | { type: "start-standalone"; game: GameTaskKind }
  | { type: "reset-mission" }
  | { type: "set-activity-settings"; settings: ActivitySettings }
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
  activeColumns: number;
  task:
    | StreamDeckRouteTask
    | StreamDeckSequenceTask
    | StreamDeckHitInterstitial
    | null;
};

export type PushStateView = {
  phase: MissionPhaseView;
  activeGridSize: number;
  task: ActivePushTask | PushCornersInterstitial | null;
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
    case "interstitial": {
      const task = mission.activity.task;
      const base = {
        id: task.id,
        startedAt: task.startedAt,
        deadlineAt: task.deadlineAt,
      };
      if (task.station !== station) {
        return {
          ...base,
          kind: "interstitial-support",
          focusStation: task.station,
          prompt: `BACK UP THE ${stationDisplayName(task.station)} OPERATOR`,
        };
      }
      return {
        ...base,
        kind: "interstitial",
        station,
        prompt: interstitialPrompt(task, mission.streamDeckKeys),
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

function interstitialPrompt(
  task: InterstitialTask,
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
      return `BOTTOM OUT ${task.channelCount} FADERS!`;
    case "push-corners":
      return "CORNERS!";
  }
}

function stationDisplayName(station: Station): string {
  switch (station) {
    case "streamdeck":
      return "DECK";
    case "uf8":
      return "UF8";
    case "push":
      return "PUSH";
  }
}

/**
 * Whether a station's physical hardware is present: the Stream Deck
 * plugin, the Push bridge, or the UF8 direct link. Stations without
 * hardware cannot be claimed.
 */
export function stationHardwareAvailable(
  snapshot: {
    streamDeckConnected: boolean;
    pushBridgeConnected: boolean;
    uf8Connection: Uf8ConnectionState;
  },
  station: Station,
): boolean {
  switch (station) {
    case "streamdeck":
      return snapshot.streamDeckConnected;
    case "uf8":
      return snapshot.uf8Connection.kind === "connected";
    case "push":
      return snapshot.pushBridgeConnected;
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
    case "start-standalone":
      return isGameTaskKind(value["game"])
        ? { type: "start-standalone", game: value["game"] }
        : null;
    case "phone-claim":
      return typeof value.name === "string" && isStation(value.station)
        ? { type: "phone-claim", name: value.name, station: value.station }
        : null;
    case "phone-resume":
      if (typeof value.crewId !== "string" || value.crewId.length === 0) {
        return null;
      }
      return {
        type: "phone-resume",
        crewId: value.crewId,
      };
    case "set-activity-settings": {
      const settings = parseActivitySettings(value.settings);
      return settings === null
        ? null
        : { type: "set-activity-settings", settings };
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
    case "push-console-verb":
      return isIntegerInRange(value.cc, 0, 127)
        ? { kind: "push-console-verb", cc: value.cc }
        : null;
    case "push-console-label":
      return isIntegerInRange(value.index, 0, 15)
        ? { kind: "push-console-label", index: value.index }
        : null;
    case "push-console-set":
      return isIntegerInRange(value.value, 0, 8)
        ? { kind: "push-console-set", value: value.value }
        : null;
    case "push-review-choice":
      return isOneOf(value.choice, ["undo", "save"])
        ? { kind: "push-review-choice", choice: value.choice }
        : null;
    case "push-cow-done":
      return isOneOf(value.action, ["abduct", "release"])
        ? { kind: "push-cow-done", action: value.action }
        : null;
    default:
      return null;
  }
}

function isSnapshot(value: unknown): value is ViewSnapshot {
  if (
    !isRecord(value) ||
    !isRecord(value.viewer) ||
    !isCrewSlots(value.crew) ||
    !isPhase(value.phase) ||
    !Array.isArray(value.activity) ||
    !isStringArray(value.phoneUrls) ||
    typeof value.streamDeckConnected !== "boolean" ||
    typeof value.pushBridgeConnected !== "boolean" ||
    !isUf8ConnectionState(value["uf8Connection"]) ||
    parseActivitySettings(value["activitySettings"]) === null
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
    case "interstitial":
      return isStation(value["station"]) && typeof value["prompt"] === "string";
    case "interstitial-support":
      return (
        isStation(value["focusStation"]) &&
        typeof value["prompt"] === "string"
      );
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
        isIntegerInRange(value["level"], 1, 5) &&
        isIntegerInRange(value["levelObjectivesCompleted"], 0, 8) &&
        isIntegerInRange(value["levelObjectiveTarget"], 1, 8) &&
        isActiveControlsView(value["activeControls"]) &&
        isMissionRunMode(value["runMode"]) &&
        typeof value.score === "number" &&
        typeof value.integrity === "number" &&
        typeof value.combo === "number" &&
        isOneOf(value["activity"], [
          "orders",
          "interstitial",
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

function isActiveControlsView(value: unknown): value is ActiveControlsView {
  return (
    isRecord(value) &&
    isIntegerInRange(value["streamDeckColumns"], 0, 8) &&
    isIntegerInRange(value["uf8Channels"], 0, 8) &&
    isIntegerInRange(value["pushGridSize"], 0, 8)
  );
}

function isMissionRunMode(value: unknown): value is MissionRunMode {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  switch (value.kind) {
    case "campaign":
      return true;
    case "standalone":
      return isGameTaskKind(value["game"]);
    default:
      return false;
  }
}

function isStation(value: unknown): value is Station {
  return STATIONS.some((station) => station === value);
}

function isCrewSlots(value: unknown): value is CrewSlots {
  if (!isRecord(value)) {
    return false;
  }
  for (const station of STATIONS) {
    const member = value[station];
    if (member === null) {
      continue;
    }
    if (
      !isRecord(member) ||
      typeof member["id"] !== "string" ||
      typeof member["name"] !== "string" ||
      member["station"] !== station ||
      !isCrewConnection(member["connection"])
    ) {
      return false;
    }
  }
  return true;
}

function isCrewConnection(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  switch (value.kind) {
    case "connected":
      return true;
    case "reserved":
      return typeof value["endsAt"] === "number";
    default:
      return false;
  }
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

function parseActivitySettings(value: unknown): ActivitySettings | null {
  if (!isRecord(value)) {
    return null;
  }
  const settings: Partial<Record<ConfigurableGameTaskKind, boolean>> = {};
  for (const kind of CONFIGURABLE_GAME_TASK_KINDS) {
    const flag = value[kind];
    if (typeof flag !== "boolean") {
      return null;
    }
    settings[kind] = flag;
  }
  return settings as ActivitySettings;
}

function isGameTaskKind(value: unknown): value is GameTaskKind {
  return (
    typeof value === "string" &&
    GAME_TASK_KINDS.some((kind) => kind === value)
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
  event?: unknown;
  cc?: unknown;
  index?: unknown;
  choice?: unknown;
  action?: unknown;
  settings?: unknown;
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
  level?: unknown;
  levelObjectivesCompleted?: unknown;
  levelObjectiveTarget?: unknown;
  activeControls?: unknown;
  streamDeckColumns?: unknown;
  uf8Channels?: unknown;
  pushGridSize?: unknown;
  focusStation?: unknown;
  reason?: unknown;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
