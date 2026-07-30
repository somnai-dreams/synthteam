import type {
  ActiveTask,
  CrewMember,
  CrewSlots,
  GridPoint,
  HardwareEvent,
  InterstitialTask,
  MissionActivity,
  PushCornersInterstitial,
  PushPathTask,
  Station,
  StreamDeckHitInterstitial,
  StreamDeckRouteTask,
  StreamDeckSequenceTask,
  Uf8FaderTask,
} from "../shared/domain.ts";
import { STATIONS, stationForTask } from "../shared/domain.ts";
import type {
  ClientMessage,
  ConsoleSnapshot,
  MissionPhaseView,
  PhoneDirective,
  PhoneSnapshot,
  ViewSnapshot,
} from "../shared/protocol.ts";
import {
  parseServerMessage,
  stationHardwareAvailable,
} from "../shared/protocol.ts";
import {
  GAME_TASK_KINDS,
  type ActivitySettings,
  type GameTaskKind,
} from "../game/mission.ts";
import { MidiBridge, type MidiDeviceOption } from "./midi.ts";

type SavedCrew = {
  crewId: string;
  name: string;
};

const appElement = document.querySelector<HTMLDivElement>("#app");
if (appElement === null) {
  throw new Error("App root is missing");
}
const app = appElement;

