import type {
  ActiveTask,
  CrewSlots,
  GridPoint,
  HardwareEvent,
  Station,
} from "../shared/domain.ts";
import { STATIONS, stationForTask } from "../shared/domain.ts";
import type {
  ClientMessage,
  ConsoleSnapshot,
  MissionPhaseView,
  PhoneSnapshot,
  ViewSnapshot,
} from "../shared/protocol.ts";
import { parseServerMessage } from "../shared/protocol.ts";

type SavedCrew = {
  crewId: string;
  name: string;
  station: Station;
};

const appElement = document.querySelector<HTMLDivElement>("#app");
if (appElement === null) {
  throw new Error("App root is missing");
}
const app = appElement;

const isConsole = window.location.pathname === "/console";
let socket: WebSocket | null = null;
let snapshot: ViewSnapshot | null = null;
let errorMessage = "";
let savedCrew = loadSavedCrew();
let joinDraftName = "";
let joinDraftStation: Station | null = null;

connect();
setInterval(updateLiveNumbers, 100);
setInterval(() => send({ type: "ping" }), 30_000);

function connect(): void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket.addEventListener("open", () => {
    errorMessage = "";
    if (isConsole) {
      send({ type: "console-join" });
    } else if (savedCrew !== null) {
      send({
        type: "phone-join",
        name: savedCrew.name,
        station: savedCrew.station,
        resumeCrewId: savedCrew.crewId,
      });
    }
    render();
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      return;
    }
    const message = parseServerMessage(event.data);
    if (message === null) {
      throw new Error("Server sent an invalid message");
    }
    switch (message.type) {
      case "pong":
        return;
      case "error":
        errorMessage = message.message;
        render();
        return;
      case "snapshot":
        snapshot = message.snapshot;
        errorMessage = "";
        if (snapshot.viewer.kind === "phone") {
          const member = snapshot.crew[snapshot.viewer.station];
          if (member !== null) {
            savedCrew = {
              crewId: snapshot.viewer.crewId,
              name: member.name,
              station: snapshot.viewer.station,
            };
            saveCrew(savedCrew);
          }
        }
        render();
        return;
    }
  });
  socket.addEventListener("close", () => {
    errorMessage = "Signal lost. Reconnecting…";
    render();
    window.setTimeout(connect, 1_000);
  });
}

function render(): void {
  if (isConsole) {
    renderConsole();
  } else {
    renderPhone();
  }
}

function renderPhone(): void {
  if (snapshot === null || snapshot.viewer.kind === "anonymous") {
    if (
      snapshot?.viewer.kind === "anonymous" &&
      joinDraftStation !== null &&
      snapshot.crew[joinDraftStation]?.connected === true
    ) {
      joinDraftStation = null;
    }
    app.innerHTML = phoneJoinMarkup();
    bindPhoneJoin();
    return;
  }
  if (!isPhoneSnapshot(snapshot)) {
    throw new Error("Console snapshot reached phone route");
  }
  app.innerHTML = phoneShellMarkup(snapshot);
}

function phoneJoinMarkup(): string {
  const crew = snapshot?.crew ?? emptyCrew();
  return `
    <main class="join-screen">
      <header class="brand-block stagger-1">
        <div class="eyebrow">COOPERATIVE HARDWARE PANIC</div>
        <h1>SYNTH<span>/</span>TEAM</h1>
        <p>Claim a station. Read the order. Shout it to the crew member who has the right machine.</p>
      </header>
      <form id="join-form" class="join-card stagger-2">
        <label class="field-label" for="crew-name">CALL SIGN</label>
        <input id="crew-name" name="name" maxlength="18" autocomplete="nickname" placeholder="Enter your name" value="${escapeHtml(joinDraftName)}" required />
        <fieldset>
          <legend>YOUR STATION</legend>
          <div class="station-options">
            ${STATIONS.map((station) => stationOption(station, crew)).join("")}
          </div>
        </fieldset>
        ${errorMarkup()}
        <button class="primary-button" type="submit">CLAIM STATION <span>→</span></button>
      </form>
      <p class="join-note stagger-3">Your phone only shows orders. Actions must happen on the physical controls.</p>
    </main>
  `;
}

function stationOption(station: Station, crew: CrewSlots): string {
  const member = crew[station];
  const disabled = member?.connected === true;
  const checked = joinDraftStation === station && !disabled;
  return `
    <label class="station-option station-${station} ${disabled ? "is-taken" : ""}">
      <input type="radio" name="station" value="${station}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} required />
      <span class="station-indicator"></span>
      <strong>${stationShortName(station)}</strong>
      <small>${disabled ? `HELD BY ${escapeHtml(member.name)}` : stationRole(station)}</small>
    </label>
  `;
}

