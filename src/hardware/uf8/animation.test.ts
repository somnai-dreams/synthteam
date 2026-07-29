import { describe, expect, test } from "bun:test";
import { Uf8FrameDecoder } from "./protocol.ts";
import {
  createUf8AnimationFrames,
  UF8_ANIMATION_INTERVAL_MS,
  type Uf8AnimationStrip,
} from "./animation.ts";

const emptyStrips: readonly Uf8AnimationStrip[] = Array.from(
  { length: 8 },
  () => ({ active: true, cue: null }),
);

describe("UF8 full-screen animation scenes", () => {
  test("renders a full-screen attract mode with game title and motion", () => {
    const messages = decode(
      createUf8AnimationFrames(
        { kind: "attract" },
        emptyStrips,
        2,
        0,
      ),
    );

    expect(UF8_ANIMATION_INTERVAL_MS).toBe(160);
    expect(messages).toHaveLength(64);
    expect(textFrom(messages)).toContain("SYNTH/TEAM");
    expect(textFrom(messages)).toContain("STANDBY");
  });

  test("renders giant countdown digits across every display", () => {
    const three = decode(
      createUf8AnimationFrames(
        { kind: "countdown", endsAt: 3_000 },
        emptyStrips,
        0,
        0,
      ),
    );
    const one = decode(
      createUf8AnimationFrames(
        { kind: "countdown", endsAt: 3_000 },
        emptyStrips,
        1,
        2_500,
      ),
    );

    expect(three).toHaveLength(64);
    expect(one).toHaveLength(40);
  });

  test("keeps mission cues over the animated reactor field", () => {
    const strips = emptyStrips.map((strip, index) =>
      index === 2
        ? {
            active: true,
            cue: { heading: "REPORT CODE", value: "BETA" },
          }
        : strip,
    );
    const messages = decode(
      createUf8AnimationFrames(
        { kind: "mission", activity: "reactor-procedure" },
        strips,
        4,
        0,
      ),
    );

    expect(messages).toHaveLength(45);
    expect(textFrom(messages)).toContain("REPORT CODE");
    expect(textFrom(messages)).toContain("BETA");
  });

  test("renders distinct victory and hull-loss takeovers", () => {
    const victory = decode(
      createUf8AnimationFrames(
        { kind: "game-over", result: "survived" },
        emptyStrips,
        1,
        0,
      ),
    );
    const loss = decode(
      createUf8AnimationFrames(
        { kind: "game-over", result: "integrity" },
        emptyStrips,
        1,
        0,
      ),
    );

    expect(textFrom(victory)).toContain("SURVIVED");
    expect(textFrom(loss)).toContain("LOST");
    expect(victory).not.toEqual(loss);
  });

  test("rejects malformed animation inputs", () => {
    expect(() =>
      createUf8AnimationFrames({ kind: "attract" }, [], 0, 0),
    ).toThrow("exactly eight");
    expect(() =>
      createUf8AnimationFrames(
        { kind: "attract" },
        emptyStrips,
        -1,
        0,
      ),
    ).toThrow(RangeError);
  });
});

function decode(frames: readonly Uint8Array[]) {
  const decoder = new Uf8FrameDecoder();
  return frames.flatMap((frame) => decoder.push(frame));
}

function textFrom(
  messages: ReturnType<typeof decode>,
): readonly string[] {
  return messages
    .filter(
      (message) =>
        message.code === 100 &&
        message.payload[0] === 15,
    )
    .map((message) => new TextDecoder().decode(message.payload.slice(6)));
}
