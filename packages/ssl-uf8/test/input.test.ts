import { describe, expect, test } from "bun:test";
import { decodeUf8InputEvent } from "../src/input.ts";

describe("UF8 native input", () => {
  test("decodes 15-bit fader positions", () => {
    expect(
      decodeUf8InputEvent({
        code: 33,
        payload: new Uint8Array([3, 0xff, 0x7f]),
      }),
    ).toEqual({
      kind: "fader",
      index: 3,
      position: 32_767,
      normalized: 1,
    });
  });

  test("decodes extended absolute-encoder positions", () => {
    expect(
      decodeUf8InputEvent({
        code: 33,
        payload: new Uint8Array([12, 0x00, 0x40, 1]),
      }),
    ).toEqual({
      kind: "encoder",
      index: 12,
      position: 16_384,
      normalized: 16_384 / 32_767,
    });
  });

  test("rejects unknown, out-of-range, and malformed input", () => {
    expect(
      decodeUf8InputEvent({
        code: 34,
        payload: new Uint8Array([3, 0xff, 0x7f]),
      }),
    ).toBeNull();
    expect(
      decodeUf8InputEvent({
        code: 33,
        payload: new Uint8Array([8, 0xff, 0x7f]),
      }),
    ).toBeNull();
    expect(
      decodeUf8InputEvent({
        code: 33,
        payload: new Uint8Array([3, 0x00, 0x80]),
      }),
    ).toBeNull();
    expect(
      decodeUf8InputEvent({
        code: 33,
        payload: new Uint8Array([3, 0xff, 0x7f, 2]),
      }),
    ).toBeNull();
  });
});