function bindPhoneJoin(): void {
  const form = document.querySelector<HTMLFormElement>("#join-form");
  const nameInput = document.querySelector<HTMLInputElement>("#crew-name");
  nameInput?.addEventListener("input", () => {
    joinDraftName = nameInput.value;
  });
  for (const input of document.querySelectorAll<HTMLInputElement>(
    'input[name="station"]',
  )) {
    input.addEventListener("change", () => {
      if (isStation(input.value)) {
        joinDraftStation = input.value;
      }
    });
  }
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const name = data.get("name");
    const station = data.get("station");
    if (typeof name !== "string" || !isStation(station)) {
      return;
    }
    joinDraftName = name;
    joinDraftStation = station;
    savedCrew = { crewId: "", name, station };
    send({
      type: "phone-join",
      name,
      station,
      resumeCrewId: null,
    });
  });
}

function phoneShellMarkup(phone: PhoneSnapshot): string {
  const member = phone.crew[phone.viewer.station];
  if (member === null) {
    throw new Error("Phone viewer has no crew member");
  }
  return `
    <main class="phone-shell station-${phone.viewer.station}">
      <header class="phone-topbar">
        <div>
          <div class="eyebrow">${stationShortName(phone.viewer.station)} CREW</div>
          <strong>${escapeHtml(member.name)}</strong>
        </div>
        <div class="signal-pill"><span></span> LINKED</div>
      </header>
      ${phonePhaseMarkup(phone)}
      <footer class="crew-strip">
        ${STATIONS.map((station) => crewChip(station, phone.crew)).join("")}
      </footer>
      ${errorMarkup()}
    </main>
  `;
}

function phonePhaseMarkup(phone: PhoneSnapshot): string {
  switch (phone.phase.kind) {
    case "lobby":
      return `
        <section class="waiting-state">
          <div class="scope-mark"><i></i><i></i><i></i></div>
          <div class="eyebrow">STATION CLAIMED</div>
          <h2>Waiting for the crew</h2>
          <p>Keep this screen awake. The central console starts the mission when all three stations report in.</p>
        </section>
      `;
    case "countdown":
      return `
        <section class="countdown-state">
          <div class="eyebrow">BRACE FOR INPUT</div>
          <div class="countdown-number" data-countdown="${phone.phase.endsAt}">3</div>
        </section>
      `;
    case "playing":
      if (phone.order === null) {
        throw new Error("Playing phone snapshot has no order");
      }
      return `
        <section class="mission-phone">
          ${missionMeterMarkup(phone.phase)}
          <div class="order-card" data-order-id="${phone.order.id}">
            <div class="order-kicker">
              <span>SHOUT THIS</span>
              <strong>TO ${stationShortName(phone.order.target)}</strong>
            </div>
            <h2>${escapeHtml(phone.order.prompt)}</h2>
            <div class="deadline-track">
              <i data-deadline="${phone.order.deadlineAt}"></i>
            </div>
          </div>
          <p class="phone-instruction">Do not perform this action yourself. Make the other operator hear you.</p>
        </section>
      `;
    case "game-over":
      return `
        <section class="game-over-state ${phone.phase.reason}">
          <div class="eyebrow">${phone.phase.reason === "survived" ? "SHIFT COMPLETE" : "SYSTEM FAILURE"}</div>
          <h2>${phone.phase.reason === "survived" ? "Still alive." : "The ship came apart."}</h2>
          <div class="final-score">${phone.phase.score.toLocaleString()}</div>
          <p>Final crew score. The central console can reset for another mission.</p>
        </section>
      `;
  }
}

function renderConsole(): void {
  if (snapshot === null || !isConsoleSnapshot(snapshot)) {
    app.innerHTML = `
      <main class="console-loading">
        <div class="eyebrow">CENTRAL HARDWARE CONSOLE</div>
        <h1>Establishing link…</h1>
        ${errorMarkup()}
      </main>
    `;
    return;
  }
  app.innerHTML = consoleMarkup(snapshot);
  bindConsoleActions(snapshot);
}

