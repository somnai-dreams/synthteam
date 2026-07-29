export const UF8_DISPLAY_COUNT = 8;
export const UF8_DISPLAY_WIDTH = 128;
export const UF8_DISPLAY_HEIGHT = 160;
export const UF8_FADER_COUNT = 8;

export type Uf8Font =
  | "serif-bold-14"
  | "dejavu-sans-bold-16"
  | "dejavu-sans-bold-14"
  | "dejavu-sans-bold-10";

const USB_SET_FADER_MOTOR_ENABLE = 29;
const USB_SET_FADER_POSITION = 30;
const USB_RGB_DISPLAY_GRAPHICS = 100;

const DISPLAY_SET_COLOUR_16BIT = 11;
const DISPLAY_DRAW_BOX_SD = 13;
const DISPLAY_DRAW_TEXT_SD = 15;

const fontValues: Readonly<Record<Uf8Font, number>> = {
  "serif-bold-14": 1,
  "dejavu-sans-bold-16": 2,
  "dejavu-sans-bold-14": 3,
  "dejavu-sans-bold-10": 4,
};

export function frameUf8Message(
  messageCode: number,
  payload: readonly number[],
): Uint8Array {
  assertByte("message code", messageCode);
  if (payload.length > 255) {
    throw new RangeError("UF8 payload must fit in one byte");
  }

  const frame = new Uint8Array(payload.length + 4);
  frame[0] = 0xff;
  frame[1] = messageCode;
  frame[2] = payload.length;
  for (let index = 0; index < payload.length; index += 1) {
    const value = payload[index];
    if (value === undefined) {
      throw new Error("UF8 payload contains a missing byte");
    }
    assertByte(`payload byte ${index}`, value);
    frame[index + 3] = value;
  }

  let checksum = 0;
  for (let index = 1; index < frame.length - 1; index += 1) {
    const value = frame[index];
    if (value === undefined) {
      throw new Error("UF8 frame contains a missing byte");
    }
    checksum = (checksum + value) & 0xff;
  }
  frame[frame.length - 1] = checksum;
  return frame;
}

export function rgb565(red: number, green: number, blue: number): number {
  assertByte("red", red);
  assertByte("green", green);
  assertByte("blue", blue);
  return ((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3);
}

export function setUf8DisplayColour(
  displayIndex: number,
  colour: number,
): Uint8Array {
  assertDisplayIndex(displayIndex);
  assertUShort("colour", colour);
  return frameUf8Message(USB_RGB_DISPLAY_GRAPHICS, [
    DISPLAY_SET_COLOUR_16BIT,
    displayIndex,
    ...littleEndianUShort(colour),
  ]);
}

export function drawUf8DisplayBox(
  displayIndex: number,
  x: number,
  y: number,
  width: number,
  height: number,
  colour: number,
): Uint8Array {
  assertDisplayIndex(displayIndex);
  assertDisplayRectangle(x, y, width, height);
  assertUShort("colour", colour);
  return frameUf8Message(USB_RGB_DISPLAY_GRAPHICS, [
    DISPLAY_DRAW_BOX_SD,
    displayIndex,
    x,
    x + width - 1,
    y,
    y + height - 1,
    ...littleEndianUShort(colour),
  ]);
}

export function drawUf8DisplayText(
  displayIndex: number,
  x: number,
  y: number,
  text: string,
  font: Uf8Font,
): Uint8Array {
  assertDisplayIndex(displayIndex);
  assertByte("text x", x);
  assertByte("text y", y);
  const encoded = new TextEncoder().encode(text);
  if (encoded.length === 0 || encoded.length > 246) {
    throw new RangeError("UF8 text must contain 1 to 246 UTF-8 bytes");
  }
  for (const byte of encoded) {
    if (byte > 0x7f) {
      throw new RangeError("UF8 built-in text supports ASCII only");
    }
  }
  return frameUf8Message(USB_RGB_DISPLAY_GRAPHICS, [
    DISPLAY_DRAW_TEXT_SD,
    displayIndex,
    fontValues[font],
    x,
    y,
    encoded.length,
    ...encoded,
  ]);
}

export function setUf8FaderPosition(
  faderIndex: number,
  position: number,
): Uint8Array {
  assertFaderIndex(faderIndex);
  if (!Number.isInteger(position) || position < 0 || position > 32767) {
    throw new RangeError("UF8 fader position must be an integer from 0 to 32767");
  }
  return frameUf8Message(USB_SET_FADER_POSITION, [
    faderIndex,
    ...littleEndianUShort(position),
  ]);
}

export function setUf8FaderMotorEnabled(
  faderIndex: number,
  enabled: boolean,
): Uint8Array {
  assertFaderIndex(faderIndex);
  return frameUf8Message(USB_SET_FADER_MOTOR_ENABLE, [
    faderIndex,
    enabled ? 1 : 0,
  ]);
}

function assertDisplayIndex(displayIndex: number): void {
  if (
    !Number.isInteger(displayIndex) ||
    displayIndex < 0 ||
    displayIndex >= UF8_DISPLAY_COUNT
  ) {
    throw new RangeError("UF8 display index must be an integer from 0 to 7");
  }
}

function assertFaderIndex(faderIndex: number): void {
  if (
    !Number.isInteger(faderIndex) ||
    faderIndex < 0 ||
    faderIndex >= UF8_FADER_COUNT
  ) {
    throw new RangeError("UF8 fader index must be an integer from 0 to 7");
  }
}

function assertDisplayRectangle(
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1 ||
    x + width > UF8_DISPLAY_WIDTH ||
    y + height > UF8_DISPLAY_HEIGHT
  ) {
    throw new RangeError("UF8 rectangle must fit inside a 128 by 160 display");
  }
}

function assertByte(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${label} must be an integer from 0 to 255`);
  }
}

function assertUShort(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new RangeError(`${label} must be an integer from 0 to 65535`);
  }
}

function littleEndianUShort(value: number): readonly [number, number] {
  return [value & 0xff, value >> 8];
}
