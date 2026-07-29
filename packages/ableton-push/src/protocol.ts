export const WIDTH = 960;
export const HEIGHT = 160;
export const PUSH_DISPLAY_RGBA_BYTES = WIDTH * HEIGHT * 4;

const PAD_LOW = 36;
const PAD_HIGH = 99;
const DISPLAY_LINE_BYTES = 2_048;
export const PUSH_DISPLAY_FRAME_BYTES = DISPLAY_LINE_BYTES * HEIGHT;
export const PUSH_DISPLAY_HEADER = new Uint8Array([
  0xff, 0xcc, 0xaa, 0x88, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const DISPLAY_XOR = [0xe7, 0xf3, 0xe7, 0xff] as const;

export const PAD_COLORS = {
  off: 0,
  white: 3,
  red: 6,
  amber: 10,
  yellow: 14,
  lime: 18,
  green: 22,
  cyan: 34,
  sky: 38,
  blue: 46,
  magenta: 54,
  pink: 58,
  orange: 65,
  violet: 79,
} as const;

const RGB_BUTTON_CCS: readonly number[] = [
  20, 21, 22, 23, 24, 25, 26, 27,
  102, 103, 104, 105, 106, 107, 108, 109,
  36, 37, 38, 39, 40, 41, 42, 43,
  29, 60, 61, 85, 86, 89,
];

export type PushPadEvent = {
  kind: "pad";
  x: number;
  y: number;
  down: boolean;
  velocity: number;
};

export type PushButtonEvent = {
  kind: "button";
  cc: number;
  down: boolean;
};

export type PushEncoderEvent = {
  kind: "encoder";
  control:
    | { kind: "display"; index: number }
    | { kind: "master" }
    | { kind: "small"; index: 1 | 2 };
  cc: number;
  step: number;
};

export type PushDialEvent = {
  kind: "dial";
  gesture: "turn" | "left" | "press" | "right";
  value: number;
};

export type PushStripEvent = {
  kind: "strip";
  value: number;
};

export type PushStripTouchEvent = {
  kind: "strip-touch";
  down: boolean;
};

export type PushInputEvent =
  | PushPadEvent
  | PushButtonEvent
  | PushEncoderEvent
  | PushDialEvent
  | PushStripEvent
  | PushStripTouchEvent;

export function decodePushMidiMessage(
  message: readonly number[],
): PushInputEvent | null {
  if (message.length !== 3) {
    return null;
  }
  const status = message[0];
  const data1 = message[1];
  const data2 = message[2];
  if (
    status === undefined ||
    data1 === undefined ||
    data2 === undefined ||
    !isByte(status) ||
    !isByte(data1) ||
    !isByte(data2)
  ) {
    return null;
  }

  const messageKind = status & 0xf0;
  switch (messageKind) {
    case 0xe0:
      return { kind: "strip", value: (data2 << 7) | data1 };
    case 0x90:
    case 0x80:
      if (data1 === 12) {
        return {
          kind: "strip-touch",
          down: messageKind === 0x90 && data2 > 0,
        };
      }
      if (data1 < PAD_LOW || data1 > PAD_HIGH) {
        return null;
      }
      return {
        kind: "pad",
        x: (data1 - PAD_LOW) % 8,
        y: Math.floor((data1 - PAD_LOW) / 8),
        down: messageKind === 0x90 && data2 > 0,
        velocity: data2,
      };
    case 0xb0:
      return decodeControlChange(data1, data2);
    default:
      return null;
  }
}

export function pushPadMidiMessage(
  x: number,
  y: number,
  colour: number,
  channel = 0,
): [number, number, number] {
  assertGridCoordinate("pad x", x);
  assertGridCoordinate("pad y", y);
  assertMidiData("pad colour", colour);
  assertMidiChannel(channel);
  return [0x90 | channel, PAD_LOW + y * 8 + x, colour];
}

export function pushButtonMidiMessage(
  cc: number,
  colour: number,
  channel = 0,
): [number, number, number] {
  assertMidiData("button CC", cc);
  assertMidiData("button colour", colour);
  assertMidiChannel(channel);
  return [0xb0 | channel, cc, colour];
}

export function isPushRgbButton(cc: number): boolean {
  return RGB_BUTTON_CCS.includes(cc);
}

export function writePushDisplayFrame(
  rgba: Uint8Array,
  frame: Uint8Array,
): void {
  if (rgba.byteLength !== PUSH_DISPLAY_RGBA_BYTES) {
    throw new RangeError(
      `Push RGBA frame must contain ${PUSH_DISPLAY_RGBA_BYTES} bytes`,
    );
  }
  if (frame.byteLength !== PUSH_DISPLAY_FRAME_BYTES) {
    throw new RangeError(
      `Push display frame must contain ${PUSH_DISPLAY_FRAME_BYTES} bytes`,
    );
  }

  for (let y = 0; y < HEIGHT; y += 1) {
    let sourceIndex = y * WIDTH * 4;
    let destinationIndex = y * DISPLAY_LINE_BYTES;
    for (let x = 0; x < WIDTH; x += 1) {
      const red = rgba[sourceIndex] as number;
      const green = rgba[sourceIndex + 1] as number;
      const blue = rgba[sourceIndex + 2] as number;
      const pixel =
        ((blue & 0xf8) << 8) |
        ((green & 0xfc) << 3) |
        (red >> 3);
      frame[destinationIndex] =
        (pixel & 0xff) ^ requiredDisplayXor(destinationIndex);
      frame[destinationIndex + 1] =
        (pixel >> 8) ^ requiredDisplayXor(destinationIndex + 1);
      sourceIndex += 4;
      destinationIndex += 2;
    }
    const lineEnd = (y + 1) * DISPLAY_LINE_BYTES;
    for (; destinationIndex < lineEnd; destinationIndex += 1) {
      frame[destinationIndex] = requiredDisplayXor(destinationIndex);
    }
  }
}

function decodeControlChange(
  cc: number,
  value: number,
): PushButtonEvent | PushEncoderEvent | PushDialEvent {
  if ((cc >= 71 && cc <= 79) || cc === 14 || cc === 15) {
    return {
      kind: "encoder",
      control: encoderControl(cc),
      cc,
      step: value < 64 ? value : value - 128,
    };
  }

  const gesture = dialGesture(cc);
  if (gesture !== null) {
    return {
      kind: "dial",
      gesture,
      value: gesture === "turn" && value >= 64 ? value - 128 : value,
    };
  }

  return { kind: "button", cc, down: value > 0 };
}

function encoderControl(
  cc: number,
): PushEncoderEvent["control"] {
  switch (cc) {
    case 14:
      return { kind: "small", index: 1 };
    case 15:
      return { kind: "small", index: 2 };
    case 79:
      return { kind: "master" };
    default:
      return { kind: "display", index: cc - 70 };
  }
}

function dialGesture(
  cc: number,
): PushDialEvent["gesture"] | null {
  switch (cc) {
    case 70:
      return "turn";
    case 93:
      return "left";
    case 94:
      return "press";
    case 95:
      return "right";
    default:
      return null;
  }
}

function assertGridCoordinate(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 7) {
    throw new RangeError(`${label} must be an integer from 0 to 7`);
  }
}

function assertMidiData(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 127) {
    throw new RangeError(`${label} must be an integer from 0 to 127`);
  }
}

function assertMidiChannel(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 15) {
    throw new RangeError("MIDI channel must be an integer from 0 to 15");
  }
}

function isByte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}

function requiredDisplayXor(index: number): number {
  const value = DISPLAY_XOR[index % DISPLAY_XOR.length];
  if (value === undefined) {
    throw new Error("Push display XOR table is incomplete");
  }
  return value;
}