function consoleMarkup(consoleSnapshot: ConsoleSnapshot): string {
  return `
    <main class="console-shell">
      <header class="console-header">
        <div>
          <div class="eyebrow">CENTRAL HARDWARE CONSOLE</div>
          <h1>SYNTH<span>/</span>TEAM</h1>
        </div>
        <div class="console-address">
          <span>PHONE ADDRESS</span>
          ${consoleSnapshot.phoneUrls.map((url) => `<strong>${escapeHtml(url)}</strong>`).join("")}
        </div>
      </header>
      ${consolePhaseMarkup(consoleSnapshot)}
      ${activityMarkup(consoleSnapshot)}
      ${errorMarkup()}
    </main>
  `;
}

function consolePhaseMarkup(consoleSnapshot: ConsoleSnapshot): string {
  switch (consoleSnapshot.phase.kind) {
    case "lobby":
      return `
        <section class="console-lobby">
          <div class="lobby-stations">
            ${STATIONS.map((station) => consoleStationCard(station, consoleSnapshot.crew)).join("")}
          </div>
          <button id="start-mission" class="primary-button console-start" ${crewReady(consoleSnapshot.crew) ? "" : "disabled"}>
            ${crewReady(consoleSnapshot.crew) ? "START MISSION" : "WAITING FOR 3 PHONES"}
            <span>▶</span>
          </button>
        </section>
      `;
    case "countdown":
      return `
        <section class="console-countdown">
          <div class="eyebrow">HARDWARE ARMED</div>
          <div class="countdown-number" data-countdown="${consoleSnapshot.phase.endsAt}">3</div>
        </section>
      `;
    case "playing":
      if (consoleSnapshot.mission === null) {
        throw new Error("Console mission state is missing");
      }
      return `
        <section class="console-mission">
          ${missionMeterMarkup(consoleSnapshot.phase)}
          <div class="task-overview">
            ${consoleSnapshot.mission.tasks.map((task) => taskCard(task, consoleSnapshot)).join("")}
          </div>
          <div class="simulator">
            <div class="simulator-heading">
              <div>
                <div class="eyebrow">DEVELOPMENT INPUT</div>
                <h2>Hardware simulator</h2>
              </div>
              <p>Real adapters use the same typed events. These controls disappear from the production run screen.</p>
            </div>
            <div class="simulator-grid">
              ${streamDeckSimulator(consoleSnapshot)}
              ${uf8Simulator(consoleSnapshot)}
              ${pushSimulator(consoleSnapshot)}
            </div>
          </div>
        </section>
      `;
    case "game-over":
      return `
        <section class="console-game-over ${consoleSnapshot.phase.reason}">
          <div class="eyebrow">${consoleSnapshot.phase.reason === "survived" ? "MISSION SURVIVED" : "INTEGRITY LOST"}</div>
          <h2>${consoleSnapshot.phase.score.toLocaleString()} points</h2>
          <button id="reset-mission" class="primary-button">RESET TO LOBBY <span>↺</span></button>
        </section>
      `;
  }
}

function consoleStationCard(station: Station, crew: CrewSlots): string {
  const member = crew[station];
  return `
    <article class="console-station-card station-${station}">
      <span class="station-indicator"></span>
      <div>
        <div class="eyebrow">${stationShortName(station)}</div>
        <h2>${member === null ? "Unclaimed" : escapeHtml(member.name)}</h2>
        <p>${member?.connected === true ? "PHONE LINKED" : stationRole(station)}</p>
      </div>
    </article>
  `;
}

function taskCard(task: ActiveTask, consoleSnapshot: ConsoleSnapshot): string {
  const reader = consoleSnapshot.crew[task.reader];
  return `
    <article class="task-card station-${stationForTask(task)}">
      <div class="task-route">
        <span>${reader === null ? stationShortName(task.reader) : escapeHtml(reader.name)} READS</span>
        <strong>→ ${stationShortName(stationForTask(task))}</strong>
      </div>
      <p>${taskDescription(task, consoleSnapshot)}</p>
      <small>${taskProgress(task)}</small>
    </article>
  `;
}

