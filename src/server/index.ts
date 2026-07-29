import app from "../client/index.html";
import { networkInterfaces } from "node:os";
import {
  advanceMission,
  applyHardwareEvent,
  createMission,
} from "../game/mission.ts";
import {
  claimStation,
  connectedCrewStations,
  releaseExpiredReservations,
  reserveCrewStation,
  resumeCrew,
} from "../game/crew.ts";
import {
  type Uf8DisplayView,
  Uf8Runtime,
} from "../hardware/uf8/runtime.ts";
import type {
  CrewSlots,
  HardwareEvent,
  MissionOutcome,
  MissionState,
  MissionStations,
  ActivePushTask,
  Station,
  Uf8FaderValues,
} from "../shared/domain.ts";
import {
  UF8_CONTROL_LABELS,
  UF8_ZERO_FADER_STOP,
} from "../shared/domain.ts";
import type {
  ActivityItem,
  ClientMessage,
  ConsoleSnapshot,
  MissionPhaseView,
  PhoneSnapshot,
  PushStateView,
  ServerMessage,
  ViewSnapshot,
} from "../shared/protocol.ts";
import {
  parseClientMessage,
  publicDirectiveForStation,
} from "../shared/protocol.ts";

type ViewerIdentity =
  | { kind: "anonymous" }
  | { kind: "phone"; crewId: string; station: Station }
  | { kind: "console" }
  | { kind: "streamdeck" }
  | { kind: "push-bridge" };

type SocketData = {
  viewer: ViewerIdentity;
};

type GameState =
  | { kind: "lobby" }
  | { kind: "countdown"; endsAt: number; stations: MissionStations }
  | { kind: "playing"; mission: MissionState }
  | {
      kind: "game-over";
      reason: "survived" | "integrity";
      score: number;
    };

const crew: CrewSlots = {
  streamdeck: null,
  uf8: null,
  push: null,
};
const sockets: Bun.ServerWebSocket<SocketData>[] = [];
const activity: ActivityItem[] = [];
const uf8FaderValues: Uf8FaderValues = [0, 0, 0, 0, 0, 0, 0, 0];
let game: GameState = { kind: "lobby" };
let shuttingDown = false;

const uf8 = new Uf8Runtime({
  onConnectionChange(state) {
    switch (state.kind) {
      case "disconnected":
        addActivity(state.message, "danger");
        break;
      case "connected":
        addActivity(`UF8 direct link ready · ${state.serial}`, "success");
        uf8.moveFadersTo(UF8_ZERO_FADER_STOP.value);
        syncUf8Display();
        break;
    }
    broadcastSnapshots();
  },
  onFader(event) {
    uf8FaderValues[event.channel] = event.value;
    if (game.kind === "playing") {
      applyGameHardwareEvent(event);
      return;
    }
    broadcastSnapshots();
  },
});

const port = parsePort(Bun.env["PORT"]);
const phoneUrls = findPhoneUrls(port);
const server = Bun.serve<SocketData>({
  hostname: "0.0.0.0",
  port,
  routes: {
    "/": app,
    "/console": app,
    "/health": () => Response.json({ ok: true, uf8: uf8.state }),
  },
  fetch(request, currentServer) {
    const url = new URL(request.url);
    if (
      url.pathname === "/ws" &&
      currentServer.upgrade(request, {
        data: { viewer: { kind: "anonymous" } },
      })
    ) {
      return undefined;
    }
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    idleTimeout: 120,
    open(socket) {
      sockets.push(socket);
      sendSnapshot(socket);
    },
    message(socket, rawMessage) {
      if (typeof rawMessage !== "string") {
        send(socket, { type: "error", message: "Text messages only" });
        return;
      }
      const message = parseClientMessage(rawMessage);
      if (message === null) {
        send(socket, { type: "error", message: "Invalid message" });
        return;
      }
      handleMessage(socket, message);
    },
    close(socket) {
      const socketIndex = sockets.indexOf(socket);
      if (socketIndex >= 0) {
        sockets.splice(socketIndex, 1);
      }
      const viewer = socket.data.viewer;
      if (viewer.kind === "streamdeck" || viewer.kind === "push-bridge") {
        broadcastSnapshots();
        return;
      }
      if (viewer.kind !== "phone") {
        return;
      }
      if (
        reserveCrewStation(
          crew,
          viewer.station,
          viewer.crewId,
          Date.now(),
        )
      ) {
        const member = crew[viewer.station];
        if (member === null) {
          throw new Error("Reserved crew station lost its member");
        }
        addActivity(`${member.name} lost signal`, "danger");
        broadcastSnapshots();
      }
    },
  },
});

