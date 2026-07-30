import {
  drawUf8DisplayBox,
  drawUf8DisplayText,
  rgb565,
  setUf8DisplayColour,
  UF8_DISPLAY_COUNT,
  UF8_DISPLAY_HEIGHT,
  UF8_DISPLAY_WIDTH,
} from "@somnai-dreams/ssl-uf8";

export const UF8_ANIMATION_INTERVAL_MS = 160;

export type Uf8AnimationScene =
  | { kind: "attract" }
  | { kind: "countdown"; endsAt: number }
  | {
      kind: "mission";
      activity: "orders" | "interstitial" | "reactor-procedure";
    }
  | { kind: "game-over"; result: "survived" | "integrity" };

export type Uf8AnimationStrip = {
  active: boolean;
  cue: {
    heading: string;
    value: string;
  } | null;
};

const BLACK = rgb565(1, 2, 6);
const WHITE = rgb565(255, 255, 255);
const MISSION_BACKGROUND = rgb565(3, 6, 13);
const ALERT_BACKGROUND = rgb565(24, 0, 4);
const SUCCESS_BACKGROUND = rgb565(0, 20, 11);
const BRIGHT_COLOURS = [
  rgb565(255, 48, 88),
  rgb565(255, 126, 46),
  rgb565(250, 205, 55),
  rgb565(38, 210, 120),
  rgb565(25, 198, 218),
  rgb565(45, 116, 255),
  rgb565(139, 86, 255),
  rgb565(235, 69, 210),
] as const;
const DIM_COLOURS = [
  rgb565(82, 10, 30),
  rgb565(82, 34, 8),
  rgb565(72, 54, 8),
  rgb565(6, 62, 32),
  rgb565(4, 58, 68),
  rgb565(8, 30, 80),
  rgb565(36, 16, 82),
  rgb565(76, 12, 66),
] as const;
const COUNTDOWN_BACKGROUNDS = [
  rgb565(25, 0, 38),
  rgb565(42, 14, 0),
  rgb565(0, 28, 38),
] as const;
const SEVEN_SEGMENT_RECTS = [
  [36, 17, 56, 12],
  [84, 28, 12, 47],
  [84, 86, 12, 47],
  [36, 132, 56, 12],
  [28, 86, 12, 47],
  [28, 28, 12, 47],
  [36, 75, 56, 12],
] as const;

export function createUf8AnimationFrames(
  scene: Uf8AnimationScene,
  strips: readonly Uf8AnimationStrip[],
  frameIndex: number,
  now: number,
): readonly Uint8Array[] {
  if (strips.length !== UF8_DISPLAY_COUNT) {
    throw new Error("UF8 animation requires exactly eight display strips");
  }
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError("UF8 animation frame index must be a non-negative integer");
  }

  switch (scene.kind) {
    case "attract":
      return createAttractFrames(frameIndex);
    case "countdown":
      return createCountdownFrames(scene.endsAt, frameIndex, now);
    case "mission":
      return createMissionFrames(scene.activity, strips, frameIndex);
    case "game-over":
      return createGameOverFrames(scene.result, frameIndex);
  }
}

