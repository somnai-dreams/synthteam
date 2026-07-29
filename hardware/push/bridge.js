// Synthteam hardware bridge for the Ableton Push 3 — all JS.
//
// Connects the physical Push directly to the Synthteam server as a
// dedicated `push-join` hardware client. Drives pads and path LEDs
// over MIDI plus the 960x160 display over USB: mission phase, the
// live vector path, score, integrity, deadlines, and a HULL BREACH
// flash whenever the ship takes damage.
//
// Run:  bun bridge.js  [--server ws://127.0.0.1:4179/ws]

import { drawText, fillRect, textWidth } from "./font.js";
import { HEIGHT, PAD_COLORS, Push3, WIDTH } from "./push3.js";

// Push palette index + screen RGB for each PushPathColor the game uses.
const PATH_COLORS = {
  violet: [PAD_COLORS.violet, [170, 80, 255]],
  cyan: [PAD_COLORS.cyan, [0, 220, 220]],
  amber: [PAD_COLORS.amber, [255, 160, 0]],
  lime: [PAD_COLORS.lime, [150, 255, 40]],
};

const HULL_FLASH_MS = 1500;

const serverArg = process.argv.indexOf("--server");
const serverUrl =
  serverArg >= 0 ? process.argv[serverArg + 1] : "ws://127.0.0.1:4179/ws";

const push = await Push3.open();
console.log("push bridge: hardware linked");

let connected = false;
let phase = { kind: "lobby" };
let task = null;
let flashUntil = 0;
let lastIntegrity = null;
let socket = null;
const litPads = new Set();

connect();

function connect() {
  socket = new WebSocket(serverUrl);
  socket.onopen = () => {
    connected = true;
    socket.send(JSON.stringify({ type: "push-join" }));
    console.log("push bridge: joined", serverUrl);
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "push-state") {
      applyState(message.state);
    }
  };
  socket.onclose = () => {
    if (connected) {
      console.log("push bridge: server lost, retrying");
    }
    connected = false;
    phase = { kind: "lobby" };
    task = null;
    lastIntegrity = null;
    lightPath(null);
    setTimeout(connect, 1000);
  };
  socket.onerror = () => {};
}

setInterval(() => {
  if (connected) {
    socket.send(JSON.stringify({ type: "ping" }));
  }
}, 30_000);

push.on("pad", ({ x, y, down, velocity }) => {
  if (!connected) {
    return;
  }
  socket.send(
    JSON.stringify({
      type: "hardware-event",
      event: {
        kind: "push-pad",
        point: { x, y },
        phase: down ? "down" : "up",
        velocity,
      },
    }),
  );
});

function applyState(state) {
  phase = state.phase;
  task = state.task;
  const integrity = phase.kind === "playing" ? phase.integrity : null;
  if (integrity !== null && lastIntegrity !== null && integrity < lastIntegrity) {
    flashUntil = performance.now() + HULL_FLASH_MS;
  }
  lastIntegrity = integrity;
  lightPath(task);
}

/** Light the remaining path in its color; the next expected pad is white. */
function lightPath(pathTask) {
  const wanted = new Map();
  if (pathTask !== null) {
    const [led] = PATH_COLORS[pathTask.color] ?? [PAD_COLORS.white];
    pathTask.path.forEach((point, index) => {
      if (index < pathTask.progress) {
        return; // already traced
      }
      const key = point.y * 8 + point.x;
      wanted.set(key, index === pathTask.progress ? PAD_COLORS.white : led);
    });
  }
  for (const key of litPads) {
    if (!wanted.has(key)) {
      push.setPad(key % 8, Math.floor(key / 8), PAD_COLORS.off);
    }
  }
  litPads.clear();
  for (const [key, color] of wanted) {
    push.setPad(key % 8, Math.floor(key / 8), color);
    litPads.add(key);
  }
}

// ---- Screen ----

const buffer = Buffer.alloc(WIDTH * HEIGHT * 4);
buffer.fill(255);

const timer = setInterval(render, 33);

