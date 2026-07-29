// Synthteam hardware bridge for the Ableton Push 3 — all JS.
//
// Connects the physical Push directly to the Synthteam server as a
// dedicated `push-join` hardware client and runs the Push station's
// activities on the hardware:
//
//   push-path    trace the lit vector across the pads (server-checked;
//                pad events are forwarded as hardware-events)
//   push-defend  DEFEND THE MOTHERSHIP — the server declares the
//                activity with missile parameters, the bridge runs the
//                minigame locally: missiles climb the pad columns,
//                pressing their pad intercepts them, impacts wound the
//                saucer on screen. Survive until the task deadline and
//                the server completes it; if the local hull reaches
//                zero the bridge reports push-defend-failed, which the
//                server treats like an expired order.
//
// The screen shows mission state throughout: lobby/countdown/score/
// integrity/deadlines, the vector path or the mothership, and a HULL
// BREACH flash whenever the ship takes damage. The button row above
// the pads (CC 102-109) is the defend activity's hull bar.
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
const EXPLOSION_MS = 220;
const IMPACT_FLASH_MS = 700;

// Our saucer, filling the full width of the screen: gray upper dome
// (cropped by the top edge), a rim of glowing windows, and a yellow
// bottom hemisphere with landing lights. 48 columns: 1 hull, 4 dome,
// 2 rim windows, 3 under-dome lights, 5 yellow hemisphere.
const SHIP_SPRITE = [
  "0".repeat(16) + "4".repeat(16) + "0".repeat(16),
  "0".repeat(12) + "4".repeat(24) + "0".repeat(12),
  "0".repeat(4) + "1".repeat(40) + "0".repeat(4),
  "11" + "2211".repeat(11) + "11",
  "1".repeat(48),
  "0".repeat(6) + "1".repeat(36) + "0".repeat(6),
  "0".repeat(14) + "5".repeat(20) + "0".repeat(14),
  "0".repeat(17) + "55335533553355" + "0".repeat(17),
  "0".repeat(20) + "5".repeat(8) + "0".repeat(20),
];
const SHIP_COLORS = {
  1: [105, 115, 135],
  2: [255, 220, 140],
  3: [255, 240, 180],
  4: [70, 78, 95],
  5: [235, 190, 40],
};
const SHIP_SCALE_X = WIDTH / SHIP_SPRITE[0].length;
const SHIP_SCALE_Y = 10;

const serverArg = process.argv.indexOf("--server");
const serverUrl =
  serverArg >= 0 ? process.argv[serverArg + 1] : "ws://127.0.0.1:4179/ws";

const push = await Push3.open();
console.log("push bridge: hardware linked");

let connected = false;
let phase = { kind: "lobby" };
let task = null;
let activeGridSize = 0;
let missionFlashUntil = 0; // full-screen breach flash (path mode only)
let lastIntegrity = null;
let socket = null;
const litPathPads = new Set();

// Local state for the running push-defend activity, or null.
let defend = null;

function initDefend(defendTask) {
  clearPadGrid();
  defend = {
    taskId: defendTask.id,
    missiles: [],   // {col, y: float 0..8 climbing}
    explosions: [], // {col, row, until, killed}
    wounds: [],     // ship damage {x, y} in sprite pixels
    hull: defendTask.hull,
    kills: 0,
    impactUntil: 0,
    failed: false,
    lastSpawn: performance.now(),
    lastTick: performance.now(),
  };
}

function endDefend() {
  if (defend === null) {
    return;
  }
  defend = null;
  clearPadGrid();
}

function clearPadGrid() {
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      push.setPad(x, y, PAD_COLORS.off);
    }
  }
  litPathPads.clear();
  litDefendPads.clear();
}

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
    activeGridSize = 0;
    lastIntegrity = null;
    endDefend();
    lightTask(null);
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
  // During a defend activity the pads are the interceptor battery,
  // handled locally; otherwise they belong to the server.
  if (defend !== null && task?.kind === "push-defend") {
    if (down && !defend.failed) {
      interceptAt(x, y);
    }
    return;
  }
  if (x >= activeGridSize || y >= activeGridSize) {
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
  activeGridSize = state.activeGridSize;

  if (task?.kind === "push-defend" && phase.kind === "playing") {
    if (defend === null || defend.taskId !== task.id) {
      initDefend(task);
    }
  } else {
    endDefend();
  }

  const integrity = phase.kind === "playing" ? phase.integrity : null;
  if (
    defend === null &&
    integrity !== null &&
    lastIntegrity !== null &&
    integrity < lastIntegrity
  ) {
    missionFlashUntil = performance.now() + HULL_FLASH_MS;
  }
  lastIntegrity = integrity;

  if (defend === null) {
    lightTask(task);
  }
}

