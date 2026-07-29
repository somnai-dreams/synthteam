import { describe, expect, test } from "bun:test";
import {
  decodePushMidiMessage,
  HEIGHT,
  isPushRgbButton,
  pushButtonMidiMessage,
  pushPadMidiMessage,
  PUSH_DISPLAY_FRAME_BYTES,
  PUSH_DISPLAY_RGBA_BYTES,
  WIDTH,
  writePushDisplayFrame,
} from "../src/protocol.ts";

describe("Push MIDI protocol", () => {
  test("decodes pads with bottom-left coordinates", () => {
    expect(decodePushMidiMessage([0x90, 36, 100])).toEqual({
      kind: "pad",
      x: 0,
      y: 0,
      down: true,
      velocity: 100,
    });
    expect(decodePushMidiMessage([0x80, 99, 0])).toEqual({
      kind: "pad",
      x: 7,
      y: 7,
      down: false,
      velocity: 0,
    });
  });

  test("decodes strip position and touch", () => {
    expect(decodePushMidiMessage([0xe0, 0, 64])).toEqual({
      kind: "strip",
      value: 8_192,
    });
    expect(decodePushMidiMessage([0x90, 12, 127])).toEqual({
      kind: "strip-touch",
      down: true,
    });
  });

  test("decodes encoders, dial gestures, and buttons", () => {
    expect(decodePushMidiMessage([0xb0, 71, 127])).toEqual({
      kind: "encoder",
      control: { kind: "display", index: 1 },
      cc: 71,
      step: -1,
    });
    expect(decodePushMidiMessage([0xb0, 79, 1])).toEqual({
      kind: "encoder",
      control: { kind: "master" },
      cc: 79,
      step: 1,
    });
    expect(decodePushMidiMessage([0xb0, 70, 127])).toEqual({
      kind: "dial",
      gesture: "turn",
      value: -1,
    });
    expect(decodePushMidiMessage([0xb0, 94, 127])).toEqual({
      kind: "dial",
      gesture: "press",
      value: 127,
    });
    expect(decodePushMidiMessage([0xb0, 60, 127])).toEqual({
      kind: "button",
      cc: 60,
      down: true,
    });
  });

  test("rejects malformed or unrelated MIDI", () => {
    expect(decodePushMidiMessage([0x90, 36])).toBeNull();
    expect(decodePushMidiMessage([0x90, 100, 127])).toBeNull();
    expect(decodePushMidiMessage([0xf0, 1, 2])).toBeNull();
    expect(decodePushMidiMessage([0x90, -1, 2])).toBeNull();
  });

  test("encodes validated pad and button lighting", () => {
    expect(pushPadMidiMessage(7, 7, 54, 10)).toEqual([
      0x9a, 99, 54,
    ]);
    expect(pushButtonMidiMessage(102, 22, 6)).toEqual([
      0xb6, 102, 22,
    ]);
    expect(() => pushPadMidiMessage(8, 0, 1)).toThrow(RangeError);
    expect(() => pushButtonMidiMessage(128, 1)).toThrow(RangeError);
    expect(isPushRgbButton(102)).toBeTrue();
    expect(isPushRgbButton(58)).toBeFalse();
  });
});

describe("Push display protocol", () => {
  test("converts RGBA pixels and fills line padding in place", () => {
    expect(PUSH_DISPLAY_RGBA_BYTES).toBe(WIDTH * HEIGHT * 4);
    const rgba = new Uint8Array(PUSH_DISPLAY_RGBA_BYTES);
    rgba[0] = 255;
    rgba[1] = 255;
    rgba[2] = 255;
    const frame = new Uint8Array(PUSH_DISPLAY_FRAME_BYTES);

    writePushDisplayFrame(rgba, frame);

    expect(Array.from(frame.slice(0, 4))).toEqual([
      0x18, 0x0c, 0xe7, 0xff,
    ]);
    expect(Array.from(frame.slice(1_920, 1_924))).toEqual([
      0xe7, 0xf3, 0xe7, 0xff,
    ]);
  });

  test("requires exact reusable input and output buffers", () => {
    expect(() =>
      writePushDisplayFrame(
        new Uint8Array(PUSH_DISPLAY_RGBA_BYTES - 1),
        new Uint8Array(PUSH_DISPLAY_FRAME_BYTES),
      ),
    ).toThrow(RangeError);
    expect(() =>
      writePushDisplayFrame(
        new Uint8Array(PUSH_DISPLAY_RGBA_BYTES),
        new Uint8Array(PUSH_DISPLAY_FRAME_BYTES - 1),
      ),
    ).toThrow(RangeError);
  });
});
