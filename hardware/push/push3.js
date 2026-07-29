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


// Buttons with full RGB LEDs, from Ableton's official Push2-map.json
// (all other buttons are white-only: the value maps to brightness
// through a separate white palette). Push 3 additions like Save/Lock
// are white-only too.
export const RGB_BUTTON_CCS = new Set([
  20, 21, 22, 23, 24, 25, 26, 27,       // lower row (below display)
  102, 103, 104, 105, 106, 107, 108, 109, // upper row (above display)
  36, 37, 38, 39, 40, 41, 42, 43,       // scene column
  29, 60, 61, 85, 86, 89,               // stop, mute, solo, play, rec, automate
]);

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
    if (kind === 0xe0) {
      // Touch strip: 14-bit pitch bend, springs back to center (8192)
      this.emit("strip", { value: (data2 << 7) | data1 });
      return;
    }
    if ((kind === 0x90 || kind === 0x80) && data1 === 12) {
      this.emit("striptouch", { down: kind === 0x90 && data2 > 0 });
      return;
    }
    if ((kind === 0x90 || kind === 0x80) && data1 >= PAD_LOW && data1 <= PAD_HIGH) {
      this.emit("pad", {
        x: (data1 - PAD_LOW) % 8,
        y: Math.floor((data1 - PAD_LOW) / 8),
        down: kind === 0x90 && data2 > 0,
        velocity: data2,
      });
    } else if (kind === 0xb0) {
      if ((data1 >= 71 && data1 <= 79) || data1 === 14 || data1 === 15) {
        // Relative encoders: the 8 above the display (71-78), the big
        // master knob (79) and the small knob (14/15) — on Push 3 the
        // latter two sit top-left.
        this.emit("encoder", {
          index: data1 >= 71 && data1 <= 78 ? data1 - 70 : null,
          cc: data1,
          name:
            data1 === 79 ? "master"
            : data1 === 14 ? "small-1"
            : data1 === 15 ? "small-2"
            : `encoder-${data1 - 70}`,
          step: data2 < 64 ? data2 : data2 - 128,
        });
      } else if (data1 === 70 || data1 === 93 || data1 === 94 || data1 === 95) {
        const gesture = { 70: "turn", 93: "left", 94: "press", 95: "right" }[data1];
        this.emit("dial", {
          gesture,
          value: data1 === 70 && data2 >= 64 ? data2 - 128 : data2,
        });
      } else {
        // Everything else on the surface is a backlit button sending
        // 127 on press, 0 on release.
        this.emit("button", { cc: data1, down: data2 > 0 });
      }
    }
  }

  /**
   * Light pad (x, y) with a palette index — see PAD_COLORS.
   * `channel` selects the LED animation: 0 static, 1-5 one-shot fade,
   * 6-10 pulse, 11-15 blink (each group ordered 24th, 16th, 8th,
   * quarter, half note; synced to MIDI clock, 120 bpm by default).
   * Animations run from the last channel-0 color to this color.
   */
  setPad(x, y, color, channel = 0) {
    this.#output.sendMessage([0x90 | channel, PAD_LOW + y * 8 + x, color]);
  }

  /**
   * Light a backlit button by its CC number with a palette index.
   * The row directly above the pads is CC 102-109 and the row under
   * the display is CC 20-27 (both RGB, plus the scene column 36-43
   * and a few transport buttons); most other buttons are white-only
   * and map the palette index to brightness. `channel` animates as
   * in setPad.
   */
  setButton(cc, color, channel = 0) {
    this.#output.sendMessage([0xb0 | channel, cc, color]);
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