/** Show the playable region, then overlay the current path or corner targets. */
function lightTask(activeTask) {
  const wanted = new Map();
  for (let x = 0; x < activeGridSize; x++) {
    for (let y = 0; y < activeGridSize; y++) {
      wanted.set(y * 8 + x, PAD_COLORS.blue);
    }
  }
  if (activeTask?.kind === "push-path") {
    const [led] = PATH_COLORS[activeTask.color] ?? [PAD_COLORS.white];
    activeTask.path.forEach((point, index) => {
      if (index < activeTask.progress) {
        return; // already traced
      }
      const key = point.y * 8 + point.x;
      wanted.set(key, index === activeTask.progress ? PAD_COLORS.white : led);
    });
  } else if (activeTask?.kind === "push-corners") {
    const farEdge = activeTask.gridSize - 1;
    for (const point of [
      { x: 0, y: 0 },
      { x: farEdge, y: 0 },
      { x: 0, y: farEdge },
      { x: farEdge, y: farEdge },
    ]) {
      const pressed = activeTask.pressed.some(
        (candidate) => candidate.x === point.x && candidate.y === point.y,
      );
      wanted.set(
        point.y * 8 + point.x,
        pressed ? PAD_COLORS.green : PAD_COLORS.white,
      );
    }
  }
  for (const key of litPathPads) {
    if (!wanted.has(key)) {
      push.setPad(key % 8, Math.floor(key / 8), PAD_COLORS.off);
    }
  }
  litPathPads.clear();
  for (const [key, color] of wanted) {
    push.setPad(key % 8, Math.floor(key / 8), color);
    litPathPads.add(key);
  }
}

// ---- Defend activity simulation ----

function interceptAt(x, y) {
  const now = performance.now();
  const hit = defend.missiles.findIndex(
    (missile) => missile.col === x && Math.floor(missile.y) === y,
  );
  if (hit >= 0) {
    defend.missiles.splice(hit, 1);
    defend.kills++;
    defend.explosions.push({
      col: x, row: y, until: now + EXPLOSION_MS, killed: true,
    });
  } else {
    defend.explosions.push({ col: x, row: y, until: now + 100, killed: false });
  }
}

function woundShip() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const y = Math.floor(Math.random() * SHIP_SPRITE.length);
    const x = Math.floor(Math.random() * SHIP_SPRITE[0].length);
    if (SHIP_SPRITE[y][x] !== "0" &&
        !defend.wounds.some((hole) => hole.x === x && hole.y === y)) {
      defend.wounds.push({ x, y });
      if (Math.random() < 0.6 && attempt < 29) {
        continue; // impacts usually tear more than one hole
      }
      return;
    }
  }
}

function tickDefend() {
  if (defend === null || task?.kind !== "push-defend" || defend.failed) {
    return;
  }
  const now = performance.now();
  const dt = (now - defend.lastTick) / 1000;
  defend.lastTick = now;

  // No fresh launches once the survival clock has run out
  const clockRunning = Date.now() < task.deadlineAt;
  if (clockRunning && now - defend.lastSpawn > task.spawnIntervalMs) {
    const busyCols = new Set(
      defend.missiles
        .filter((missile) => missile.y < 1.5)
        .map((missile) => missile.col),
    );
    const freeCols = [...Array(8).keys()].filter((col) => !busyCols.has(col));
    if (freeCols.length > 0) {
      const col = freeCols[Math.floor(Math.random() * freeCols.length)];
      defend.missiles.push({ col, y: 0.01 });
      defend.lastSpawn = now;
    }
  }

  for (const missile of defend.missiles) {
    missile.y += task.missileSpeed * dt;
  }

  const impacts = defend.missiles.filter((missile) => missile.y >= 8);
  if (impacts.length > 0) {
    defend.missiles = defend.missiles.filter((missile) => missile.y < 8);
    defend.hull -= impacts.length;
    defend.impactUntil = now + IMPACT_FLASH_MS;
    for (const _ of impacts) {
      woundShip();
    }
    if (defend.hull <= 0) {
      defend.hull = 0;
      defend.failed = true;
      defend.missiles = [];
      if (connected) {
        socket.send(
          JSON.stringify({
            type: "hardware-event",
            event: { kind: "push-defend-failed" },
          }),
        );
      }
    }
  }

  defend.explosions = defend.explosions.filter(
    (explosion) => explosion.until > now,
  );
}