function streamDeckSimulator(consoleSnapshot: ConsoleSnapshot): string {
  if (consoleSnapshot.mission === null) {
    return "";
  }
  const active = taskByKind(consoleSnapshot.mission.tasks, "streamdeck-route");
  return `
    <section class="sim-panel deck-panel">
      <header><span>01</span><strong>STREAM DECK</strong></header>
      <div class="deck-grid">
        ${consoleSnapshot.mission.streamDeckKeys
          .map(
            (key) => `
              <button
                class="deck-key color-${key.color} ${
                  key.index === active.sourceKeyIndex && active.progress === 1
                    ? "is-armed"
                    : ""
                }"
                data-deck-key="${key.index}"
              >${escapeHtml(key.label)}</button>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function uf8Simulator(consoleSnapshot: ConsoleSnapshot): string {
  if (consoleSnapshot.mission === null) {
    return "";
  }
  const active = taskByKind(consoleSnapshot.mission.tasks, "uf8-fader");
  return `
    <section class="sim-panel uf8-panel">
      <header><span>02</span><strong>SSL UF8</strong></header>
      <div class="fader-bank">
        ${Array.from({ length: 8 }, (_, channel) => {
          const isTarget = channel === active.channel;
          return `
            <label class="fader-strip ${isTarget ? "is-target" : ""}">
              <span>CH ${channel + 1}</span>
              <input data-uf8-fader="${channel}" type="range" min="0" max="100" value="50" orient="vertical" />
              <small>${isTarget ? escapeHtml(active.label) : "—"}</small>
            </label>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function pushSimulator(consoleSnapshot: ConsoleSnapshot): string {
  if (consoleSnapshot.mission === null) {
    return "";
  }
  const active = taskByKind(consoleSnapshot.mission.tasks, "push-path");
  return `
    <section class="sim-panel push-panel">
      <header><span>03</span><strong>ABLETON PUSH</strong></header>
      <div class="push-grid">
        ${gridPoints()
          .map((point) => {
            const pathIndex = active.path.findIndex(
              (candidate) => candidate.x === point.x && candidate.y === point.y,
            );
            const state =
              pathIndex < 0
                ? ""
                : pathIndex < active.progress
                  ? "is-complete"
                  : pathIndex === active.progress
                    ? `is-path is-next color-${active.color}`
                    : `is-path color-${active.color}`;
            return `<button class="push-pad ${state}" data-push-x="${point.x}" data-push-y="${point.y}" aria-label="Push pad ${point.x + 1}, ${point.y + 1}"></button>`;
          })
          .join("")}
      </div>
    </section>
  `;
}

function bindConsoleActions(consoleSnapshot: ConsoleSnapshot): void {
  document.querySelector("#start-mission")?.addEventListener("click", () => {
    send({ type: "start-mission" });
  });
  document.querySelector("#reset-mission")?.addEventListener("click", () => {
    send({ type: "reset-mission" });
  });
  if (consoleSnapshot.phase.kind !== "playing") {
    return;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-deck-key]")) {
    button.addEventListener("click", () => {
      const keyIndex = Number(button.dataset["deckKey"]);
      sendHardware({
        kind: "streamdeck-key",
        keyIndex,
        phase: "down",
      });
    });
  }
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-uf8-fader]")) {
    input.addEventListener("input", () => {
      const channel = Number(input.dataset["uf8Fader"]);
      sendHardware({
        kind: "uf8-fader",
        channel,
        value: Number(input.value),
      });
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-push-x]")) {
    button.addEventListener("click", () => {
      sendHardware({
        kind: "push-pad",
        point: {
          x: Number(button.dataset["pushX"]),
          y: Number(button.dataset["pushY"]),
        },
        phase: "down",
        velocity: 100,
      });
    });
  }
}

function missionMeterMarkup(phase: Extract<MissionPhaseView, { kind: "playing" }>): string {
  return `
    <div class="mission-meter">
      <div><span>TIME</span><strong data-mission-end="${phase.endsAt}">01:30</strong></div>
      <div class="integrity"><span>INTEGRITY</span><strong>${Math.round(phase.integrity)}%</strong></div>
      <div><span>SCORE</span><strong>${phase.score.toLocaleString()}</strong></div>
      <div><span>COMBO</span><strong>×${phase.combo}</strong></div>
    </div>
  `;
}

function activityMarkup(consoleSnapshot: ConsoleSnapshot): string {
  return `
    <aside class="activity-rail">
      <div class="eyebrow">SHIP LOG</div>
      ${consoleSnapshot.activity
        .map(
          (item) => `
            <div class="activity-item tone-${item.tone}">
              <i></i><span>${escapeHtml(item.text)}</span>
            </div>
          `,
        )
        .join("")}
    </aside>
  `;
}

function crewChip(station: Station, crew: CrewSlots): string {
  const member = crew[station];
  return `
    <div class="crew-chip ${member?.connected === true ? "is-online" : ""}">
      <i></i>
      <span>${stationShortName(station)}</span>
      <strong>${member === null ? "—" : escapeHtml(member.name)}</strong>
    </div>
  `;
}

