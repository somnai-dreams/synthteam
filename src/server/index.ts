import app from "../client/index.html";
import { networkInterfaces } from "node:os";
import {
  advanceMission,
  applyHardwareEvent,
  createMission,
} from "../game/mission.ts";
import type {
  CrewMember,
  CrewSlots,
  HardwareEvent,
  MissionOutcome,
  MissionState,
  Station,
  StreamDeckRouteTask,
} from "../shared/domain.ts";
import { STATIONS } from "../shared/domain.ts";
import type {
  ActivityItem,
  ClientMessage,
  ConsoleSnapshot,
  MissionPhaseView,
  PhoneSnapshot,
  ServerMessage,
  ViewSnapshot,
} from "../shared/protocol.ts";
import {
  parseClientMessage,
  publicOrderForReader,
} from "../shared/protocol.ts";

type ViewerIdentity =
  | { kind: "anonymous" }
  | { kind: "phone"; crewId: string; station: Station }
  | { kind: "console" }
  | { kind: "streamdeck" };

type SocketData = {
  viewer: ViewerIdentity;
};

type GameState =
  | { kind: "lobby" }
  | { kind: "countdown"; endsAt: number }
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
let game: GameState = { kind: "lobby" };

const port = parsePort(Bun.env["PORT"]);
const phoneUrls = findPhoneUrls(port);
const server = Bun.serve<SocketData>({
  hostname: "0.0.0.0",
  port,
  routes: {
    "/": app,
    "/console": app,
    "/health": () => Response.json({ ok: true }),
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
      if (viewer.kind === "streamdeck") {
        broadcastSnapshots();
        return;
      }
      if (viewer.kind !== "phone") {
        return;
      }
      const member = crew[viewer.station];
      if (member !== null && member.id === viewer.crewId) {
        member.connected = false;
        addActivity(`${member.name} lost signal`, "danger");
        broadcastSnapshots();
      }
    },
  },
});

setInterval(tick, 50);

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
    case "phone-join":
      joinPhone(socket, message.name, message.station, message.resumeCrewId);
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
      recordOutcomes(
        applyHardwareEvent(game.mission, message.event, Date.now()).outcomes,
      );
      broadcastSnapshots();
      return;
  }
}

function joinPhone(
  socket: Bun.ServerWebSocket<SocketData>,
  rawName: string,
  station: Station,
  resumeCrewId: string | null,
): void {
  const name = normalizeName(rawName);
  if (name.length === 0) {
    send(socket, { type: "error", message: "Enter a crew name" });
    return;
  }

  const existing = crew[station];
  if (existing !== null && existing.id === resumeCrewId) {
    existing.connected = true;
    socket.data.viewer = {
      kind: "phone",
      crewId: existing.id,
      station,
    };
    addActivity(
      `${existing.name} reconnected to ${stationName(station)}`,
      "success",
    );
    broadcastSnapshots();
    return;
  }
  if (existing !== null && existing.connected) {
    send(socket, {
      type: "error",
      message: `${stationName(station)} already has an operator`,
    });
    return;
  }
  if (game.kind !== "lobby") {
    send(socket, {
      type: "error",
      message: "New crew can only join from the lobby",
    });
    return;
  }

  const member: CrewMember = {
    id: crypto.randomUUID(),
    name,
    station,
    connected: true,
  };
  crew[station] = member;
  socket.data.viewer = { kind: "phone", crewId: member.id, station };
  addActivity(`${name} claimed ${stationName(station)}`, "success");
  broadcastSnapshots();
}

function startCountdown(socket: Bun.ServerWebSocket<SocketData>): void {
  const missing = STATIONS.filter((station) => crew[station]?.connected !== true);
  if (missing.length > 0) {
    send(socket, {
      type: "error",
      message: `Waiting for ${missing.map(stationName).join(", ")}`,
    });
    return;
  }
  game = { kind: "countdown", endsAt: Date.now() + 3_000 };
  addActivity("Mission begins in three", "neutral");
  broadcastSnapshots();
}

function tick(): void {
  const now = Date.now();
  switch (game.kind) {
    case "lobby":
    case "game-over":
      return;
    case "countdown":
      if (now >= game.endsAt) {
        game = { kind: "playing", mission: createMission(now) };
        addActivity("All systems live", "success");
        broadcastSnapshots();
      }
      return;
    case "playing": {
      const outcomes = advanceMission(game.mission, now).outcomes;
      if (outcomes.length > 0) {
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
  send(socket, { type: "snapshot", snapshot: snapshotFor(socket.data.viewer) });
}

function broadcastSnapshots(): void {
  for (const socket of sockets) {
    sendSnapshot(socket);
  }
}

function snapshotFor(
  viewer: Exclude<ViewerIdentity, { kind: "streamdeck" }>,
): ViewSnapshot {
  const base = {
    crew,
    phase: phaseView(),
    activity,
    phoneUrls,
    streamDeckConnected: sockets.some(
      (socket) => socket.data.viewer.kind === "streamdeck",
    ),
  };
  switch (viewer.kind) {
    case "anonymous":
      return { ...base, viewer };
    case "phone": {
      const snapshot: PhoneSnapshot = {
        ...base,
        viewer,
        order:
          game.kind === "playing"
            ? publicOrderForReader(game.mission, viewer.station)
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
                tasks: game.mission.tasks,
                streamDeckKeys: game.mission.streamDeckKeys,
              }
            : null,
      };
      return snapshot;
    }
  }
}

function streamDeckState() {
  if (game.kind !== "playing") {
    return { keys: [], task: null };
  }
  const task = game.mission.tasks.find(
    (candidate): candidate is StreamDeckRouteTask =>
      candidate.kind === "streamdeck-route",
  );
  if (task === undefined) {
    throw new Error("Playing mission has no Stream Deck task");
  }
  return {
    keys: game.mission.streamDeckKeys,
    task,
  };
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
    return 3000;
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