// ---- Pad LEDs for the defend battle ----

const litDefendPads = new Map();

function renderDefendPads() {
  if (defend === null) {
    return;
  }
  const wanted = new Map();
  if (!defend.failed) {
    for (const missile of defend.missiles) {
      wanted.set(Math.floor(missile.y) * 8 + missile.col, PAD_COLORS.red);
    }
    for (const explosion of defend.explosions) {
      wanted.set(
        explosion.row * 8 + explosion.col,
        explosion.killed ? PAD_COLORS.white : PAD_COLORS.amber,
      );
    }
  }
  for (const [key, color] of litDefendPads) {
    if (wanted.get(key) !== color && !wanted.has(key)) {
      push.setPad(key % 8, Math.floor(key / 8), PAD_COLORS.off);
      litDefendPads.delete(key);
    }
  }
  for (const [key, color] of wanted) {
    if (litDefendPads.get(key) !== color) {
      push.setPad(key % 8, Math.floor(key / 8), color);
      litDefendPads.set(key, color);
    }
  }
}

// ---- Button backlights: CC 102-109 is the defend hull bar ----

const BUTTON_ROW = [102, 103, 104, 105, 106, 107, 108, 109];
const litButtons = new Map();

function renderButtons() {
  const now = performance.now();
  for (const [index, cc] of BUTTON_ROW.entries()) {
    let color = PAD_COLORS.off;
    if (defend !== null) {
      if (defend.failed || now < defend.impactUntil) {
        color = PAD_COLORS.red;
      } else if (index < defend.hull) {
        color = PAD_COLORS.yellow;
      }
    }
    if (litButtons.get(cc) !== color) {
      push.setButton(cc, color);
      litButtons.set(cc, color);
    }
  }
}

// ---- Screen ----

const buffer = Buffer.alloc(WIDTH * HEIGHT * 4);
buffer.fill(255);

function centered(text, y, scale, color) {
  drawText(buffer, WIDTH, text,
    (WIDTH - textWidth(text, scale)) / 2, y, scale, color);
}

function drawShip(now) {
  const shipY = -SHIP_SCALE_Y * 1.5 + Math.sin(now / 450) * 4;
  const flashing = defend !== null && now < defend.impactUntil;
  const windowPulse = 0.7 + 0.3 * Math.sin(now / 300);
  const wounds = defend?.wounds ?? [];
  const critical = defend !== null && defend.hull <= 2;

  for (let row = 0; row < SHIP_SPRITE.length; row++) {
    for (let col = 0; col < SHIP_SPRITE[row].length; col++) {
      const cell = SHIP_SPRITE[row][col];
      if (cell === "0") {
        continue;
      }
      let color = SHIP_COLORS[cell];
      if (cell === "2") {
        color = color.map((c) => Math.round(c * windowPulse));
      }
      if (cell === "3" && Math.sin(now / 120 + col) > 0) {
        color = [140, 100, 20]; // landing lights blink
      }
      if (wounds.some((hole) => hole.x === col && hole.y === row)) {
        color = Math.sin(now / 90 + col * 3 + row) > 0.3
          ? [255, 120, 20]  // embers glow in the wounds
          : [30, 20, 18];
      } else if (flashing) {
        color = [255, 255, 255];
      } else if (critical) {
        color = color.map((c) => Math.round(c * 0.75));
      }
      fillRect(buffer, WIDTH,
        col * SHIP_SCALE_X, shipY + row * SHIP_SCALE_Y,
        SHIP_SCALE_X, SHIP_SCALE_Y, ...color);
    }
  }
  return shipY + SHIP_SPRITE.length * SHIP_SCALE_Y;
}

