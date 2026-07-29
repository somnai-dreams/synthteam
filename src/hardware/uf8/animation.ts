import {
  drawUf8DisplayBox,
  rgb565,
  UF8_DISPLAY_COUNT,
} from "./protocol.ts";

export const UF8_ANIMATION_INTERVAL_MS = 125;

const TRACK_X = 12;
const TRACK_Y = 142;
const TRACK_WIDTH = 104;
const TRACK_HEIGHT = 8;
const TRACK_COLOUR = rgb565(13, 22, 29);
const COMET_WIDTH = 20;
const COMET_STEP = 28;
const COMET_POSITIONS_PER_DISPLAY = 4;
const COMET_POSITION_COUNT =
  UF8_DISPLAY_COUNT * COMET_POSITIONS_PER_DISPLAY;
const WAVE_COLOURS = [
  rgb565(255, 48, 88),
  rgb565(255, 126, 46),
  rgb565(250, 205, 55),
  rgb565(38, 210, 120),
  rgb565(25, 198, 218),
  rgb565(45, 116, 255),
  rgb565(139, 86, 255),
  rgb565(235, 69, 210),
] as const;

export function createUf8AnimationResetFrames(): readonly Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let displayIndex = 0; displayIndex < UF8_DISPLAY_COUNT; displayIndex += 1) {
    frames.push(
      drawUf8DisplayBox(
        displayIndex,
        TRACK_X,
        TRACK_Y,
        TRACK_WIDTH,
        TRACK_HEIGHT,
        TRACK_COLOUR,
      ),
    );
  }
  return frames;
}

export function createUf8AnimationFrames(
  frameIndex: number,
): readonly Uint8Array[] {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    throw new RangeError("UF8 animation frame index must be a non-negative integer");
  }

  const position = frameIndex % COMET_POSITION_COUNT;
  const previousPosition =
    (position + COMET_POSITION_COUNT - 1) % COMET_POSITION_COUNT;
  const displayIndex = Math.floor(position / COMET_POSITIONS_PER_DISPLAY);
  const previousDisplayIndex = Math.floor(
    previousPosition / COMET_POSITIONS_PER_DISPLAY,
  );
  const colour = WAVE_COLOURS[displayIndex];
  if (colour === undefined) {
    throw new Error(`UF8 animation display ${displayIndex} is incomplete`);
  }
  return [
    drawUf8DisplayBox(
      previousDisplayIndex,
      TRACK_X + (previousPosition % COMET_POSITIONS_PER_DISPLAY) * COMET_STEP,
      TRACK_Y,
      COMET_WIDTH,
      TRACK_HEIGHT,
      TRACK_COLOUR,
    ),
    drawUf8DisplayBox(
      displayIndex,
      TRACK_X + (position % COMET_POSITIONS_PER_DISPLAY) * COMET_STEP,
      TRACK_Y,
      COMET_WIDTH,
      TRACK_HEIGHT,
      colour,
    ),
  ];
}
