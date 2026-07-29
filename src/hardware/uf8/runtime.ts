import type {
  Uf8ConnectionState,
  Uf8HardwareEvent,
} from "../../shared/domain.ts";
import {
  decodeUf8InputEvent,
  drawUf8DisplayBox,
  drawUf8DisplayText,
  listUf8Devices,
  rgb565,
  setUf8DisplayColour,
  setUf8FaderMotorEnabled,
  setUf8FaderPosition,
  uf8FaderPositionFromPercent,
  type Uf8Message,
  Uf8Session,
  UF8_DISPLAY_COUNT,
  UF8_DISPLAY_HEIGHT,
  UF8_DISPLAY_WIDTH,
  UF8_FADER_COUNT,
} from "@synthteam/ssl-uf8";
import {
  createUf8AnimationFrames,
  UF8_ANIMATION_INTERVAL_MS,
  type Uf8AnimationScene,
} from "./animation.ts";

export type Uf8DisplayStrip = {
  label: string;
  active: boolean;
  cue: {
    heading: string;
    value: string;
  } | null;
};

export type Uf8DisplayView = {
  scene: Uf8AnimationScene;
  strips: readonly Uf8DisplayStrip[];
};

export type Uf8RuntimeCallbacks = {
  onConnectionChange: (state: Uf8ConnectionState) => void;
  onFader: (event: Uf8HardwareEvent) => void;
};

const RETRY_DELAY_MS = 2_000;
const MOTOR_MOVE_MS = 650;
const BACKGROUND = rgb565(3, 5, 9);
const LOCKED_TEXT = rgb565(52, 61, 67);
const WHITE = rgb565(255, 255, 255);
const DISPLAY_COLOURS = [
  rgb565(255, 48, 88),
  rgb565(255, 126, 46),
  rgb565(250, 205, 55),
  rgb565(38, 210, 120),
  rgb565(25, 198, 218),
  rgb565(45, 116, 255),
  rgb565(139, 86, 255),
  rgb565(235, 69, 210),
] as const;

export class Uf8Runtime {
  readonly #callbacks: Uf8RuntimeCallbacks;
  #state: Uf8ConnectionState = {
    kind: "disconnected",
    message: "Starting direct UF8 bridge…",
  };
  #session: Uf8Session | null = null;
  #runPromise: Promise<void> | null = null;
  #stopping = false;
  #disableMotorsAt: number | null = null;
  #lastDisplaySignature = "";
  #displayView: Uf8DisplayView | null = null;
  #animationFrame = 0;
  #nextAnimationAt = 0;

  constructor(callbacks: Uf8RuntimeCallbacks) {
    this.#callbacks = callbacks;
  }

  get state(): Uf8ConnectionState {
    return this.#state;
  }

  start(): void {
    if (this.#runPromise !== null) {
      return;
    }
    this.#stopping = false;
    this.#runPromise = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#runPromise;
    this.#runPromise = null;
  }

  moveFadersTo(percent: number): void {
    const position = uf8FaderPositionFromPercent(percent);
    const session = this.#session;
    if (session === null) {
      return;
    }
    for (let index = 0; index < UF8_FADER_COUNT; index += 1) {
      session.write(setUf8FaderPosition(index, position));
    }
    for (let index = 0; index < UF8_FADER_COUNT; index += 1) {
      session.write(setUf8FaderMotorEnabled(index, true));
    }
    this.#disableMotorsAt = performance.now() + MOTOR_MOVE_MS;
  }

  render(view: Uf8DisplayView): void {
    const session = this.#session;
    if (session === null) {
      return;
    }
    const signature = JSON.stringify(view);
    if (signature === this.#lastDisplaySignature) {
      return;
    }
    for (const frame of createUf8DisplayFrames(view)) {
      session.write(frame);
    }
    this.#lastDisplaySignature = signature;
    this.#displayView = view;
    this.#animationFrame = 0;
    this.#nextAnimationAt = performance.now();
  }

  async #run(): Promise<void> {
    while (!this.#stopping) {
      let session: Uf8Session | null = null;
      try {
        const devices = listUf8Devices();
        if (devices.length !== 1) {
          this.#setState({
            kind: "disconnected",
            message:
              devices.length === 0
                ? "UF8 unavailable — quit SSL 360° or reconnect the controller"
                : "Multiple UF8 controllers found — connect only one for this game",
          });
          await Bun.sleep(RETRY_DELAY_MS);
          continue;
        }
        const device = devices[0];
        if (device === undefined) {
          throw new Error("UF8 discovery returned an inconsistent device list");
        }

        session = await Uf8Session.connect(device.serial);
        this.#session = session;
        this.#lastDisplaySignature = "";
        this.#displayView = null;
        this.#animationFrame = 0;
        this.#nextAnimationAt = 0;
        this.#setState({ kind: "connected", serial: session.serial });

        while (!this.#stopping && this.#session === session) {
          this.#pumpSession(session);
          await Bun.sleep(10);
        }
      } catch (error) {
        this.#setState({
          kind: "disconnected",
          message: `UF8 direct link lost — ${errorMessage(error)}`,
        });
        if (!this.#stopping) {
          await Bun.sleep(RETRY_DELAY_MS);
        }
      } finally {
        if (this.#session === session) {
          this.#session = null;
        }
        session?.close();
        this.#disableMotorsAt = null;
        this.#displayView = null;
        this.#nextAnimationAt = 0;
      }
    }
  }

  #pumpSession(session: Uf8Session): void {
    for (const message of session.pump()) {
      if (message.code === 6) {
        throw new Error("controller requested reconnection");
      }
      const event = decodeUf8FaderEvent(message);
      if (event !== null) {
        this.#callbacks.onFader(event);
      }
    }

    if (
      this.#disableMotorsAt !== null &&
      performance.now() >= this.#disableMotorsAt
    ) {
      for (let index = 0; index < UF8_FADER_COUNT; index += 1) {
        session.write(setUf8FaderMotorEnabled(index, false));
      }
      this.#disableMotorsAt = null;
    }

    const now = performance.now();
    const view = this.#displayView;
    if (
      view !== null &&
      now >= this.#nextAnimationAt
    ) {
      for (const frame of createUf8AnimationFrames(
        view.scene,
        view.strips,
        this.#animationFrame,
        Date.now(),
      )) {
        session.write(frame);
      }
      this.#animationFrame += 1;
      this.#nextAnimationAt = now + UF8_ANIMATION_INTERVAL_MS;
    }
  }

  #setState(state: Uf8ConnectionState): void {
    if (sameConnectionState(this.#state, state)) {
      return;
    }
    this.#state = state;
    this.#callbacks.onConnectionChange(state);
  }
}

