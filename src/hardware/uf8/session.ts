import { Uf8D2xxDevice } from "./d2xx.ts";
import {
  frameUf8Message,
  Uf8FrameDecoder,
  type Uf8Message,
} from "./protocol.ts";

export class Uf8Session {
  readonly serial: string;
  readonly tileId: number;
  readonly #device: Uf8D2xxDevice;
  readonly #decoder: Uf8FrameDecoder;
  #nextRuntimeTick = performance.now();

  private constructor(
    device: Uf8D2xxDevice,
    decoder: Uf8FrameDecoder,
    tileId: number,
  ) {
    this.serial = device.serial;
    this.tileId = tileId;
    this.#device = device;
    this.#decoder = decoder;
  }

  static async connect(serial: string): Promise<Uf8Session> {
    const device = Uf8D2xxDevice.open(serial);
    const decoder = new Uf8FrameDecoder();
    try {
      device.write(new Uint8Array(256));

      const identity = await queryUf8(device, decoder, 1);
      if (readUShort(identity.payload) !== 0x1234) {
        throw new Error("UF8 returned an invalid identity");
      }
      const tileId = readUShort((await queryUf8(device, decoder, 2)).payload);
      await queryUf8(device, decoder, 5);
      await queryUf8(device, decoder, 75);
      await queryUf8(device, decoder, 78);

      device.write(frameUf8Message(43, [1, 0]));
      device.write(frameUf8Message(99, [43, 0]));
      await waitForUf8Message(
        device,
        decoder,
        (message) => message.code === 99 && message.payload[0] === 43,
      );
      device.write(frameUf8Message(100, [0]));

      return new Uf8Session(device, decoder, tileId);
    } catch (error) {
      device.close();
      throw error;
    }
  }

  write(frame: Uint8Array): void {
    this.#device.write(frame);
  }

  pump(): readonly Uf8Message[] {
    const now = performance.now();
    if (now >= this.#nextRuntimeTick) {
      this.#device.write(frameUf8Message(27, [currentFlashState()]));
      this.#nextRuntimeTick = now + 150;
    }
    return this.#decoder.push(this.#device.readAvailable());
  }

  close(): void {
    this.#device.close();
  }
}

async function queryUf8(
  device: Uf8D2xxDevice,
  decoder: Uf8FrameDecoder,
  code: number,
): Promise<Uf8Message> {
  device.write(frameUf8Message(code, []));
  let reply: Uf8Message | null = null;
  await waitForUf8Message(device, decoder, (message) => {
    if (message.code !== code) {
      return false;
    }
    reply = message;
    return true;
  });
  if (reply === null) {
    throw new Error(`UF8 query ${code} completed without a reply`);
  }
  return reply;
}

async function waitForUf8Message(
  device: Uf8D2xxDevice,
  decoder: Uf8FrameDecoder,
  matches: (message: Uf8Message) => boolean,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    for (const message of decoder.push(device.readAvailable())) {
      if (matches(message)) {
        return;
      }
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out after ${timeoutMilliseconds} ms waiting for UF8`);
}

function currentFlashState(): number {
  const phase = Math.floor(Date.now() / 150) % 8;
  const fastFlash = (phase & 1) === 0 ? 0 : 1;
  const flash = (phase & 4) === 0 ? 0 : 2;
  return fastFlash | flash;
}

function readUShort(bytes: Uint8Array): number {
  const low = bytes[0];
  const high = bytes[1];
  if (low === undefined || high === undefined) {
    throw new Error("UF8 response is missing a 16-bit value");
  }
  return low | (high << 8);
}