function renderDefendScreen(now) {
  const impact = now < defend.impactUntil;
  fillRect(buffer, WIDTH, 0, 0, WIDTH, HEIGHT,
    impact ? 90 + Math.round(50 * Math.sin(now / 25)) : 8, 12, impact ? 12 : 24);

  const shipBottom = drawShip(now);

  if (defend.failed) {
    centered("MOTHERSHIP HIT - ACTIVITY FAILED", 104, 4, [224, 85, 85]);
    return;
  }

  for (const missile of defend.missiles) {
    const x = ((missile.col + 0.5) / 8) * WIDTH;
    const headY = HEIGHT - (missile.y / 8) * (HEIGHT - shipBottom);
    for (let segment = 0; segment < 5; segment++) {
      const fade = 1 - segment / 5;
      fillRect(buffer, WIDTH,
        x - 4, headY + segment * 9, 8, 7,
        Math.round(255 * fade), Math.round(40 * fade), Math.round(30 * fade));
    }
  }
  for (const explosion of defend.explosions.filter((e) => e.killed)) {
    const x = ((explosion.col + 0.5) / 8) * WIDTH;
    const grow = 1 - (explosion.until - now) / EXPLOSION_MS;
    const radius = 8 + grow * 22;
    const y = HEIGHT - ((explosion.row + 0.5) / 8) * (HEIGHT - shipBottom);
    fillRect(buffer, WIDTH, x - radius, y - radius / 2,
      radius * 2, radius, 255, Math.round(220 - 120 * grow), 60);
  }

  drawText(buffer, WIDTH, "HULL", 16, HEIGHT - 44, 2, [140, 150, 173]);
  fillRect(buffer, WIDTH, 16, HEIGHT - 24, 220, 14, 60, 66, 82);
  fillRect(buffer, WIDTH, 18, HEIGHT - 22, 216 * (defend.hull / task.hull), 10,
    235, 190, 40);
  const secondsLeft = Math.max(0, (task.deadlineAt - Date.now()) / 1000);
  centered("DEFEND THE MOTHERSHIP", HEIGHT - 56, 2, [140, 150, 173]);
  centered(`${Math.ceil(secondsLeft)}S`, HEIGHT - 36, 4,
    secondsLeft < 4 ? [255, 230, 0] : [200, 205, 215]);
  drawText(buffer, WIDTH, `SCORE ${phase.score}`,
    WIDTH - textWidth(`SCORE ${phase.score}`, 4) - 16, HEIGHT - 32, 4,
    [127, 212, 255]);
  if (impact) {
    centered("HULL BREACH!", HEIGHT - 76, 5, [255, 255, 255]);
  }
}