export function decodeUf8FaderEvent(
  message: Uf8Message,
): Uf8HardwareEvent | null {
  const event = decodeUf8InputEvent(message);
  if (event === null || event.kind !== "fader") {
    return null;
  }
  return {
    kind: "uf8-fader",
    channel: event.index,
    value: event.normalized * 100,
  };
}

export function createUf8DisplayFrames(
  view: Uf8DisplayView,
): readonly Uint8Array[] {
  if (view.strips.length !== UF8_DISPLAY_COUNT) {
    throw new Error("UF8 display view must contain exactly eight strips");
  }
  const frames: Uint8Array[] = [];
  if (view.scene.kind !== "mission") {
    for (let index = 0; index < UF8_DISPLAY_COUNT; index += 1) {
      frames.push(
        drawUf8DisplayBox(
          index,
          0,
          0,
          UF8_DISPLAY_WIDTH,
          UF8_DISPLAY_HEIGHT,
          BACKGROUND,
        ),
      );
    }
    return frames;
  }
  for (let index = 0; index < UF8_DISPLAY_COUNT; index += 1) {
    const strip = view.strips[index];
    const accent = DISPLAY_COLOURS[index];
    if (strip === undefined || accent === undefined) {
      throw new Error(`UF8 display ${index} is missing its view`);
    }
    if (!strip.active) {
      frames.push(
        drawUf8DisplayBox(
          index,
          0,
          0,
          UF8_DISPLAY_WIDTH,
          UF8_DISPLAY_HEIGHT,
          BACKGROUND,
        ),
        setUf8DisplayColour(index, LOCKED_TEXT),
        drawUf8DisplayText(
          index,
          4,
          18,
          strip.label,
          "dejavu-sans-bold-14",
        ),
        drawUf8DisplayText(
          index,
          38,
          88,
          "LOCKED",
          "dejavu-sans-bold-10",
        ),
      );
      continue;
    }
    frames.push(
      drawUf8DisplayBox(
        index,
        0,
        0,
        UF8_DISPLAY_WIDTH,
        UF8_DISPLAY_HEIGHT,
        BACKGROUND,
      ),
      drawUf8DisplayBox(index, 0, 0, UF8_DISPLAY_WIDTH, 25, accent),
      setUf8DisplayColour(index, WHITE),
      drawUf8DisplayText(
        index,
        4,
        18,
        strip.label,
        "dejavu-sans-bold-14",
      ),
    );
  }
  return frames;
}

function sameConnectionState(
  left: Uf8ConnectionState,
  right: Uf8ConnectionState,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "disconnected":
      return right.kind === "disconnected" && left.message === right.message;
    case "connected":
      return right.kind === "connected" && left.serial === right.serial;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown controller error";
}