function render() {
  const now = performance.now();

  if (now < flashUntil) {
    const pulse = Math.round(160 + 95 * Math.sin(now / 33));
    fillRect(buffer, WIDTH, 0, 0, WIDTH, HEIGHT, pulse, 0, 0);
    const scale = 14;
    const text = "HULL BREACH!";
    drawText(buffer, WIDTH, text,
      (WIDTH - textWidth(text, scale)) / 2 + Math.sin(now / 21) * 8,
      (HEIGHT - 7 * scale) / 2 + Math.cos(now / 16) * 5,
      scale, [255, 255, 255]);
    void push.display.rgba(buffer);
    return;
  }

  fillRect(buffer, WIDTH, 0, 0, WIDTH, HEIGHT, 8, 12, 24);

  switch (phase.kind) {
    case "lobby": {
      drawText(buffer, WIDTH, "SYNTHTEAM", 20, 24, 11, [127, 212, 255]);
      drawText(buffer, WIDTH,
        `PUSH STATION - ${connected ? "LINKED TO CENTRAL" : "WAITING FOR CENTRAL"}`,
        22, 118, 3, connected ? [140, 150, 173] : [224, 85, 85]);
      break;
    }
    case "countdown": {
      const remaining = Math.max(0, Math.ceil(phase.endsAt / 1000 - Date.now() / 1000));
      const text = String(remaining);
      const scale = 18;
      drawText(buffer, WIDTH, text,
        (WIDTH - textWidth(text, scale)) / 2, (HEIGHT - 7 * scale) / 2,
        scale, [255, 230, 0]);
      break;
    }
    case "playing": {
      if (task === null) {
        drawText(buffer, WIDTH, "STANDBY", 340, 55, 10, [140, 150, 173]);
        break;
      }
      const [, rgb] = PATH_COLORS[task.color] ?? [0, [255, 255, 255]];
      // Mini grid mirroring the pads
      const cell = 17;
      const gridX = 12;
      const gridY = 8;
      for (let gx = 0; gx < 8; gx++) {
        for (let gy = 0; gy < 8; gy++) {
          fillRect(buffer, WIDTH,
            gridX + gx * cell, gridY + (7 - gy) * cell,
            cell - 3, cell - 3, 20, 26, 42);
        }
      }
      task.path.forEach((point, index) => {
        const traced = index < task.progress;
        const isNext = index === task.progress;
        const color = traced ? [60, 66, 82] : isNext ? [255, 255, 255] : rgb;
        fillRect(buffer, WIDTH,
          gridX + point.x * cell, gridY + (7 - point.y) * cell,
          cell - 3, cell - 3, ...color);
      });
      drawText(buffer, WIDTH, `${task.color} VECTOR`, 170, 12, 4, rgb);
      drawText(buffer, WIDTH,
        `${task.progress}/${task.path.length} TRACED`, 170, 52, 3,
        [200, 205, 215]);
      drawText(buffer, WIDTH, `SCORE ${phase.score}`, 430, 12, 4, [127, 212, 255]);
      if (phase.combo > 1) {
        drawText(buffer, WIDTH, `COMBO X${phase.combo}`, 430, 52, 3, [255, 230, 0]);
      }
      // Integrity bar
      const integrity = Math.max(0, Math.min(100, phase.integrity));
      const barColor = integrity > 50 ? [70, 214, 140]
        : integrity > 25 ? [255, 160, 0] : [224, 85, 85];
      drawText(buffer, WIDTH, "INTEGRITY", 660, 12, 2, [140, 150, 173]);
      fillRect(buffer, WIDTH, 660, 34, 280, 18, 60, 66, 82);
      fillRect(buffer, WIDTH, 662, 36, 276 * (integrity / 100), 14, ...barColor);
      const missionLeft = Math.max(0, phase.endsAt / 1000 - Date.now() / 1000);
      drawText(buffer, WIDTH, `MISSION ${missionLeft.toFixed(0)}S`, 660, 66, 2,
        [140, 150, 173]);
      const orderLeft = Math.max(0, task.deadlineAt / 1000 - Date.now() / 1000);
      drawText(buffer, WIDTH, `ORDER EXPIRES ${orderLeft.toFixed(1)}S`, 170, 100, 3,
        orderLeft < 3 ? [224, 85, 85] : [140, 150, 173]);
      break;
    }
    case "game-over": {
      const survived = phase.reason === "survived";
      const text = survived ? "MISSION SURVIVED" : "SHIP LOST";
      const color = survived ? [70, 214, 140] : [224, 85, 85];
      const scale = 9;
      drawText(buffer, WIDTH, text,
        (WIDTH - textWidth(text, scale)) / 2, 26, scale, color);
      const sub = `FINAL SCORE ${phase.score}`;
      drawText(buffer, WIDTH, sub,
        (WIDTH - textWidth(sub, 4)) / 2, 110, 4, [200, 205, 215]);
      break;
    }
  }

  void push.display.rgba(buffer);
}

process.on("SIGINT", () => {
  clearInterval(timer);
  void push.close().then(() => process.exit(0));
});
