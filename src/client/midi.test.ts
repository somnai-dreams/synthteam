import { describe, expect, test } from "bun:test";
import { pointForNote, type PushGridBinding } from "./midi.ts";

describe("Push MIDI grid mapping", () => {
  test("maps a regular row-major 8 by 8 note grid", () => {
    const grid: PushGridBinding = {
      midiChannel: 0,
      bottomLeftNote: 36,
      xStep: 1,
      yStep: 8,
    };

    expect(pointForNote(grid, 36)).toEqual({ x: 0, y: 0 });
    expect(pointForNote(grid, 99)).toEqual({ x: 7, y: 7 });
    expect(pointForNote(grid, 53)).toEqual({ x: 1, y: 2 });
  });

  test("supports hardware whose note axes run in reverse", () => {
    const grid: PushGridBinding = {
      midiChannel: 0,
      bottomLeftNote: 99,
      xStep: -1,
      yStep: -8,
    };

    expect(pointForNote(grid, 99)).toEqual({ x: 0, y: 0 });
    expect(pointForNote(grid, 36)).toEqual({ x: 7, y: 7 });
  });

  test("rejects notes outside the learned grid", () => {
    const grid: PushGridBinding = {
      midiChannel: 0,
      bottomLeftNote: 36,
      xStep: 1,
      yStep: 8,
    };

    expect(pointForNote(grid, 12)).toBeNull();
  });
});