function renderPathScreen(now) {
  fillRect(buffer, WIDTH, 0, 0, WIDTH, HEIGHT, 8, 12, 24);

  const cell = 17;
  const gridX = 12;
  const gridY = 8;
  for (let gx = 0; gx < 8; gx++) {
    for (let gy = 0; gy < 8; gy++) {
      const active = gx < activeGridSize && gy < activeGridSize;
      fillRect(buffer, WIDTH,
        gridX + gx * cell, gridY + (7 - gy) * cell,
        cell - 3, cell - 3, ...(active ? [20, 26, 42] : [5, 7, 10]));
    }
  }
  if (task?.kind === "push-path") {
    const [, rgb] = PATH_COLORS[task.color] ?? [0, [255, 255, 255]];
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
  } else if (task?.kind === "push-corners") {
    const farEdge = task.gridSize - 1;
    for (const point of [
      { x: 0, y: 0 },
      { x: farEdge, y: 0 },
      { x: 0, y: farEdge },
      { x: farEdge, y: farEdge },
    ]) {
      const pressed = task.pressed.some(
        (candidate) => candidate.x === point.x && candidate.y === point.y,
      );
      fillRect(buffer, WIDTH,
        gridX + point.x * cell, gridY + (7 - point.y) * cell,
        cell - 3, cell - 3, ...(pressed ? [70, 214, 140] : [255, 255, 255]));
    }
    drawText(buffer, WIDTH, "CORNERS!", 170, 12, 5, [150, 255, 40]);
    drawText(buffer, WIDTH, `${task.pressed.length}/4 HIT`, 170, 54, 3,
      [200, 205, 215]);
  } else {
    drawText(buffer, WIDTH, "STANDBY", 170, 26, 6, [140, 150, 173]);
  }
  drawText(buffer, WIDTH, `SCORE ${phase.score}`, 430, 12, 4, [127, 212, 255]);
  if (phase.combo > 1) {
    drawText(buffer, WIDTH, `COMBO X${phase.combo}`, 430, 52, 3, [255, 230, 0]);
  }
  const integrity = Math.max(0, Math.min(100, phase.integrity));
  const barColor = integrity > 50 ? [70, 214, 140]
    : integrity > 25 ? [255, 160, 0] : [224, 85, 85];
  drawText(buffer, WIDTH, "INTEGRITY", 660, 12, 2, [140, 150, 173]);
  fillRect(buffer, WIDTH, 660, 34, 280, 18, 60, 66, 82);
  fillRect(buffer, WIDTH, 662, 36, 276 * (integrity / 100), 14, ...barColor);
  drawText(buffer, WIDTH,
    `LEVEL ${phase.level}  ${phase.levelObjectivesCompleted}/${phase.levelObjectiveTarget}`,
    660, 66, 2,
    [140, 150, 173]);
  if (task !== null) {
    const orderLeft = Math.max(0, task.deadlineAt / 1000 - Date.now() / 1000);
    drawText(buffer, WIDTH, `INPUT EXPIRES ${orderLeft.toFixed(1)}S`, 170, 100, 3,
      orderLeft < 3 ? [224, 85, 85] : [140, 150, 173]);
  }
}

function renderScreen() {
  const now = performance.now();

  if (defend === null && now < missionFlashUntil) {
    const pulse = Math.round(160 + 95 * Math.sin(now / 33));
    fillRect(buffer, WIDTH, 0, 0, WIDTH, HEIGHT, pulse, 0, 0);
    const text = "HULL BREACH!";
    centered(text, (HEIGHT - 7 * 12) / 2 + Math.cos(now / 16) * 5, 12,
      [255, 255, 255]);
    void push.display.rgba(buffer);
    return;
  }

  switch (phase.kind) {
    case "lobby": {
      fillRect(buffer, WIDTH, 0, 0, WIDTH, HEIGHT, 8, 12, 24);
      drawText(buffer, WIDTH, "SYNTHTEAM", 20, 24, 11, [127, 212, 255]);
      drawText(buffer, WIDTH,
        `PUSH STATION - ${connected ? "LINKED TO CENTRAL" : "WAITING FOR CENTRAL"}`,
        22, 118, 3, connected ? [140, 150, 173] : [224, 85, 85]);
      break;
    }
    case "countdown": {
      fillRect(buffer, WIDTH, 0, 0, WIDTH, HEIGHT, 8, 12, 24);
      const remaining = Math.max(0, Math.ceil(phase.endsAt / 1000 - Date.now() / 1000));
      centered(String(remaining), (HEIGHT - 7 * 18) / 2, 18, [255, 230, 0]);
      break;
    }
    case "playing": {
      if (defend !== null && task?.kind === "push-defend") {
        renderDefendScreen(now);
      } else {
        renderPathScreen(now);
      }
      break;
    }
    case "game-over": {
      fillRect(buffer, WIDTH, 0, 0, WIDTH, HEIGHT, 8, 12, 24);
      const survived = phase.reason === "survived";
      const text = survived ? "MISSION SURVIVED" : "SHIP LOST";
      const color = survived ? [70, 214, 140] : [224, 85, 85];
      centered(text, 26, 9, color);
      centered(`FINAL SCORE ${phase.score}`, 110, 4, [200, 205, 215]);
      break;
    }
  }
  void push.display.rgba(buffer);
}

const timer = setInterval(() => {
  tickDefend();
  renderDefendPads();
  renderButtons();
  renderScreen();
}, 33);

process.on("SIGINT", () => {
  clearInterval(timer);
  for (const cc of BUTTON_ROW) {
    push.setButton(cc, PAD_COLORS.off);
  }
  void push.close().then(() => process.exit(0));
});