function createAttractFrames(frameIndex: number): readonly Uint8Array[] {
  const frames: Uint8Array[] = [];
  const paletteOffset = Math.floor(frameIndex / 3);
  for (let displayIndex = 0; displayIndex < UF8_DISPLAY_COUNT; displayIndex += 1) {
    const colourIndex = (displayIndex + paletteOffset) % BRIGHT_COLOURS.length;
    const accent = requiredColour(BRIGHT_COLOURS, colourIndex);
    const dim = requiredColour(DIM_COLOURS, colourIndex);
    const sweepY = (frameIndex * 13 + displayIndex * 19) % 137;
    const railHeight = 28 + ((frameIndex * 11 + displayIndex * 17) % 112);
    frames.push(
      drawUf8DisplayBox(
        displayIndex,
        0,
        0,
        UF8_DISPLAY_WIDTH,
        UF8_DISPLAY_HEIGHT,
        BLACK,
      ),
      drawUf8DisplayBox(displayIndex, 0, sweepY, 128, 24, dim),
      drawUf8DisplayBox(
        displayIndex,
        0,
        UF8_DISPLAY_HEIGHT - railHeight,
        12,
        railHeight,
        accent,
      ),
      drawUf8DisplayBox(
        displayIndex,
        116,
        0,
        12,
        railHeight,
        accent,
      ),
      drawUf8DisplayBox(displayIndex, 16, sweepY + 10, 96, 4, WHITE),
      setUf8DisplayColour(displayIndex, WHITE),
      drawUf8DisplayText(
        displayIndex,
        18,
        72,
        "SYNTH/TEAM",
        "dejavu-sans-bold-10",
      ),
      drawUf8DisplayText(
        displayIndex,
        28,
        104,
        "STANDBY",
        "dejavu-sans-bold-14",
      ),
    );
  }
  return frames;
}

function createCountdownFrames(
  endsAt: number,
  frameIndex: number,
  now: number,
): readonly Uint8Array[] {
  const remaining = Math.ceil((endsAt - now) / 1000);
  const digit = remaining >= 3 ? 3 : remaining === 2 ? 2 : 1;
  const segmentIndices = sevenSegmentIndices(digit);
  const background = requiredColour(COUNTDOWN_BACKGROUNDS, digit - 1);
  const frames: Uint8Array[] = [];
  for (let displayIndex = 0; displayIndex < UF8_DISPLAY_COUNT; displayIndex += 1) {
    const accent = requiredColour(
      BRIGHT_COLOURS,
      (displayIndex + frameIndex) % BRIGHT_COLOURS.length,
    );
    frames.push(
      drawUf8DisplayBox(
        displayIndex,
        0,
        0,
        UF8_DISPLAY_WIDTH,
        UF8_DISPLAY_HEIGHT,
        background,
      ),
      drawUf8DisplayBox(displayIndex, 0, 0, 12, 160, accent),
      drawUf8DisplayBox(displayIndex, 116, 0, 12, 160, accent),
    );
    for (const segmentIndex of segmentIndices) {
      const rectangle = SEVEN_SEGMENT_RECTS[segmentIndex];
      if (rectangle === undefined) {
        throw new Error(`Missing seven-segment rectangle ${segmentIndex}`);
      }
      frames.push(
        drawUf8DisplayBox(
          displayIndex,
          rectangle[0],
          rectangle[1],
          rectangle[2],
          rectangle[3],
          frameIndex % 2 === 0 ? WHITE : accent,
        ),
      );
    }
  }
  return frames;
}