function taskDescription(task: ActiveTask, consoleSnapshot: ConsoleSnapshot): string {
  if (consoleSnapshot.mission === null) {
    throw new Error("Task description requires an active mission");
  }
  switch (task.kind) {
    case "streamdeck-route": {
      const source = consoleSnapshot.mission.streamDeckKeys[task.sourceKeyIndex];
      const target = consoleSnapshot.mission.streamDeckKeys[task.targetKeyIndex];
      if (source === undefined || target === undefined) {
        throw new Error("Stream Deck task points outside layout");
      }
      return `ROUTE ${escapeHtml(source.label)} THROUGH ${escapeHtml(target.label)}`;
    }
    case "uf8-fader":
      return `SET ${escapeHtml(task.label)} TO ${task.target}`;
    case "push-path":
      return `TRACE THE ${task.color.toUpperCase()} VECTOR`;
  }
}

function taskProgress(task: ActiveTask): string {
  switch (task.kind) {
    case "streamdeck-route":
      return task.progress === 0 ? "WAITING FOR SOURCE" : "SOURCE LOCKED";
    case "uf8-fader":
      return task.withinSince === null ? "OUTSIDE TARGET BAND" : "HOLDING";
    case "push-path":
      return `${task.progress}/${task.path.length} PADS`;
  }
}

function taskByKind<T extends ActiveTask["kind"]>(
  tasks: readonly ActiveTask[],
  kind: T,
): Extract<ActiveTask, { kind: T }> {
  const task = tasks.find(
    (candidate): candidate is Extract<ActiveTask, { kind: T }> =>
      candidate.kind === kind,
  );
  if (task === undefined) {
    throw new Error(`Missing ${kind} task`);
  }
  return task;
}

function updateLiveNumbers(): void {
  const now = Date.now();
  for (const element of document.querySelectorAll<HTMLElement>("[data-countdown]")) {
    const endsAt = Number(element.dataset["countdown"]);
    element.textContent = String(Math.max(1, Math.ceil((endsAt - now) / 1_000)));
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-mission-end]")) {
    const endsAt = Number(element.dataset["missionEnd"]);
    const remainingSeconds = Math.max(0, Math.ceil((endsAt - now) / 1_000));
    element.textContent = `${String(Math.floor(remainingSeconds / 60)).padStart(2, "0")}:${String(remainingSeconds % 60).padStart(2, "0")}`;
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-deadline]")) {
    const deadline = Number(element.dataset["deadline"]);
    const remaining = Math.max(0, deadline - now);
    element.style.scale = `${Math.min(1, remaining / 13_000)} 1`;
  }
}

function sendHardware(event: HardwareEvent): void {
  send({ type: "hardware-event", event });
}

function send(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function loadSavedCrew(): SavedCrew | null {
  const raw = window.localStorage.getItem("synthteam-crew");
  if (raw === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "crewId" in value &&
      "name" in value &&
      "station" in value &&
      typeof value.crewId === "string" &&
      typeof value.name === "string" &&
      isStation(value.station)
    ) {
      return {
        crewId: value.crewId,
        name: value.name,
        station: value.station,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function saveCrew(crew: SavedCrew): void {
  window.localStorage.setItem("synthteam-crew", JSON.stringify(crew));
}

function emptyCrew(): CrewSlots {
  return { streamdeck: null, uf8: null, push: null };
}

function crewReady(crew: CrewSlots): boolean {
  return STATIONS.every((station) => crew[station]?.connected === true);
}

function gridPoints(): GridPoint[] {
  const points: GridPoint[] = [];
  for (let y = 7; y >= 0; y -= 1) {
    for (let x = 0; x < 8; x += 1) {
      points.push({ x, y });
    }
  }
  return points;
}

function isStation(value: unknown): value is Station {
  return STATIONS.some((station) => station === value);
}

function isPhoneSnapshot(value: ViewSnapshot): value is PhoneSnapshot {
  return value.viewer.kind === "phone";
}

function isConsoleSnapshot(value: ViewSnapshot): value is ConsoleSnapshot {
  return value.viewer.kind === "console";
}

function stationShortName(station: Station): string {
  switch (station) {
    case "streamdeck":
      return "DECK";
    case "uf8":
      return "UF8";
    case "push":
      return "PUSH";
  }
}

function stationRole(station: Station): string {
  switch (station) {
    case "streamdeck":
      return "ROUTING + COMMS";
    case "uf8":
      return "REACTOR + DRIVE";
    case "push":
      return "NAV + SENSORS";
  }
}

function errorMarkup(): string {
  return errorMessage.length === 0
    ? ""
    : `<div class="error-banner">${escapeHtml(errorMessage)}</div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