const tickInterval = setInterval(tick, 50);
uf8.start();

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

console.log(`Synthteam central server: http://localhost:${server.port}`);
for (const url of phoneUrls) {
  console.log(`Phone URL: ${url}`);
}
console.log(`Hardware console: http://localhost:${server.port}/console`);

function handleMessage(
  socket: Bun.ServerWebSocket<SocketData>,
  message: ClientMessage,
): void {
  switch (message.type) {
    case "ping":
      send(socket, { type: "pong" });
      return;
    case "console-join":
      socket.data.viewer = { kind: "console" };
      sendSnapshot(socket);
      return;
    case "streamdeck-join":
      socket.data.viewer = { kind: "streamdeck" };
      broadcastSnapshots();
      return;
    case "push-join":
      socket.data.viewer = { kind: "push-bridge" };
      broadcastSnapshots();
      return;
    case "phone-claim":
      claimPhone(socket, message.name, message.station);
      return;
    case "phone-resume":
      resumePhone(socket, message.crewId);
      return;
    case "start-mission":
      if (requireConsole(socket) && game.kind === "lobby") {
        startCountdown(socket);
      }
      return;
    case "reset-mission":
      if (requireConsole(socket)) {
        game = { kind: "lobby" };
        addActivity("Mission reset", "neutral");
        broadcastSnapshots();
      }
      return;
    case "hardware-event":
      if (
        !canSubmitHardware(socket, message.event.kind) ||
        game.kind !== "playing"
      ) {
        return;
      }
      applyGameHardwareEvent(message.event);
      return;
  }
}

function claimPhone(
  socket: Bun.ServerWebSocket<SocketData>,
  rawName: string,
  station: Station,
): void {
  const name = normalizeName(rawName);
  if (name.length === 0) {
    send(socket, { type: "error", message: "Enter a crew name" });
    return;
  }

  if (game.kind !== "lobby") {
    send(socket, {
      type: "error",
      message: "New crew can only join from the lobby",
    });
    return;
  }

  const result = claimStation(crew, station, name, () => crypto.randomUUID());
  if (result.kind === "unavailable") {
    send(socket, {
      type: "error",
      message: `${stationName(station)} was just claimed. Choose another station.`,
    });
    return;
  }
  socket.data.viewer = {
    kind: "phone",
    crewId: result.member.id,
    station,
  };
  addActivity(`${name} assigned to ${stationName(station)}`, "success");
  broadcastSnapshots();
}

function resumePhone(
  socket: Bun.ServerWebSocket<SocketData>,
  crewId: string,
): void {
  const result = resumeCrew(crew, crewId);
  if (result.kind === "expired") {
    send(socket, {
      type: "error",
      message: "Your station reservation expired. Choose an open station.",
    });
    return;
  }
  socket.data.viewer = {
    kind: "phone",
    crewId: result.member.id,
    station: result.station,
  };
  addActivity(
    `${result.member.name} reconnected to ${stationName(result.station)}`,
    "success",
  );
  broadcastSnapshots();
}

function startCountdown(socket: Bun.ServerWebSocket<SocketData>): void {
  const stations = connectedMissionStations();
  if (stations === null) {
    send(socket, {
      type: "error",
      message: "Waiting for at least two phones",
    });
    return;
  }
  game = { kind: "countdown", endsAt: Date.now() + 3_000, stations };
  uf8.moveFadersTo(UF8_ZERO_FADER_STOP.value);
  addActivity(`${stations.length}-crew mission begins in three`, "neutral");
  broadcastSnapshots();
}

function applyGameHardwareEvent(event: HardwareEvent): void {
  if (game.kind !== "playing") {
    return;
  }
  recordOutcomes(
    applyHardwareEvent(game.mission, event, Date.now()).outcomes,
  );
  broadcastSnapshots();
}

function tick(): void {
  const now = Date.now();
  const releasedCrew = releaseExpiredReservations(crew, now);
  for (const member of releasedCrew) {
    addActivity(
      `${member.name}'s ${stationName(member.station)} reservation expired`,
      "neutral",
    );
  }
  const crewChanged = releasedCrew.length > 0;
  switch (game.kind) {
    case "lobby":
    case "game-over":
      if (crewChanged) {
        broadcastSnapshots();
      }
      return;
    case "countdown":
      if (now >= game.endsAt) {
        game = {
          kind: "playing",
          mission: createMission(
            now,
            game.stations,
            undefined,
            uf8FaderValues,
          ),
        };
        addActivity("All systems live", "success");
        broadcastSnapshots();
      } else if (crewChanged) {
        broadcastSnapshots();
      }
      return;
    case "playing": {
      const outcomes = advanceMission(game.mission, now).outcomes;
      if (outcomes.length > 0 || crewChanged) {
        recordOutcomes(outcomes);
        broadcastSnapshots();
      }
      return;
    }
  }
}