function createMissionFrames(
  activity: Extract<Uf8AnimationScene, { kind: "mission" }>["activity"],
  strips: readonly Uf8AnimationStrip[],
  frameIndex: number,
): readonly Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let displayIndex = 0; displayIndex < UF8_DISPLAY_COUNT; displayIndex += 1) {
    const strip = strips[displayIndex];
    if (strip === undefined) {
      throw new Error(`Missing UF8 mission strip ${displayIndex}`);
    }
    if (!strip.active) {
      frames.push(
        drawUf8DisplayBox(
          displayIndex,
          0,
          25,
          128,
          135,
          BLACK,
        ),
      );
      continue;
    }
    const paletteIndex =
      activity === "interstitial"
        ? frameIndex % 2 === 0
          ? 0
          : 1
        : (displayIndex + Math.floor(frameIndex / 4)) %
          BRIGHT_COLOURS.length;
    const accent = requiredColour(BRIGHT_COLOURS, paletteIndex);
    const dim = requiredColour(DIM_COLOURS, paletteIndex);
    const background =
      activity === "interstitial" ? ALERT_BACKGROUND : MISSION_BACKGROUND;
    const firstHeight = 30 + ((frameIndex * 13 + displayIndex * 11) % 104);
    const secondHeight = 24 + ((frameIndex * 17 + displayIndex * 23) % 110);
    const thirdHeight = 36 + ((frameIndex * 7 + displayIndex * 31) % 98);
    const scannerY = 27 + ((frameIndex * 11 + displayIndex * 13) % 129);
    frames.push(
      drawUf8DisplayBox(displayIndex, 0, 25, 128, 135, background),
      drawUf8DisplayBox(
        displayIndex,
        8,
        160 - firstHeight,
        32,
        firstHeight,
        dim,
      ),
      drawUf8DisplayBox(
        displayIndex,
        48,
        160 - secondHeight,
        32,
        secondHeight,
        accent,
      ),
      drawUf8DisplayBox(
        displayIndex,
        88,
        160 - thirdHeight,
        32,
        thirdHeight,
        dim,
      ),
      drawUf8DisplayBox(displayIndex, 0, scannerY, 128, 4, WHITE),
    );

    if (strip.cue === null) {
      continue;
    }
    frames.push(
      drawUf8DisplayBox(displayIndex, 10, 50, 108, 70, BLACK),
      setUf8DisplayColour(displayIndex, accent),
      drawUf8DisplayText(
        displayIndex,
        20,
        72,
        strip.cue.heading,
        "dejavu-sans-bold-10",
      ),
      setUf8DisplayColour(displayIndex, WHITE),
      drawUf8DisplayText(
        displayIndex,
        Math.max(4, 64 - strip.cue.value.length * 4),
        103,
        strip.cue.value,
        "dejavu-sans-bold-16",
      ),
    );
  }
  return frames;
}

function createGameOverFrames(
  result: Extract<Uf8AnimationScene, { kind: "game-over" }>["result"],
  frameIndex: number,
): readonly Uint8Array[] {
  const frames: Uint8Array[] = [];
  const survived = result === "survived";
  const background = survived ? SUCCESS_BACKGROUND : ALERT_BACKGROUND;
  const primary = survived ? BRIGHT_COLOURS[3] : BRIGHT_COLOURS[0];
  const secondary = survived ? BRIGHT_COLOURS[4] : BRIGHT_COLOURS[1];
  for (let displayIndex = 0; displayIndex < UF8_DISPLAY_COUNT; displayIndex += 1) {
    const glitchY = (frameIndex * 17 + displayIndex * 29) % 145;
    frames.push(
      drawUf8DisplayBox(
        displayIndex,
        0,
        0,
        UF8_DISPLAY_WIDTH,
        UF8_DISPLAY_HEIGHT,
        background,
      ),
      drawUf8DisplayBox(displayIndex, 0, glitchY, 128, 15, primary),
      drawUf8DisplayBox(
        displayIndex,
        (frameIndex * 19 + displayIndex * 31) % 88,
        0,
        40,
        160,
        secondary,
      ),
      drawUf8DisplayBox(displayIndex, 0, 76, 128, 6, WHITE),
      setUf8DisplayColour(displayIndex, WHITE),
      drawUf8DisplayText(
        displayIndex,
        survived ? 28 : 42,
        65,
        survived ? "MISSION" : "HULL",
        "dejavu-sans-bold-14",
      ),
      drawUf8DisplayText(
        displayIndex,
        survived ? 24 : 42,
        108,
        survived ? "SURVIVED" : "LOST",
        "dejavu-sans-bold-14",
      ),
    );
  }
  return frames;
}

function sevenSegmentIndices(digit: 1 | 2 | 3): readonly number[] {
  switch (digit) {
    case 1:
      return [1, 2];
    case 2:
      return [0, 1, 6, 4, 3];
    case 3:
      return [0, 1, 6, 2, 3];
  }
}

function requiredColour(
  colours: readonly number[],
  index: number,
): number {
  const colour = colours[index];
  if (colour === undefined) {
    throw new Error(`Missing UF8 animation colour ${index}`);
  }
  return colour;
}
