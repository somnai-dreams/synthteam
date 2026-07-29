import { describe, expect, test } from "bun:test";
import { UF8_CONTROL_LABELS } from "../../shared/domain.ts";
import {
  createUf8DisplayFrames,
  decodeUf8FaderEvent,
} from "./runtime.ts";
import { Uf8FrameDecoder } from "./protocol.ts";

describe("UF8 direct runtime boundary", () => {
  test("normalizes native fader positions to game percentages", () => {
    expect(
      decodeUf8FaderEvent({
        code: 33,
        payload: new Uint8Array([3, 0xff, 0x7f]),
      }),
    ).toEqual({ kind: "uf8-fader", channel: 3, value: 100 });

    expect(
      decodeUf8FaderEvent({
        code: 33,
        payload: new Uint8Array([4, 0x00, 0x40, 0]),
      }),
    ).toEqual({
      kind: "uf8-fader",
      channel: 4,
      value: (16_384 / 32_767) * 100,
    });
  });

  test("ignores absolute encoders and malformed fader packets", () => {
    expect(
      decodeUf8FaderEvent({
        code: 33,
        payload: new Uint8Array([4, 0x00, 0x40, 1]),
      }),
    ).toBeNull();
    expect(
      decodeUf8FaderEvent({
        code: 33,
        payload: new Uint8Array([8, 0x00, 0x40]),
      }),
    ).toBeNull();
    expect(
      decodeUf8FaderEvent({
        code: 34,
        payload: new Uint8Array([4, 0x00, 0x40]),
      }),
    ).toBeNull();
  });

  test("renders the static mission labels above the animated scene", () => {
    const frames = createUf8DisplayFrames({
      scene: { kind: "mission", activity: "reactor-procedure" },
      strips: UF8_CONTROL_LABELS.map((label, index) => ({
        label,
        cue:
          index === 2
            ? { heading: "REPORT CODE", value: "BETA" }
            : null,
      })),
    });
    const decoder = new Uf8FrameDecoder();
    const messages = frames.flatMap((frame) => decoder.push(frame));
    const text = messages
      .filter(
        (message) =>
          message.code === 100 &&
          message.payload[0] === 15 &&
          message.payload[1] === 2,
      )
      .map((message) => new TextDecoder().decode(message.payload.slice(6)));

    expect(frames).toHaveLength(32);
    expect(text).toContain("CORE PRESSURE");
    expect(text).not.toContain("REPORT CODE");
    expect(text).not.toContain("BETA");
  });

  test("gives full-screen scenes a clean display takeover", () => {
    const frames = createUf8DisplayFrames({
      scene: { kind: "attract" },
      strips: UF8_CONTROL_LABELS.map((label) => ({ label, cue: null })),
    });

    expect(frames).toHaveLength(8);
  });
});
