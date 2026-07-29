import { describe, expect, test } from "bun:test";
import {
  drawUf8DisplayBox,
  drawUf8DisplayText,
  frameUf8Message,
  rgb565,
  setUf8DisplayColour,
  setUf8FaderMotorEnabled,
  setUf8FaderPosition,
} from "./protocol.ts";

describe("UF8 serial protocol", () => {
  test("frames a payload with the vendor additive checksum", () => {
    expect(frameUf8Message(100, [11, 0, 0xff, 0xff])).toEqual(
      new Uint8Array([0xff, 100, 4, 11, 0, 0xff, 0xff, 113]),
    );
  });

  test("encodes RGB565 display colours in little-endian order", () => {
    expect(rgb565(255, 0, 255)).toBe(0xf81f);
    expect(setUf8DisplayColour(2, 0xf81f)).toEqual(
      new Uint8Array([0xff, 100, 4, 11, 2, 0x1f, 0xf8, 140]),
    );
  });

  test("uses the compact UF8 box command and inclusive bounds", () => {
    expect(drawUf8DisplayBox(0, 0, 0, 128, 160, 0)).toEqual(
      new Uint8Array([
        0xff, 100, 8, 13, 0, 0, 127, 0, 159, 0, 0, 151,
      ]),
    );
  });

  test("encodes built-in font text as ASCII", () => {
    expect(
      drawUf8DisplayText(1, 4, 6, "FADER 2", "dejavu-sans-bold-14"),
    ).toEqual(
      new Uint8Array([
        0xff, 100, 13, 15, 1, 3, 4, 6, 7, 70, 65, 68, 69, 82, 32, 50, 73,
      ]),
    );
  });

  test("encodes fader position and motor enable packets", () => {
    expect(setUf8FaderPosition(7, 32767)).toEqual(
      new Uint8Array([0xff, 30, 3, 7, 0xff, 0x7f, 166]),
    );
    expect(setUf8FaderMotorEnabled(7, true)).toEqual(
      new Uint8Array([0xff, 29, 2, 7, 1, 39]),
    );
  });

  test("rejects drawing outside a physical UF8 display", () => {
    expect(() => drawUf8DisplayBox(0, 127, 0, 2, 1, 0)).toThrow(RangeError);
    expect(() =>
      drawUf8DisplayText(8, 0, 0, "NOPE", "dejavu-sans-bold-10"),
    ).toThrow(RangeError);
  });
});