function recordOutcomes(outcomes: readonly MissionOutcome[]): void {
  for (const outcome of outcomes) {
    switch (outcome.kind) {
      case "completed":
        addActivity(
          `${stationName(outcome.target)} locked · +${outcome.points}`,
          "success",
        );
        break;
      case "mistake":
        addActivity(`${stationName(outcome.target)} rejected input`, "danger");
        break;
      case "expired":
        addActivity(`${stationName(outcome.target)} order expired`, "danger");
        break;
      case "activity-started":
        switch (outcome.activity) {
          case "orders":
            addActivity("Cross-channel orders resumed", "neutral");
            break;
          case "local-overrides":
            addActivity("Local overrides — act alone", "neutral");
            break;
          case "reactor-procedure":
            addActivity("Reactor procedure active", "danger");
            break;
        }
        break;
      case "local-override-completed":
        addActivity(
          `${stationName(outcome.station)} override cleared · +${outcome.points}`,
          "success",
        );
        break;
      case "local-override-expired":
        addActivity(
          `${stationName(outcome.station)} override missed`,
          "danger",
        );
        break;
      case "procedure-completed":
        addActivity(
          `Reactor calibrated · +${outcome.points}`,
          "success",
        );
        break;
      case "procedure-expired":
        addActivity("Reactor procedure failed", "danger");
        break;
      case "mission-ended": {
        if (game.kind !== "playing") {
          return;
        }
        game = {
          kind: "game-over",
          reason: outcome.reason,
          score: game.mission.score,
        };
        addActivity(
          outcome.reason === "survived"
            ? "Mission survived"
            : "Ship integrity lost",
          outcome.reason === "survived" ? "success" : "danger",
        );
        break;
      }
    }
  }
}

function sendSnapshot(socket: Bun.ServerWebSocket<SocketData>): void {
  if (socket.data.viewer.kind === "streamdeck") {
    send(socket, { type: "streamdeck-state", state: streamDeckState() });
    return;
  }
  if (socket.data.viewer.kind === "push-bridge") {
    send(socket, { type: "push-state", state: pushState() });
    return;
  }
  send(socket, { type: "snapshot", snapshot: snapshotFor(socket.data.viewer) });
}

function broadcastSnapshots(): void {
  syncUf8Display();
  for (const socket of sockets) {
    sendSnapshot(socket);
  }
}

function snapshotFor(
  viewer: Exclude<ViewerIdentity, { kind: "streamdeck" | "push-bridge" }>,
): ViewSnapshot {
  const base = {
    crew,
    phase: phaseView(),
    activity,
    phoneUrls,
    streamDeckConnected: sockets.some(
      (socket) => socket.data.viewer.kind === "streamdeck",
    ),
    pushBridgeConnected: sockets.some(
      (socket) => socket.data.viewer.kind === "push-bridge",
    ),
    uf8Connection: uf8.state,
  };
  switch (viewer.kind) {
    case "anonymous":
      return { ...base, viewer };
    case "phone": {
      const snapshot: PhoneSnapshot = {
        ...base,
        viewer,
        directive:
          game.kind === "playing"
            ? publicDirectiveForStation(game.mission, viewer.station)
            : null,
      };
      return snapshot;
    }
    case "console": {
      const snapshot: ConsoleSnapshot = {
        ...base,
        viewer,
        mission:
          game.kind === "playing"
            ? {
                activity: game.mission.activity,
                streamDeckKeys: game.mission.streamDeckKeys,
              }
            : null,
        uf8Faders:
          game.kind === "playing"
            ? game.mission.uf8Faders
            : uf8FaderValues,
      };
      return snapshot;
    }
  }
}

function syncUf8Display(): void {
  const view: Uf8DisplayView = {
    scene: uf8DisplayScene(),
    strips: UF8_CONTROL_LABELS.map((label) => ({
      label,
      cue: null,
    })),
  };
  if (game.kind === "playing") {
    switch (game.mission.activity.kind) {
      case "orders":
        break;
      case "local-overrides": {
        const override = game.mission.activity.tasks.find(
          (task) => task.kind === "uf8-bottom-out",
        );
        if (override !== undefined) {
          for (const strip of view.strips) {
            strip.cue = { heading: "LOCAL", value: "DOWN!" };
          }
        }
        break;
      }
      case "reactor-procedure": {
        const strip = view.strips[2];
        if (strip === undefined) {
          throw new Error("UF8 reactor code display is missing");
        }
        strip.cue = {
          heading: "REPORT CODE",
          value: game.mission.activity.procedure.profile.code,
        };
        break;
      }
    }
  }
  uf8.render(view);
}

