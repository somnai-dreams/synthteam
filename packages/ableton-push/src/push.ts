/// <reference types="w3c-web-usb" />

import {
  Input,
  type MidiMessage,
  Output,
} from "@julusian/midi";
import { WebUSB } from "usb";
import {
  decodePushMidiMessage,
  pushButtonMidiMessage,
  pushPadMidiMessage,
  type PushInputEvent,
  PUSH_DISPLAY_FRAME_BYTES,
  PUSH_DISPLAY_HEADER,
  writePushDisplayFrame,
} from "./protocol.ts";

export type PushModel = "push2" | "push3";

export type PushOpenOptions = {
  model?: PushModel;
  display?: boolean;
  midiPortName?: string;
};

export type PushInputListener = (event: PushInputEvent) => void;

type PushModelConfig = {
  productId: number;
  midiPortMatch: string;
};

type MidiPortCollection = {
  getPortCount: () => number;
  getPortName: (index: number) => string;
};

const ABLETON_VENDOR_ID = 0x2982;
const DISPLAY_KEEPALIVE_MS = 900;

export class PushDisplay {
  readonly #productId: number;
  readonly #headerBuffer: ArrayBuffer;
  readonly #frameBuffer = new ArrayBuffer(PUSH_DISPLAY_FRAME_BYTES);
  readonly #frame = new Uint8Array(this.#frameBuffer);
  #device: USBDevice | null = null;
  #keepalive: ReturnType<typeof setInterval> | null = null;
  #sending = false;
  #dirty = false;

  constructor(productId: number) {
    this.#productId = productId;
    this.#headerBuffer = new ArrayBuffer(PUSH_DISPLAY_HEADER.byteLength);
    new Uint8Array(this.#headerBuffer).set(PUSH_DISPLAY_HEADER);
  }

  get isOpen(): boolean {
    return this.#device !== null;
  }

  async open(): Promise<void> {
    if (this.#device !== null) {
      return;
    }
    const webusb = new WebUSB({ allowAllDevices: true });
    const device = await webusb.requestDevice({
      filters: [
        {
          vendorId: ABLETON_VENDOR_ID,
          productId: this.#productId,
        },
      ],
    });
    try {
      await device.open();
      await device.claimInterface(0);
      this.#device = device;
      this.#keepalive = setInterval(() => {
        void this.#flush();
      }, DISPLAY_KEEPALIVE_MS);
    } catch (error) {
      if (device.opened) {
        await device.close();
      }
      throw error;
    }
  }

  async rgba(rgba: Uint8Array): Promise<void> {
    if (this.#device === null) {
      throw new Error("Cannot draw to a closed Push display");
    }
    writePushDisplayFrame(rgba, this.#frame);
    this.#dirty = true;
    await this.#flush();
  }

  async close(): Promise<void> {
    const keepalive = this.#keepalive;
    if (keepalive !== null) {
      clearInterval(keepalive);
      this.#keepalive = null;
    }
    const device = this.#device;
    if (device === null) {
      return;
    }
    this.#device = null;
    try {
      await device.releaseInterface(0);
    } finally {
      await device.close();
    }
  }

  async #flush(): Promise<void> {
    const device = this.#device;
    if (device === null || this.#sending) {
      return;
    }
    this.#sending = true;
    this.#dirty = false;
    try {
      await device.transferOut(1, this.#headerBuffer);
      await device.transferOut(1, this.#frameBuffer);
    } finally {
      this.#sending = false;
    }
    if (this.#dirty) {
      await this.#flush();
    }
  }
}

export class AbletonPush {
  readonly model: PushModel;
  readonly display: PushDisplay;
  readonly #input: Input;
  readonly #output: Output;
  readonly #listeners: PushInputListener[] = [];
  #closed = false;

  private constructor(
    model: PushModel,
    display: PushDisplay,
    input: Input,
    output: Output,
  ) {
    this.model = model;
    this.display = display;
    this.#input = input;
    this.#output = output;
  }

  static async open(
    options: PushOpenOptions = {},
  ): Promise<AbletonPush> {
    const model = options.model ?? "push3";
    const config = pushModelConfig(model);
    const portMatch = options.midiPortName ?? config.midiPortMatch;
    const input = new Input();
    const output = new Output();
    const display = new PushDisplay(config.productId);
    const push = new AbletonPush(model, display, input, output);

    try {
      input.openPort(findMidiPort(input, portMatch));
      output.openPort(findMidiPort(output, portMatch));
      input.on(
        "message",
        (_delta: number, message: MidiMessage) => {
          const event = decodePushMidiMessage(message);
          if (event !== null) {
            push.#emit(event);
          }
        },
      );
      if (options.display !== false) {
        await display.open();
      }
      return push;
    } catch (error) {
      if (input.isPortOpen()) {
        input.closePort();
      }
      if (output.isPortOpen()) {
        output.closePort();
      }
      await display.close();
      throw error;
    }
  }

  onInput(listener: PushInputListener): () => void {
    this.#listeners.push(listener);
    return () => {
      const index = this.#listeners.indexOf(listener);
      if (index >= 0) {
        this.#listeners.splice(index, 1);
      }
    };
  }

  setPad(
    x: number,
    y: number,
    colour: number,
    channel = 0,
  ): void {
    this.#assertOpen();
    this.#output.sendMessage(
      pushPadMidiMessage(x, y, colour, channel),
    );
  }

  setButton(
    cc: number,
    colour: number,
    channel = 0,
  ): void {
    this.#assertOpen();
    this.#output.sendMessage(
      pushButtonMidiMessage(cc, colour, channel),
    );
  }

  clearPads(): void {
    this.#assertOpen();
    for (let note = 36; note <= 99; note += 1) {
      this.#output.sendMessage([0x90, note, 0]);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    if (this.#output.isPortOpen()) {
      for (let note = 36; note <= 99; note += 1) {
        this.#output.sendMessage([0x90, note, 0]);
      }
    }
    if (this.#input.isPortOpen()) {
      this.#input.closePort();
    }
    if (this.#output.isPortOpen()) {
      this.#output.closePort();
    }
    this.#listeners.length = 0;
    await this.display.close();
  }

  #emit(event: PushInputEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Cannot use a closed Push");
    }
  }
}

function pushModelConfig(model: PushModel): PushModelConfig {
  switch (model) {
    case "push2":
      return {
        productId: 0x1967,
        midiPortMatch: "Push 2",
      };
    case "push3":
      return {
        productId: 0x1969,
        midiPortMatch: "Push 3 Live Port",
      };
  }
}

function findMidiPort(
  ports: MidiPortCollection,
  nameFragment: string,
): number {
  for (let index = 0; index < ports.getPortCount(); index += 1) {
    if (ports.getPortName(index).includes(nameFragment)) {
      return index;
    }
  }
  throw new Error(
    `No MIDI port matching "${nameFragment}" — is Push connected?`,
  );
}
