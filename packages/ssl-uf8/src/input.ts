import {
  type Uf8Message,
  UF8_FADER_COUNT,
} from "./protocol.ts";

export type Uf8InputEvent =
  | {
      kind: "fader";
      index: number;
      position: number;
      normalized: number;
    }
  | {
      kind: "encoder";
      index: number;
      position: number;
      normalized: number;
    };

const INPUT_POSITION = 33;
const FADER_CONTROL_TYPE = 0;
const ENCODER_CONTROL_TYPE = 1;
const MAX_POSITION = 32_767;

export function decodeUf8InputEvent(
  message: Uf8Message,
): Uf8InputEvent | null {
  if (
    message.code !== INPUT_POSITION ||
    (message.payload.length !== 3 && message.payload.length !== 4)
  ) {
    return null;
  }

  const index = message.payload[0];
  const low = message.payload[1];
  const high = message.payload[2];
  const controlType = message.payload[3] ?? FADER_CONTROL_TYPE;
  if (
    index === undefined ||
    low === undefined ||
    high === undefined
  ) {
    throw new Error("UF8 input packet is missing a validated byte");
  }

  const position = low | (high << 8);
  if (position > MAX_POSITION) {
    return null;
  }
  const normalized = position / MAX_POSITION;

  switch (controlType) {
    case FADER_CONTROL_TYPE:
      if (index >= UF8_FADER_COUNT) {
        return null;
      }
      return { kind: "fader", index, position, normalized };
    case ENCODER_CONTROL_TYPE:
      return { kind: "encoder", index, position, normalized };
    default:
      return null;
  }
}
