// push3.js — a JS library for the Ableton Push 3, pads + LEDs + SCREEN.
//
// API in the spirit of garrensmith/abletonpush (EventEmitter over MIDI),
// adapted for Push 3 and extended with the display, which that library
// never had. Runs under Node and Bun via `usb` (WebUSB-shaped API) and
// `@julusian/midi`; the MIDI/display protocol matches Ableton's Push 2
// interface docs — Push 3 only changes the USB product id.
//
// Events:
//   pad      {x, y, down, velocity}   8x8 grid, (0,0) bottom-left
//   encoder  {index, step}            top encoders 1-8, relative step
//   dial     {gesture, value}         big dial: turn/press/left/right
//
// Display: push.display.rgba(buffer) sends a 960x160 RGBA frame.
// The hardware blanks after ~2s without frames; the library resends
// the last frame automatically to keep the image alive.

import { EventEmitter } from "node:events";
import midiPkg from "@julusian/midi";
import usbPkg from "usb";

const { WebUSB } = usbPkg;

export const WIDTH = 960;
export const HEIGHT = 160;

const VENDOR_ID = 0x2982;
const PRODUCT_ID = 0x1969; // Push 2 would be 0x1967
const PORT_MATCH = "Push 3 Live Port";

const PAD_LOW = 36;
const PAD_HIGH = 99;
const LINE_BYTES = 2048; // 960 px * 2 bytes + 128 padding
const FRAME_BYTES = LINE_BYTES * HEIGHT;
const HEADER = Buffer.from([
  0xff, 0xcc, 0xaa, 0x88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const XOR = [0xe7, 0xf3, 0xe7, 0xff];
const KEEPALIVE_MS = 900;

// A few good pad LED palette entries (velocity values).
export const PAD_COLORS = {
  off: 0,
  white: 3,
  red: 6,
  amber: 10,
  yellow: 14,
  lime: 18,
  green: 22,
  cyan: 34,
  sky: 38,
  blue: 46,
  magenta: 54,
  pink: 58,
  orange: 65,
  violet: 79,
};

export class Push3Display {
  #device = null;
  #frame = Buffer.alloc(FRAME_BYTES);
  #keepalive = null;
  #sending = false;
  #dirty = false;

  async open() {
    const webusb = new WebUSB({ allowAllDevices: true });
    this.#device = await webusb.requestDevice({
      filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }],
    });
    await this.#device.open();
    await this.#device.claimInterface(0);
    this.#keepalive = setInterval(() => {
      void this.#flush();
    }, KEEPALIVE_MS);
  }

  /** Send a WIDTH x HEIGHT RGBA buffer (e.g. from a canvas) to the screen. */
  rgba(buffer) {
    for (let y = 0; y < HEIGHT; y++) {
      let src = y * WIDTH * 4;
      let dst = y * LINE_BYTES;
      for (let x = 0; x < WIDTH; x++) {
        const r = buffer[src];
        const g = buffer[src + 1];
        const b = buffer[src + 2];
        // 16-bit pixel: blue high 5, green 6, red low 5 — then XOR shaping
        const pixel = ((b & 0xf8) << 8) | ((g & 0xfc) << 3) | (r >> 3);
        this.#frame[dst] = (pixel & 0xff) ^ XOR[dst % 4];
        this.#frame[dst + 1] = (pixel >> 8) ^ XOR[(dst + 1) % 4];
        src += 4;
        dst += 2;
      }
      for (; dst % LINE_BYTES !== 0; dst++) {
        this.#frame[dst] = XOR[dst % 4];
      }
    }
    this.#dirty = true;
    return this.#flush();
  }

  async #flush() {
    if (this.#device === null || this.#sending) {
      return;
    }
    this.#sending = true;
    this.#dirty = false;
    try {
      await this.#device.transferOut(1, HEADER);
      await this.#device.transferOut(1, this.#frame);
    } finally {
      this.#sending = false;
    }
    if (this.#dirty) {
      await this.#flush(); // a newer frame arrived while sending
    }
  }

  async close() {
    clearInterval(this.#keepalive);
    if (this.#device !== null) {
      const device = this.#device;
      this.#device = null;
      await device.releaseInterface(0);
      await device.close();
    }
  }
}

export class Push3 extends EventEmitter {
  #input = new midiPkg.Input();
  #output = new midiPkg.Output();
  display = new Push3Display();

  /** Open MIDI (and the display unless {display: false}). */
  static async open(options = {}) {
    const push = new Push3();
    const port = findPort(push.#input);
    push.#input.openPort(port);
    push.#output.openPort(findPort(push.#output));
    push.#input.on("message", (_delta, message) => {
      push.#onMidi(message);
    });
    if (options.display !== false) {
      await push.display.open();
    }
    return push;
  }

  #onMidi([status, data1, data2]) {
    const kind = status & 0xf0;
    if ((kind === 0x90 || kind === 0x80) && data1 >= PAD_LOW && data1 <= PAD_HIGH) {
      this.emit("pad", {
        x: (data1 - PAD_LOW) % 8,
        y: Math.floor((data1 - PAD_LOW) / 8),
        down: kind === 0x90 && data2 > 0,
        velocity: data2,
      });
    } else if (kind === 0xb0) {
      if (data1 >= 71 && data1 <= 78) {
        this.emit("encoder", {
          index: data1 - 70,
          step: data2 < 64 ? data2 : data2 - 128,
        });
      } else if (data1 === 70 || data1 === 93 || data1 === 94 || data1 === 95) {
        const gesture = { 70: "turn", 93: "left", 94: "press", 95: "right" }[data1];
        this.emit("dial", {
          gesture,
          value: data1 === 70 && data2 >= 64 ? data2 - 128 : data2,
        });
      }
    }
  }

  /** Light pad (x, y) with a palette index — see PAD_COLORS. */
  setPad(x, y, color) {
    this.#output.sendMessage([0x90, PAD_LOW + y * 8 + x, color]);
  }

  /**
   * Light a backlit button by its CC number with a palette index.
   * The row directly above the pads is CC 102-109 and the row under
   * the display is CC 20-27 (both RGB); most other buttons are
   * white-only and treat the value as brightness.
   */
  setButton(cc, color) {
    this.#output.sendMessage([0xb0, cc, color]);
  }

  clearPads() {
    for (let note = PAD_LOW; note <= PAD_HIGH; note++) {
      this.#output.sendMessage([0x90, note, 0]);
    }
  }

  async close() {
    this.clearPads();
    this.#input.closePort();
    this.#output.closePort();
    await this.display.close();
  }
}

function findPort(port) {
  for (let i = 0; i < port.getPortCount(); i++) {
    if (port.getPortName(i).includes(PORT_MATCH)) {
      return i;
    }
  }
  throw new Error(`No MIDI port matching "${PORT_MATCH}" — is the Push connected?`);
}
