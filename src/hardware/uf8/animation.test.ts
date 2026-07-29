import { describe, expect, test } from "bun:test";
import { Uf8FrameDecoder } from "./protocol.ts";
import {
  createUf8AnimationFrames,
  createUf8AnimationResetFrames,
  UF8_ANIMATION_INTERVAL_MS,
} from "./animation.ts";

describe("UF8 display animation", () => {
  test("draws one track per display before animation begins", () => {
    const frames = createUf8AnimationResetFrames();
    const decoder = new Uf8FrameDecoder();
    const messages = frames.flatMap((frame) => decoder.push(frame));

    expect(UF8_ANIMATION_INTERVAL_MS).toBe(125);
    expect(frames).toHaveLength(8);
    expect(messages).toHaveLength(8);
    for (let displayIndex = 0; displayIndex < 8; displayIndex += 1) {
      const track = messages[displayIndex];
      expect(track?.payload.slice(0, 6)).toEqual(
        new Uint8Array([13, displayIndex, 12, 115, 142, 149]),
      );
    }
  });

  test("moves one comet across all eight displays", () => {
    const decoder = new Uf8FrameDecoder();
    const start = createUf8AnimationFrames(0).flatMap((frame) =>
      decoder.push(frame),
    );
    const nextDisplay = createUf8AnimationFrames(4).flatMap((frame) =>
      decoder.push(frame),
    );

    expect(start).toHaveLength(2);
    expect(start[0]?.payload.slice(1, 6)).toEqual(
      new Uint8Array([7, 96, 115, 142, 149]),
    );
    expect(start[1]?.payload.slice(1, 6)).toEqual(
      new Uint8Array([0, 12, 31, 142, 149]),
    );
    expect(nextDisplay[1]?.payload.slice(1, 6)).toEqual(
      new Uint8Array([1, 12, 31, 142, 149]),
    );
  });

  test("loops deterministically and rejects invalid frame indices", () => {
    expect(createUf8AnimationFrames(32)).toEqual(
      createUf8AnimationFrames(0),
    );
    expect(() => createUf8AnimationFrames(-1)).toThrow(RangeError);
    expect(() => createUf8AnimationFrames(0.5)).toThrow(RangeError);
  });
});