const isConsole = window.location.pathname === "/console";
const midiBridge = isConsole ? new MidiBridge(sendHardware, render) : null;
let socket: WebSocket | null = null;
let snapshot: ViewSnapshot | null = null;
let errorMessage = "";
let savedCrew = loadSavedCrew();
let joinDraftName = savedCrew?.name ?? "";
let joinSelectedStation: Station | null = null;
let awaitingCrewResume = false;

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
      awaitingCrewResume = true;
      send({
        type: "phone-resume",
        crewId: savedCrew.crewId,
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
        if (awaitingCrewResume) {
          joinDraftName = savedCrew?.name ?? joinDraftName;
          savedCrew = null;
          clearSavedCrew();
          awaitingCrewResume = false;
        }
        errorMessage = message.message;
        render();
        return;
      case "snapshot":
        snapshot = message.snapshot;
        errorMessage = "";
        if (snapshot.viewer.kind === "phone") {
          awaitingCrewResume = false;
          const member = snapshot.crew[snapshot.viewer.station];
          if (member !== null) {
            savedCrew = {
              crewId: snapshot.viewer.crewId,
              name: member.name,
            };
            saveCrew(savedCrew);
          }
        }
        render();
        return;
      case "streamdeck-state":
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
  const selectedStation = selectedClaimStation(crew);
  const openStationCount = STATIONS.filter(
    (station) => crew[station] === null,
  ).length;
  return `
    <main class="join-screen">
      <header class="brand-block stagger-1">
        <div class="eyebrow">COOPERATIVE HARDWARE PANIC</div>
        <h1>SYNTH<span>/</span>TEAM</h1>
        <p>Choose an open control surface. Your phone becomes that station's private instruction channel.</p>
      </header>
      <form id="join-form" class="join-card stagger-2">
        <label class="field-label" for="crew-name">CALL SIGN</label>
        <input id="crew-name" name="name" maxlength="18" autocomplete="nickname" placeholder="Enter your name" value="${escapeHtml(joinDraftName)}" required />
        <section class="assignment-preview">
          <div class="assignment-heading">
            <span>CHOOSE YOUR CONTROLLER</span>
            <strong>${openStationCount === 0 ? "CREW FULL" : `${openStationCount} OPEN`}</strong>
          </div>
          <div class="assignment-queue">
            ${STATIONS.map((station) => stationChoice(station, crew, selectedStation)).join("")}
          </div>
          <p>Disconnected stations stay reserved for ten seconds. Two phones are enough to launch.</p>
        </section>
        ${errorMarkup()}
        <button class="primary-button" type="submit" ${selectedStation === null ? "disabled" : ""}>CLAIM STATION <span>→</span></button>
      </form>
      <p class="join-note stagger-3">Your phone only shows orders. Actions must happen on the physical controls.</p>
      ${phoneGuideMarkup()}
    </main>
  `;
}

function stationChoice(
  station: Station,
  crew: CrewSlots,
  selectedStation: Station | null,
): string {
  const member = crew[station];
  const hardwareMissing = !stationHasHardware(station);
  const unavailable = member !== null || hardwareMissing;
  const selected = station === selectedStation && !hardwareMissing;
  const status = hardwareMissing ? "NO HARDWARE" : stationClaimStatus(member);
  const detail = hardwareMissing
    ? "connect the device to enable"
    : member === null
      ? stationRole(station)
      : escapeHtml(member.name);
  return `
    <label class="assignment-slot station-${station} ${unavailable ? "is-unavailable" : ""}">
      <input
        class="station-choice-input"
        type="radio"
        name="station"
        value="${station}"
        ${selected ? "checked" : ""}
        ${unavailable ? "disabled" : ""}
        required
      />
      <span class="station-indicator"></span>
      <span class="assignment-copy">
        <strong>${stationShortName(station)}</strong>
        <small>${detail}</small>
      </span>
      <span class="assignment-status">${status}</span>
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
      joinSelectedStation = stationFromFormValue(input.value);
    });
  }
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const name = data.get("name");
    const station = data.get("station");
    if (typeof name !== "string" || typeof station !== "string") {
      return;
    }
    joinDraftName = name;
    joinSelectedStation = stationFromFormValue(station);
    send({
      type: "phone-claim",
      name,
      station: joinSelectedStation,
    });
  });
}

function phoneShellMarkup(phone: PhoneSnapshot): string {
  const member = phone.crew[phone.viewer.station];
  if (member === null) {
    throw new Error("Phone viewer has no crew member");
  }
  const activityClass =
    phone.phase.kind === "playing"
      ? ` mode-${phone.phase.activity}`
      : "";
  return `
    <main class="phone-shell station-${phone.viewer.station}${activityClass}">
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
      const connectedCount = connectedCrewCount(phone.crew);
      return `
        <section class="waiting-state">
          ${phoneGuideMarkup()}
          <div class="scope-mark"><i></i><i></i><i></i></div>
          <div class="eyebrow">STATION CLAIMED</div>
          <h2>Waiting for the crew</h2>
          <p>${
            connectedCount >= 2
              ? `${connectedCount} crew linked. The central console can launch now.`
              : "One more phone is needed. The third crew member is optional."
          }</p>
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
      if (phone.directive === null) {
        throw new Error("Playing phone snapshot has no directive");
      }
      return `
        <section class="mission-phone">
          ${missionMeterMarkup(phone.phase)}
          ${phoneDirectiveMarkup(phone.directive)}
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

function phoneDirectiveMarkup(directive: PhoneDirective): string {
  switch (directive.kind) {
    case "order":
      return `
        <div class="order-card directive-card directive-order" data-directive-id="${directive.id}">
          <div class="order-kicker">
            <span>SHOUT THIS</span>
            <strong>TO ${stationShortName(directive.target)}</strong>
          </div>
          <h2>${escapeHtml(directive.prompt)}</h2>
          ${deadlineMarkup(directive)}
        </div>
        <p class="phone-instruction">Do not perform this action yourself. Make the other operator hear you.</p>
      `;
    case "interstitial":
      return `
        <div class="order-card directive-card directive-local" data-directive-id="${directive.id}">
          <div class="order-kicker">
            <span>INTERSTITIAL</span>
            <strong>DO THIS YOURSELF</strong>
          </div>
          <h2>${escapeHtml(directive.prompt)}</h2>
          ${deadlineMarkup(directive)}
        </div>
        <p class="phone-instruction is-local">Use your own ${stationShortName(directive.station)} controls. Do not shout this order away.</p>
      `;
    case "interstitial-support":
      return `
        <div class="order-card directive-card directive-support" data-directive-id="${directive.id}">
          <div class="order-kicker">
            <span>LEVEL TRANSITION</span>
            <strong>${stationShortName(directive.focusStation)} SOLO</strong>
          </div>
          <h2>${escapeHtml(directive.prompt)}</h2>
          ${deadlineMarkup(directive)}
        </div>
        <p class="phone-instruction">This one belongs to the highlighted operator. The next level unlocks either way.</p>
      `;
    case "reactor-manual":
      return `
        <div class="order-card directive-card directive-procedure" data-directive-id="${directive.id}">
          <div class="order-kicker">
            <span>PROCEDURE MANUAL</span>
            <strong>ASK UF8 FOR CODE</strong>
          </div>
          <h2>REACTOR CALIBRATION</h2>
          <div class="procedure-table">
            ${directive.profiles
              .map(
                (profile) => `
                  <div>
                    <strong>${profile.code}</strong>
                    <span>${profile.targets
                      .map(
                        (target) =>
                          `${target.label} ${target.stop.label}`,
                      )
                      .join(" · ")}</span>
                  </div>
                `,
              )
              .join("")}
          </div>
          ${deadlineMarkup(directive)}
        </div>
        <p class="phone-instruction">The UF8 operator can see the code. Make them report it, then read the matching row aloud.</p>
      `;
    case "reactor-operator":
      return `
        <div class="order-card directive-card directive-procedure operator-procedure" data-directive-id="${directive.id}">
          <div class="order-kicker">
            <span>REACTOR PROCEDURE</span>
            <strong>YOU HAVE THE SYMPTOM</strong>
          </div>
          <h2>${escapeHtml(directive.prompt)}</h2>
          ${deadlineMarkup(directive)}
        </div>
        <p class="phone-instruction">Read the code on the CORE PRESSURE display. Another phone has the calibration table.</p>
      `;
    case "reactor-support":
      return `
        <div class="order-card directive-card directive-procedure support-procedure" data-directive-id="${directive.id}">
          <div class="order-kicker">
            <span>REACTOR PROCEDURE</span>
            <strong>CREW SUPPORT</strong>
          </div>
          <h2>${escapeHtml(directive.prompt)}</h2>
          ${deadlineMarkup(directive)}
        </div>
        <p class="phone-instruction">Repeat the code and targets. Catch communication mistakes before the timer runs out.</p>
      `;
  }
}

function deadlineMarkup(
  directive: PhoneDirective,
): string {
  return `
    <div class="deadline-track">
      <i
        data-deadline="${directive.deadlineAt}"
        data-started-at="${directive.startedAt}"
      ></i>
    </div>
  `;
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
  midiBridge?.syncActivity(
    snapshot.mission?.activity ?? null,
    snapshot.phase.kind === "playing"
      ? snapshot.phase.activeControls.pushGridSize
      : 0,
  );
  app.innerHTML = consoleMarkup(snapshot);
  bindConsoleActions(snapshot);
}

type GameInfo = {
  name: string;
  station: Station;
  order: string;
  description: string;
  preview: string;
};

const GAME_INFO: Record<GameTaskKind, GameInfo> = {
  "streamdeck-route": {
    name: "Route",
    station: "streamdeck",
    order: "ROUTE BERYL THROUGH GHOST",
    description:
      "Press the named source key, then the named target key on the Deck's LCD keys.",
    preview: `<span class="pv-key">BERYL</span><span class="pv-arrow">→</span><span class="pv-key">GHOST</span>`,
  },
  "streamdeck-sequence": {
    name: "Hold sequence",
    station: "streamdeck",
    order: "HOLD NOVA, TAP RIFT, RELEASE NOVA",
    description:
      "Hold the first key, tap the second while holding, then release.",
    preview: `<span class="pv-chip">HOLD</span><span class="pv-chip">TAP</span><span class="pv-chip">RELEASE</span>`,
  },
  "push-path": {
    name: "Vector trace",
    station: "push",
    order: "TRACE THE VIOLET VECTOR",
    description:
      "A colored path lights up on the pads. Press the pads in order — the next pad glows white.",
    preview: `<span class="pv-grid"><i class="on"></i><i></i><i></i><i class="on"></i><i class="on"></i><i></i><i></i><i class="next"></i><i></i></span>`,
  },
  "push-defend": {
    name: "Defend the mothership",
    station: "push",
    order: "DEFEND THE MOTHERSHIP",
    description:
      "Missiles climb the pad columns toward your saucer on the screen. Press a missile's pad to intercept; each hit costs hull.",
    preview: `<span class="pv-emoji">🛸</span><span class="pv-missiles">▲ ▲ ▲</span>`,
  },
  "push-console": {
    name: "Console order",
    station: "push",
    order: "QUANTIZE HIGGS BOSON · SCALE POSITRON TO 4",
    description:
      "16 sci-fi labels appear around the Push screen, mapped to the button rows. Press the named verb button (a real Push button) and the label. SCALE orders add the big dial: turn the counter to the target.",
    preview: `<span class="pv-strip"><i>HIGGS</i><i>FLUX</i><i>QUARK</i><i>MUON</i></span><span class="pv-chip pv-verb">QUANTIZE</span>`,
  },
  "push-review": {
    name: "Undo or save",
    station: "push",
    order: 'SAVE "WORMHOLE DELETED"',
    description:
      "The Push announces a fabricated event. Only the phone order knows the verdict — press the real Undo or Save button.",
    preview: `<span class="pv-announce">WORMHOLE DELETED!</span><span class="pv-chip">UNDO</span><span class="pv-chip">SAVE</span>`,
  },
  "push-cow": {
    name: "Tractor beam",
    station: "push",
    order: "ABDUCT THE COW · RELEASE THE COW",
    description:
      "Something is caught in the beam — it stays hidden until you move it. Slide the touch strip up to abduct, down to release.",
    preview: `<span class="pv-emoji">🛸</span><span class="pv-beam">▽</span><span class="pv-emoji">🐄</span>`,
  },
};

/**
 * UF8 activities are always on (the UF8 has no togglable variants), so
 * they live outside GameTaskKind — but they still belong in the guide.
 */
const UF8_GUIDE_INFO: readonly GameInfo[] = [
  {
    name: "Fader order",
    station: "uf8",
    order: "SET COOLANT TO -20 DB",
    description:
      "Move the named channel's fader to the called dB stop and hold it there until it registers.",
    preview: `<span class="pv-faders"><i></i><i class="on"></i><i></i><i></i></span><span class="pv-chip">-20 DB</span>`,
  },
  {
    name: "Bottom out",
    station: "uf8",
    order: "ALL FADERS TO −INF",
    description:
      "Level transition solo: pull every fader down to the bottom of its throw before the timer runs out.",
    preview: `<span class="pv-faders pv-low"><i></i><i></i><i></i><i></i></span><span class="pv-chip">−INF</span>`,
  },
  {
    name: "Reactor calibration",
    station: "uf8",
    order: "REACTOR CODE BETA",
    description:
      "The CORE PRESSURE display shows a code; another phone holds the calibration table. Set COOLANT and DRIFT to the matching row's stops and hold both.",
    preview: `<span class="pv-chip pv-verb">BETA</span><span class="pv-strip"><i>COOLANT -20</i><i>DRIFT -60</i></span>`,
  },
];

function gameSettingsMarkup(consoleSnapshot: ConsoleSnapshot): string {
  const settings = consoleSnapshot.activitySettings;
  const groups: Record<string, GameTaskKind[]> = {};
  for (const kind of GAME_TASK_KINDS) {
    const station = GAME_INFO[kind].station;
    (groups[station] ??= []).push(kind);
  }
  return `
    <section class="game-settings">
      <div class="panel-heading">
        <div class="eyebrow">GAME SETTINGS</div>
        <h2>Enabled games per device</h2>
      </div>
      <div class="settings-grid">
        ${Object.entries(groups)
          .map(
            ([station, kinds]) => `
          <div class="settings-group station-${station}">
            <div class="hardware-device-title">
              <span class="station-indicator"></span>
              <strong>${stationShortName(station as Station)}</strong>
            </div>
            ${kinds
              .map(
                (kind) => `
              <label class="game-toggle">
                <input type="checkbox" class="js-game-toggle" data-kind="${kind}" ${settings[kind] ? "checked" : ""} />
                <span>${GAME_INFO[kind].name}</span>
              </label>
            `,
              )
              .join("")}
          </div>
        `,
          )
          .join("")}
      </div>
      <p class="hardware-note">Disabled games never roll as orders. Each device keeps at least one game.</p>
    </section>
  `;
}

function testingPanelMarkup(consoleSnapshot: ConsoleSnapshot): string {
  const countdown = consoleSnapshot.phase.kind === "countdown";
  return `
    <section class="test-panel">
      <div class="panel-heading">
        <div class="eyebrow">TESTING</div>
        <h2>Trigger an activity now</h2>
      </div>
      <div class="test-buttons">
        ${GAME_TASK_KINDS.map(
          (kind) => `
          <button class="secondary-button js-trigger" data-kind="${kind}" ${countdown ? "disabled" : ""}>
            ${GAME_INFO[kind].name}
          </button>
        `,
        ).join("")}
      </div>
      <p class="hardware-note">${
        consoleSnapshot.phase.kind === "playing"
          ? "Replaces that station's current order immediately."
          : "Starts a sandbox test mission and triggers the order — no phones needed."
      }</p>
    </section>
  `;
}

function guideEntries(): readonly GameInfo[] {
  return [...GAME_TASK_KINDS.map((kind) => GAME_INFO[kind]), ...UF8_GUIDE_INFO].sort(
    (a, b) => STATIONS.indexOf(a.station) - STATIONS.indexOf(b.station),
  );
}

function gameGuideMarkup(): string {
  return `
    <section class="game-guide">
      <div class="panel-heading">
        <div class="eyebrow">GAME GUIDE</div>
        <h2>Every order type</h2>
      </div>
      <div class="guide-grid">
        ${guideEntries()
          .map((info) => {
            return `
          <article class="guide-card station-${info.station}">
            <div class="guide-preview">${info.preview}</div>
            <div class="guide-copy">
              <div class="hardware-device-title">
                <span class="station-indicator"></span>
                <strong>${info.name}</strong>
                <small>${stationShortName(info.station)}</small>
              </div>
              <p class="guide-order">"${info.order}"</p>
              <p>${info.description}</p>
            </div>
          </article>
        `;
        }).join("")}
      </div>
    </section>
  `;
}

function phoneGuideMarkup(): string {
  return `
    <details class="phone-guide">
      <summary>HOW THE GAMES WORK</summary>
      <div class="phone-guide-carousel">
        ${guideEntries()
          .map((info) => {
            return `
          <div class="phone-guide-item station-${info.station}">
            <div class="guide-preview">${info.preview}</div>
            <strong>${info.name} · ${stationShortName(info.station)}</strong>
            <p>${info.description}</p>
          </div>
        `;
        }).join("")}
      </div>
    </details>
  `;
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
      ${hardwarePanelMarkup(consoleSnapshot)}
      ${gameSettingsMarkup(consoleSnapshot)}
      ${testingPanelMarkup(consoleSnapshot)}
      ${gameGuideMarkup()}
      ${activityMarkup(consoleSnapshot)}
      ${errorMarkup()}
    </main>
  `;
}

function consolePhaseMarkup(consoleSnapshot: ConsoleSnapshot): string {
  switch (consoleSnapshot.phase.kind) {
    case "lobby":
      const connectedCount = connectedCrewCount(consoleSnapshot.crew);
      const ready = connectedCount >= 2;
      return `
        <section class="console-lobby">
          <div class="lobby-stations">
            ${STATIONS.map((station) => consoleStationCard(station, consoleSnapshot.crew)).join("")}
          </div>
          <button id="start-mission" class="primary-button console-start" ${ready ? "" : "disabled"}>
            ${lobbyStartLabel(connectedCount)}
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
          ${activityOverviewMarkup(consoleSnapshot)}
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

function consoleStationCard(
  station: Station,
  crew: CrewSlots,
): string {
  const member = crew[station];
  const connected = isCrewMemberConnected(member);
  const reserved =
    member !== null && member.connection.kind === "reserved";
  return `
    <article class="console-station-card station-${station} ${reserved ? "is-reserved" : ""}">
      <span class="station-indicator"></span>
      <div>
        <div class="eyebrow">${stationShortName(station)}</div>
        <h2>${member === null ? "Unclaimed" : escapeHtml(member.name)}</h2>
        <p>${connected ? "PHONE LINKED" : reserved ? "RECONNECT RESERVED" : stationRole(station)}</p>
      </div>
    </article>
  `;
}

function activityOverviewMarkup(
  consoleSnapshot: ConsoleSnapshot,
): string {
  const mission = consoleSnapshot.mission;
  if (mission === null || consoleSnapshot.phase.kind !== "playing") {
    throw new Error("Activity overview requires an active mission");
  }
  switch (mission.activity.kind) {
    case "orders":
      return `
        <div class="activity-banner mode-orders">
          <span>LEVEL ${consoleSnapshot.phase.level} · ORDERS</span>
          <strong>${consoleSnapshot.phase.levelObjectivesCompleted}/${consoleSnapshot.phase.levelObjectiveTarget} OBJECTIVES CLEARED</strong>
        </div>
        <div class="task-overview task-count-${mission.activity.tasks.length}">
          ${mission.activity.tasks
            .map((task) => taskCard(task, consoleSnapshot))
            .join("")}
        </div>
      `;
    case "interstitial":
      return `
        <div class="activity-banner mode-interstitial">
          <span>LEVEL ${mission.activity.completedLevel} CLEAR</span>
          <strong>${stationShortName(mission.activity.task.station)} SOLO → LEVEL ${mission.activity.nextLevel}</strong>
        </div>
        <div class="task-overview task-count-1">
          ${interstitialCard(mission.activity.task)}
        </div>
      `;
    case "reactor-procedure": {
      const procedure = mission.activity.procedure;
      const reader = consoleSnapshot.crew[procedure.reader];
      return `
        <div class="activity-banner mode-reactor-procedure">
          <span>LEVEL 5 · FINAL PROCEDURE</span>
          <strong>REPORT → LOOK UP → CALIBRATE</strong>
        </div>
        <div class="procedure-overview">
          <article class="task-card station-uf8 procedure-card">
            <div class="task-route">
              <span>${reader === null ? stationShortName(procedure.reader) : escapeHtml(reader.name)} HAS MANUAL</span>
              <strong>→ UF8</strong>
            </div>
            <p>CODE ${procedure.profile.code}</p>
            <small>${procedure.profile.targets
              .map(
                (target) => `${target.label} ${target.stop.label}`,
              )
              .join(" · ")}</small>
          </article>
        </div>
      `;
    }
  }
}

function interstitialCard(task: InterstitialTask): string {
  let prompt: string;
  let progress: string;
  switch (task.kind) {
    case "streamdeck-hit":
      prompt = "HIT THE CALLOUT";
      progress = task.completed ? "CLEARED" : "WAITING";
      break;
    case "uf8-bottom-out":
      prompt = "BOTTOM OUT";
      progress = task.completed
        ? "CLEARED"
        : `FIRST ${task.channelCount} FADERS TO −INF`;
      break;
    case "push-corners":
      prompt = "CORNERS";
      progress = task.completed
        ? "CLEARED"
        : `${task.pressed.length}/4 PADS`;
      break;
  }
  return `
    <article class="task-card station-${task.station} ${task.completed ? "is-complete" : ""}">
      <div class="task-route">
        <span>LOCAL CONTROL</span>
        <strong>${stationShortName(task.station)}</strong>
      </div>
      <p>${prompt}</p>
      <small>${progress}</small>
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
  const mission = consoleSnapshot.mission;
  if (
    mission === null ||
    consoleSnapshot.phase.kind !== "playing" ||
    consoleSnapshot.crew.streamdeck?.connection.kind !== "connected"
  ) {
    return "";
  }
  let active:
    | StreamDeckRouteTask
    | StreamDeckSequenceTask
    | StreamDeckHitInterstitial
    | null = null;
  switch (mission.activity.kind) {
    case "orders":
      active =
        mission.activity.tasks.find(
          (
            task,
          ): task is StreamDeckRouteTask | StreamDeckSequenceTask =>
            task.kind === "streamdeck-route" ||
            task.kind === "streamdeck-sequence",
        ) ?? null;
      break;
    case "interstitial":
      active =
        mission.activity.task.kind === "streamdeck-hit"
          ? mission.activity.task
          : null;
      break;
    case "reactor-procedure":
      break;
  }
  const activeColumns = consoleSnapshot.phase.activeControls.streamDeckColumns;
  return `
    <section class="sim-panel deck-panel">
      <header><span>01</span><strong>STREAM DECK</strong></header>
      <div class="deck-grid">
        ${mission.streamDeckKeys
          .map(
            (key) => {
              const locked = key.index % 8 >= activeColumns;
              return `
              <button
                class="deck-key color-${key.color} ${locked ? "is-locked" : deckKeyState(active, key.index)}"
                data-deck-key="${key.index}"
                ${locked ? "disabled" : ""}
              >${locked ? "LOCKED" : escapeHtml(key.label)}</button>
            `;
            },
          )
          .join("")}
      </div>
    </section>
  `;
}

function deckKeyState(
  task:
    | StreamDeckRouteTask
    | StreamDeckSequenceTask
    | StreamDeckHitInterstitial
    | null,
  keyIndex: number,
): string {
  if (task === null) {
    return "";
  }
  switch (task.kind) {
    case "streamdeck-route":
      return keyIndex === task.sourceKeyIndex && task.progress === 1
        ? "is-armed"
        : "";
    case "streamdeck-sequence":
      if (keyIndex === task.holdKeyIndex && task.progress > 0) {
        return "is-armed";
      }
      return keyIndex === task.tapKeyIndex && task.progress === 1
        ? "is-called"
        : "";
    case "streamdeck-hit":
      return keyIndex === task.keyIndex ? "is-override-target" : "";
  }
}

function uf8Simulator(consoleSnapshot: ConsoleSnapshot): string {
  const mission = consoleSnapshot.mission;
  if (mission === null || consoleSnapshot.phase.kind !== "playing") {
    return "";
  }
  if (
    consoleSnapshot.crew.uf8?.connection.kind !== "connected"
  ) {
    return "";
  }
  const activeChannels = consoleSnapshot.phase.activeControls.uf8Channels;
  return `
    <section class="sim-panel uf8-panel">
      <header><span>02</span><strong>SSL UF8</strong></header>
      <div class="fader-bank">
        ${Array.from({ length: 8 }, (_, channel) => {
          const cue = uf8SimulatorCue(mission.activity, channel);
          const locked = channel >= activeChannels;
          return `
            <label class="fader-strip ${locked ? "is-locked" : cue.isTarget ? "is-target" : ""}">
              <span>CH ${channel + 1}</span>
              <input data-uf8-fader="${channel}" type="range" min="0" max="100" value="${Math.round(consoleSnapshot.uf8Faders[channel] ?? 0)}" orient="vertical" ${locked ? "disabled" : ""} />
              <small>${locked ? "LOCKED" : escapeHtml(cue.label)}</small>
            </label>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function uf8SimulatorCue(
  activity: MissionActivity,
  channel: number,
): { isTarget: boolean; label: string } {
  switch (activity.kind) {
    case "orders": {
      const task = activity.tasks.find(
        (candidate): candidate is Uf8FaderTask =>
          candidate.kind === "uf8-fader",
      );
      if (task === undefined || channel !== task.channel) {
        return { isTarget: false, label: "—" };
      }
      return { isTarget: true, label: task.label };
    }
    case "interstitial":
      return activity.task.kind === "uf8-bottom-out" &&
        channel < activity.task.channelCount
        ? { isTarget: true, label: "TO −INF" }
        : { isTarget: false, label: "—" };
    case "reactor-procedure": {
      const target = activity.procedure.profile.targets.find(
        (candidate) => candidate.channel === channel,
      );
      return target === undefined
        ? { isTarget: false, label: "—" }
        : {
            isTarget: true,
            label: `${target.label} ${target.stop.label}`,
          };
    }
  }
}

function pushSimulator(consoleSnapshot: ConsoleSnapshot): string {
  const mission = consoleSnapshot.mission;
  if (
    mission === null ||
    consoleSnapshot.phase.kind !== "playing" ||
    consoleSnapshot.crew.push?.connection.kind !== "connected"
  ) {
    return "";
  }
  let active: PushPathTask | PushCornersInterstitial | null = null;
  switch (mission.activity.kind) {
    case "orders":
      active =
        mission.activity.tasks.find(
          (task): task is PushPathTask => task.kind === "push-path",
        ) ?? null;
      break;
    case "interstitial":
      active =
        mission.activity.task.kind === "push-corners"
          ? mission.activity.task
          : null;
      break;
    case "reactor-procedure":
      break;
  }
  const activeGridSize = consoleSnapshot.phase.activeControls.pushGridSize;
  return `
    <section class="sim-panel push-panel">
      <header><span>03</span><strong>ABLETON PUSH</strong></header>
      <div class="push-grid">
        ${gridPoints()
          .map((point) => {
            const locked =
              point.x >= activeGridSize || point.y >= activeGridSize;
            const state = locked ? "is-locked" : pushPadState(active, point);
            return `<button class="push-pad ${state}" data-push-x="${point.x}" data-push-y="${point.y}" aria-label="Push pad ${point.x + 1}, ${point.y + 1}" ${locked ? "disabled" : ""}></button>`;
          })
          .join("")}
      </div>
    </section>
  `;
}

function pushPadState(
  task: PushPathTask | PushCornersInterstitial | null,
  point: GridPoint,
): string {
  if (task === null) {
    return "";
  }
  switch (task.kind) {
    case "push-path": {
      const pathIndex = task.path.findIndex(
        (candidate) => candidate.x === point.x && candidate.y === point.y,
      );
      if (pathIndex < 0) {
        return "";
      }
      if (pathIndex < task.progress) {
        return "is-complete";
      }
      return pathIndex === task.progress
        ? `is-path is-next color-${task.color}`
        : `is-path color-${task.color}`;
    }
    case "push-corners": {
      const farEdge = task.gridSize - 1;
      const isCorner =
        (point.x === 0 || point.x === farEdge) &&
        (point.y === 0 || point.y === farEdge);
      if (!isCorner) {
        return "";
      }
      const pressed = task.pressed.some(
        (candidate) =>
          candidate.x === point.x && candidate.y === point.y,
      );
      return pressed ? "is-complete" : "is-path is-next color-lime";
    }
  }
}

function bindConsoleActions(consoleSnapshot: ConsoleSnapshot): void {
  for (const input of document.querySelectorAll<HTMLInputElement>(".js-game-toggle")) {
    input.addEventListener("change", () => {
      const kind = input.dataset["kind"] as GameTaskKind | undefined;
      if (kind === undefined) {
        return;
      }
      const settings: ActivitySettings = {
        ...consoleSnapshot.activitySettings,
        [kind]: input.checked,
      };
      send({ type: "set-activity-settings", settings });
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(".js-trigger")) {
    button.addEventListener("click", () => {
      const kind = button.dataset["kind"] as GameTaskKind | undefined;
      if (kind !== undefined) {
        send({ type: "trigger-activity", kind });
      }
    });
  }
  bindMidiActions();
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
      if (consoleSnapshot.mission === null) {
        throw new Error("Deck simulator requires an active mission");
      }
      sendHardware({
        kind: "streamdeck-key",
        keyIndex,
        phase: simulatedDeckPhase(
          consoleSnapshot.mission.activity,
          keyIndex,
        ),
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

function simulatedDeckPhase(
  activity: MissionActivity,
  keyIndex: number,
): "down" | "up" {
  if (activity.kind !== "orders") {
    return "down";
  }
  const task = activity.tasks.find(
    (candidate): candidate is StreamDeckSequenceTask =>
      candidate.kind === "streamdeck-sequence",
  );
  return task !== undefined &&
    task.progress === 2 &&
    keyIndex === task.holdKeyIndex
    ? "up"
    : "down";
}

function hardwarePanelMarkup(consoleSnapshot: ConsoleSnapshot): string {
  const bridge = midiBridge;
  if (bridge === null) {
    return "";
  }
  const view = bridge.view();
  const streamDeckStatus = consoleSnapshot.streamDeckConnected
    ? "CONNECTED"
    : "WAITING FOR PLUGIN";
  const pushBridgeStatus = consoleSnapshot.pushBridgeConnected
    ? "CONNECTED"
    : "WEB MIDI OR BRIDGE";
  const uf8Connected = consoleSnapshot.uf8Connection.kind === "connected";
  const uf8Status = uf8Connected ? "DIRECT LINK" : "RECONNECTING";
  const uf8Detail =
    consoleSnapshot.uf8Connection.kind === "connected"
      ? `Serial ${consoleSnapshot.uf8Connection.serial} · custom displays and 8 faders`
      : consoleSnapshot.uf8Connection.message;
  let midiContent = "";
  switch (view.status) {
    case "unsupported":
      midiContent = `
        <div class="midi-device station-push">
          ${pushDeviceTitle("WEB MIDI UNAVAILABLE")}
          <p class="hardware-note">Push setup needs Chrome Web MIDI on the hardware laptop.</p>
        </div>
      `;
      break;
    case "idle":
    case "requesting":
      midiContent = `
        <div class="midi-device station-push">
          ${pushDeviceTitle("NOT CONFIGURED")}
          <button id="enable-midi" class="secondary-button" ${view.status === "requesting" ? "disabled" : ""}>
            ${view.status === "requesting" ? "REQUESTING MIDI…" : "ENABLE PUSH MIDI"}
          </button>
        </div>
      `;
      break;
    case "error":
      midiContent = `
        <div class="midi-device station-push">
          ${pushDeviceTitle("MIDI ERROR")}
          <p class="hardware-note is-error">${escapeHtml(view.error)}</p>
          <button id="enable-midi" class="secondary-button">TRY PUSH MIDI AGAIN</button>
        </div>
      `;
      break;
    case "ready":
      midiContent = `
        <div class="midi-device station-push">
          ${pushDeviceTitle(view.configuration.pushGrid === null ? "GRID UNMAPPED" : "GRID READY")}
          <label>
            USER INPUT
            <select id="push-midi-input">
              ${midiOptions(view.inputs, view.configuration.pushInputId, "Select Push User input")}
            </select>
          </label>
          <label>
            USER OUTPUT
            <select id="push-midi-output">
              ${midiOptions(view.outputs, view.configuration.pushOutputId, "Select Push User output")}
            </select>
          </label>
          <button id="learn-push" class="secondary-button">LEARN 3 GRID CORNERS</button>
        </div>
      `;
      break;
  }
  return `
    <section class="hardware-setup">
      <div class="hardware-setup-heading">
        <div>
          <div class="eyebrow">DEVICE BRIDGE</div>
          <h2>Physical controls</h2>
        </div>
        <div class="hardware-bridge-states">
          <div class="deck-bridge-state ${consoleSnapshot.streamDeckConnected ? "is-connected" : ""}">
            <i></i><span>STREAM DECK</span><strong>${streamDeckStatus}</strong>
          </div>
          <div class="deck-bridge-state ${uf8Connected ? "is-connected" : ""}">
            <i></i><span>SSL UF8</span><strong>${uf8Status}</strong>
          </div>
        </div>
        <div class="deck-bridge-state ${consoleSnapshot.pushBridgeConnected ? "is-connected" : ""}">
          <i></i><span>PUSH BRIDGE</span><strong>${pushBridgeStatus}</strong>
        </div>
      </div>
      <div class="midi-device-grid">
        <div class="midi-device station-uf8">
          <div class="hardware-device-title">
            <span class="station-indicator"></span>
            <strong>SSL UF8</strong>
            <small>${uf8Connected ? "SERVER OWNED" : "OFFLINE"}</small>
          </div>
          <p class="direct-device-note ${uf8Connected ? "" : "is-error"}">${escapeHtml(uf8Detail)}</p>
          <div class="uf8-input-monitor" aria-label="Live UF8 fader input">
            ${consoleSnapshot.uf8Faders
              .map(
                (value, channel) => `
                  <div>
                    <i style="--fader-level: ${Math.round(value)}%"></i>
                    <span>${channel + 1}</span>
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>
        ${midiContent}
      </div>
      ${
        view.learnText.length === 0
          ? ""
          : `
            <div class="learn-banner">
              <span>${escapeHtml(view.learnText)}</span>
              <button id="cancel-midi-learn">CANCEL</button>
            </div>
          `
      }
      ${view.error.length > 0 && view.status !== "error" ? `<p class="hardware-note is-error">${escapeHtml(view.error)}</p>` : ""}
    </section>
  `;
}

function pushDeviceTitle(status: string): string {
  return `
    <div class="hardware-device-title">
      <span class="station-indicator"></span>
      <strong>ABLETON PUSH</strong>
      <small>${status}</small>
    </div>
  `;
}

function bindMidiActions(): void {
  const bridge = midiBridge;
  if (bridge === null) {
    return;
  }
  document.querySelector("#enable-midi")?.addEventListener("click", () => {
    void bridge.requestAccess();
  });
  document
    .querySelector<HTMLSelectElement>("#push-midi-input")
    ?.addEventListener("change", (event) => {
      const select = event.currentTarget;
      if (!(select instanceof HTMLSelectElement)) {
        throw new Error("Push MIDI selection did not come from a select");
      }
      bridge.setPushInput(select.value.length === 0 ? null : select.value);
    });
  document
    .querySelector<HTMLSelectElement>("#push-midi-output")
    ?.addEventListener("change", (event) => {
      const select = event.currentTarget;
      if (!(select instanceof HTMLSelectElement)) {
        throw new Error("Push output selection did not come from a select");
      }
      bridge.setPushOutput(select.value.length === 0 ? null : select.value);
    });
  document.querySelector("#learn-push")?.addEventListener("click", () => {
    bridge.learnPushGrid();
  });
  document
    .querySelector("#cancel-midi-learn")
    ?.addEventListener("click", () => {
      bridge.cancelLearn();
    });
}

function midiOptions(
  devices: readonly MidiDeviceOption[],
  selectedId: string | null,
  placeholder: string,
): string {
  return `
    <option value="">${escapeHtml(placeholder)}</option>
    ${devices
      .map(
        (device) =>
          `<option value="${escapeHtml(device.id)}" ${device.id === selectedId ? "selected" : ""}>${escapeHtml(device.label)}</option>`,
      )
      .join("")}
  `;
}

function missionMeterMarkup(phase: Extract<MissionPhaseView, { kind: "playing" }>): string {
  return `
    <div class="mission-meter">
      <div><span>LEVEL</span><strong>${phase.level}/5</strong></div>
      <div><span>CLEARED</span><strong>${phase.levelObjectivesCompleted}/${phase.levelObjectiveTarget}</strong></div>
      <div class="integrity"><span>INTEGRITY</span><strong>${Math.round(phase.integrity)}%</strong></div>
      <div><span>SCORE · COMBO</span><strong>${phase.score.toLocaleString()} · ×${phase.combo}</strong></div>
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
  const connected = isCrewMemberConnected(member);
  return `
    <div class="crew-chip ${connected ? "is-online" : ""}">
      <i></i>
      <span>${stationShortName(station)}</span>
      <strong>${connected ? escapeHtml(member.name) : "—"}</strong>
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
    case "streamdeck-sequence": {
      const hold =
        consoleSnapshot.mission.streamDeckKeys[task.holdKeyIndex];
      const tap =
        consoleSnapshot.mission.streamDeckKeys[task.tapKeyIndex];
      if (hold === undefined || tap === undefined) {
        throw new Error("Stream Deck sequence points outside layout");
      }
      return `HOLD ${escapeHtml(hold.label)}, TAP ${escapeHtml(tap.label)}, RELEASE ${escapeHtml(hold.label)}`;
    }
    case "uf8-fader":
      return `SET ${escapeHtml(task.label)} TO ${escapeHtml(task.target.label)}`;
    case "push-path":
      return `TRACE THE ${task.color.toUpperCase()} VECTOR`;
    case "push-defend":
      return "DEFEND THE MOTHERSHIP";
    case "push-console": {
      const label = task.labels[task.targetIndex] ?? "?";
      return task.action.kind === "scale"
        ? `SCALE ${escapeHtml(label)} TO ${task.action.value}`
        : `${escapeHtml(task.action.verb)} ${escapeHtml(label)}`;
    }
    case "push-review":
      return `${task.decision.toUpperCase()} "${escapeHtml(task.subject)} ${escapeHtml(task.verb)}"`;
    case "push-cow":
      return task.action === "abduct" ? "ABDUCT THE COW" : "RELEASE THE COW";
  }
}

function taskProgress(task: ActiveTask): string {
  switch (task.kind) {
    case "streamdeck-route":
      return task.progress === 0 ? "WAITING FOR SOURCE" : "SOURCE LOCKED";
    case "streamdeck-sequence":
      switch (task.progress) {
        case 0:
          return "WAITING FOR HOLD";
        case 1:
          return "HELD — WAITING FOR TAP";
        case 2:
          return "TAPPED — RELEASE HOLD";
      }
    case "uf8-fader":
      return task.withinSince === null ? "OUTSIDE TARGET BAND" : "HOLDING";
    case "push-path":
      return `${task.progress}/${task.path.length} PADS`;
    case "push-defend":
      return `SPEED ${task.missileSpeed} - SURVIVE TO DEADLINE`;
    case "push-console":
      if (task.action.kind === "scale" && task.verbDone && task.labelDone) {
        return `DIALING ${task.value}/${task.action.value}`;
      }
      return task.verbDone || task.labelDone
        ? "PARTIALLY ENTERED"
        : "WAITING FOR CONSOLE";
    case "push-review":
      return "AWAITING JUDGEMENT";
    case "push-cow":
      return "TRACTOR BEAM ENGAGED";
  }
}

function updateLiveNumbers(): void {
  const now = Date.now();
  for (const element of document.querySelectorAll<HTMLElement>("[data-countdown]")) {
    const endsAt = Number(element.dataset["countdown"]);
    element.textContent = String(Math.max(1, Math.ceil((endsAt - now) / 1_000)));
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-deadline]")) {
    const deadline = Number(element.dataset["deadline"]);
    const startedAt = Number(element.dataset["startedAt"]);
    const remaining = Math.max(0, deadline - now);
    const duration = deadline - startedAt;
    element.style.scale = `${Math.min(1, remaining / duration)} 1`;
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
      typeof value.crewId === "string" &&
      typeof value.name === "string"
    ) {
      return {
        crewId: value.crewId,
        name: value.name,
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

function clearSavedCrew(): void {
  window.localStorage.removeItem("synthteam-crew");
}

function emptyCrew(): CrewSlots {
  return { streamdeck: null, uf8: null, push: null };
}

function connectedCrewCount(crew: CrewSlots): number {
  return STATIONS.filter(
    (station) => crew[station]?.connection.kind === "connected",
  ).length;
}

function firstUnclaimedCrewStation(crew: CrewSlots): Station | null {
  for (const station of STATIONS) {
    if (crew[station] === null) {
      return station;
    }
  }
  return null;
}

function selectedClaimStation(crew: CrewSlots): Station | null {
  if (
    joinSelectedStation !== null &&
    crew[joinSelectedStation] === null &&
    stationHasHardware(joinSelectedStation)
  ) {
    return joinSelectedStation;
  }
  const first = firstUnclaimedCrewStation(crew);
  return first !== null && stationHasHardware(first) ? first : null;
}

function stationHasHardware(station: Station): boolean {
  return snapshot === null
    ? false
    : stationHardwareAvailable(snapshot, station);
}

function stationClaimStatus(member: CrewMember | null): string {
  if (member === null) {
    return "OPEN";
  }
  switch (member.connection.kind) {
    case "connected":
      return "CLAIMED";
    case "reserved":
      return "RESERVED";
  }
}

function isCrewMemberConnected(
  member: CrewMember | null,
): member is CrewMember {
  return member?.connection.kind === "connected";
}

function stationFromFormValue(value: string): Station {
  switch (value) {
    case "streamdeck":
    case "uf8":
    case "push":
      return value;
    default:
      throw new Error(`Invalid station selection: ${value}`);
  }
}

function lobbyStartLabel(connectedCount: number): string {
  switch (connectedCount) {
    case 0:
      return "WAITING FOR 2 PHONES";
    case 1:
      return "WAITING FOR 1 PHONE";
    case 2:
      return "START 2-CREW MISSION";
    case 3:
      return "START 3-CREW MISSION";
    default:
      throw new Error(`Unexpected crew count: ${connectedCount}`);
  }
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