function uf8DisplayScene(): Uf8DisplayView["scene"] {
  switch (game.kind) {
    case "lobby":
      return { kind: "attract" };
    case "countdown":
      return { kind: "countdown", endsAt: game.endsAt };
    case "playing":
      return {
        kind: "mission",
        activity: game.mission.activity.kind,
      };
    case "game-over":
      return { kind: "game-over", result: game.reason };
  }
}

function streamDeckState() {
  if (game.kind !== "playing") {
    return { keys: [], task: null };
  }
  let task = null;
  switch (game.mission.activity.kind) {
    case "orders":
      task =
        game.mission.activity.tasks.find(
          (candidate) =>
            candidate.kind === "streamdeck-route" ||
            candidate.kind === "streamdeck-sequence",
        ) ?? null;
      break;
    case "local-overrides":
      task =
        game.mission.activity.tasks.find(
          (candidate) => candidate.kind === "streamdeck-hit",
        ) ?? null;
      break;
    case "reactor-procedure":
      break;
  }
  return {
    keys: game.mission.streamDeckKeys,
    task: task ?? null,
  };
}

function pushState(): PushStateView {
  if (game.kind !== "playing") {
    return { phase: phaseView(), task: null };
  }
  const task =
    game.mission.activity.kind === "orders"
      ? game.mission.activity.tasks.find(
          (candidate): candidate is ActivePushTask =>
            candidate.kind === "push-path" ||
            candidate.kind === "push-defend",
        )
      : undefined;
  return { phase: phaseView(), task: task ?? null };
}

function phaseView(): MissionPhaseView {
  switch (game.kind) {
    case "lobby":
      return { kind: "lobby" };
    case "countdown":
      return { kind: "countdown", endsAt: game.endsAt };
    case "playing":
      return {
        kind: "playing",
        endsAt: game.mission.endsAt,
        score: game.mission.score,
        integrity: game.mission.integrity,
        combo: game.mission.combo,
        activity: game.mission.activity.kind,
      };
    case "game-over":
      return {
        kind: "game-over",
        reason: game.reason,
        score: game.score,
      };
  }
}

function requireConsole(socket: Bun.ServerWebSocket<SocketData>): boolean {
  if (socket.data.viewer.kind === "console") {
    return true;
  }
  send(socket, {
    type: "error",
    message: "Only the central console can do that",
  });
  return false;
}

function canSubmitHardware(
  socket: Bun.ServerWebSocket<SocketData>,
  eventKind: HardwareEvent["kind"],
): boolean {
  switch (socket.data.viewer.kind) {
    case "console":
      return true;
    case "streamdeck":
      return eventKind === "streamdeck-key";
    case "push-bridge":
      return eventKind === "push-pad";
    case "anonymous":
    case "phone":
      send(socket, {
        type: "error",
        message: "This connection cannot submit hardware input",
      });
      return false;
  }
}

function addActivity(text: string, tone: ActivityItem["tone"]): void {
  activity.unshift({
    id: crypto.randomUUID(),
    at: Date.now(),
    text,
    tone,
  });
  if (activity.length > 6) {
    activity.length = 6;
  }
}

function send(
  socket: Bun.ServerWebSocket<SocketData>,
  message: ServerMessage,
): void {
  socket.send(JSON.stringify(message));
}

function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .slice(0, 18);
}

function stationName(station: Station): string {
  switch (station) {
    case "streamdeck":
      return "Stream Deck";
    case "uf8":
      return "UF8";
    case "push":
      return "Push";
  }
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 4179;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return parsed;
}

function findPhoneUrls(serverPort: number): readonly string[] {
  const urls: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    if (addresses === undefined) {
      continue;
    }
    for (const address of addresses) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${serverPort}`);
      }
    }
  }
  return urls.length > 0 ? urls : [`http://localhost:${serverPort}`];
}

function connectedMissionStations(): MissionStations | null {
  const connected = connectedCrewStations(crew);
  const first = connected[0];
  const second = connected[1];
  if (first === undefined || second === undefined) {
    return null;
  }
  const third = connected[2];
  return third === undefined ? [first, second] : [first, second, third];
}

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(tickInterval);
  await server.stop(true);
  await uf8.stop();
}
