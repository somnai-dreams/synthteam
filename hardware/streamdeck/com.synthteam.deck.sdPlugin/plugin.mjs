const args = parseArguments(process.argv.slice(2));
const sdkPort = args.get("-port");
const pluginUUID = args.get("-pluginUUID");
const registerEvent = args.get("-registerEvent");

if (sdkPort === undefined || pluginUUID === undefined || registerEvent === undefined) {
  throw new Error("Stream Deck did not provide the required plugin arguments");
}

const gameUrl =
  process.env.SYNTHTEAM_SERVER_URL ?? "ws://127.0.0.1:4179/ws";
const contexts = new Map();
let sdkSocket = null;
let gameSocket = null;
let reconnectTimer = null;
let gameState = { keys: [], task: null };

connectSdk();
connectGame();

function connectSdk() {
  sdkSocket = new WebSocket(`ws://127.0.0.1:${sdkPort}`);
  sdkSocket.addEventListener("open", () => {
    sendSdk({ event: registerEvent, uuid: pluginUUID });
  });
  sdkSocket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = parseJson(event.data);
    if (message === null || typeof message.event !== "string") return;
    handleSdkMessage(message);
  });
}

function connectGame() {
  gameSocket = new WebSocket(gameUrl);
  gameSocket.addEventListener("open", () => {
    sendGame({ type: "streamdeck-join" });
  });
  gameSocket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    const message = parseJson(event.data);
    if (
      message === null ||
      message.type !== "streamdeck-state" ||
      !isGameState(message.state)
    ) {
      return;
    }
    gameState = message.state;
    renderAll();
  });
  gameSocket.addEventListener("close", scheduleReconnect);
  gameSocket.addEventListener("error", scheduleReconnect);
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectGame();
  }, 1_000);
}

function handleSdkMessage(message) {
  switch (message.event) {
    case "willAppear": {
      const index = keyIndex(message);
      if (index === null || typeof message.context !== "string") return;
      contexts.set(message.context, index);
      renderContext(message.context, index);
      return;
    }
    case "willDisappear":
      if (typeof message.context === "string") {
        contexts.delete(message.context);
      }
      return;
    case "keyDown":
    case "keyUp": {
      const index = keyIndex(message);
      if (index === null) return;
      sendGame({
        type: "hardware-event",
        event: {
          kind: "streamdeck-key",
          keyIndex: index,
          phase: message.event === "keyDown" ? "down" : "up",
        },
      });
      return;
    }
  }
}

function renderAll() {
  for (const [context, index] of contexts) {
    renderContext(context, index);
  }
}

function renderContext(context, index) {
  const key = gameState.keys.find((candidate) => candidate.index === index);
  const isLockedSource =
    gameState.task !== null &&
    gameState.task.progress === 1 &&
    gameState.task.sourceKeyIndex === index;
  const label = key?.label ?? "STANDBY";
  const color = isLockedSource ? "#82eb92" : colorValue(key?.color);
  const background = key === undefined ? "#0b0f12" : "#10161a";
  const image = svgDataUrl(label, color, background, isLockedSource);
  sendSdk({
    context,
    event: "setImage",
    payload: { image },
  });
}

function svgDataUrl(label, color, background, active) {
  const safeLabel = escapeXml(label);
  const ring = active
    ? `<rect x="5" y="5" width="134" height="134" rx="18" fill="none" stroke="${color}" stroke-width="6"/>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
    <rect width="144" height="144" rx="18" fill="${background}"/>
    <rect x="14" y="14" width="116" height="5" rx="2.5" fill="${color}"/>
    ${ring}
    <text x="72" y="77" fill="#f0f3ed" font-family="Arial Narrow,Arial,sans-serif" font-size="21" font-weight="700" text-anchor="middle">${safeLabel}</text>
    <circle cx="72" cy="112" r="5" fill="${color}"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function keyIndex(message) {
  const coordinates = message.payload?.coordinates;
  if (
    coordinates === undefined ||
    !Number.isInteger(coordinates.column) ||
    !Number.isInteger(coordinates.row)
  ) {
    return null;
  }
  const index = coordinates.row * 8 + coordinates.column;
  return index >= 0 && index < 32 ? index : null;
}

function sendSdk(message) {
  if (sdkSocket?.readyState === WebSocket.OPEN) {
    sdkSocket.send(JSON.stringify(message));
  }
}

function sendGame(message) {
  if (gameSocket?.readyState === WebSocket.OPEN) {
    gameSocket.send(JSON.stringify(message));
  }
}

function colorValue(color) {
  switch (color) {
    case "cyan":
      return "#5ce1e6";
    case "amber":
      return "#ffb340";
    case "magenta":
      return "#ed65ff";
    case "green":
      return "#82eb92";
    default:
      return "#526069";
  }
}

function isGameState(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray(value.keys) &&
    (value.task === null ||
      (typeof value.task === "object" &&
        value.task !== null &&
        value.task.kind === "streamdeck-route"))
  );
}

function parseArguments(values) {
  const result = new Map();
  for (let index = 0; index < values.length - 1; index += 2) {
    result.set(values[index], values[index + 1]);
  }
  return result;
}

function parseJson(raw) {
  try {
    const value = JSON.parse(raw);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
