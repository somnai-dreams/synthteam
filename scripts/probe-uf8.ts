import {
  listUf8Devices,
  Uf8D2xxDevice,
} from "../src/hardware/uf8/d2xx.ts";
import {
  drawUf8DisplayBox,
  drawUf8DisplayText,
  frameUf8Message,
  rgb565,
  setUf8DisplayColour,
  setUf8FaderMotorEnabled,
  setUf8FaderPosition,
  UF8_DISPLAY_COUNT,
  UF8_DISPLAY_HEIGHT,
  UF8_DISPLAY_WIDTH,
  UF8_FADER_COUNT,
} from "../src/hardware/uf8/protocol.ts";

type Command = "list" | "preview" | "display-test" | "zero-faders";

const displayLabels = [
  "FADER 1",
  "FADER 2",
  "FADER 3",
  "FADER 4",
  "FADER 5",
  "FADER 6",
  "FADER 7",
  "FADER 8",
] as const;

const displayColours = [
  rgb565(255, 48, 88),
  rgb565(255, 126, 46),
  rgb565(250, 205, 55),
  rgb565(38, 210, 120),
  rgb565(25, 198, 218),
  rgb565(45, 116, 255),
  rgb565(139, 86, 255),
  rgb565(235, 69, 210),
] as const;

async function main(): Promise<void> {
  const command = parseCommand(Bun.argv[2]);
  switch (command) {
    case "list":
      printDevices();
      return;
    case "preview":
      printDisplayFrames();
      return;
    case "display-test":
      await withSelectedUf8(async (device) => {
        await beginHostSession(device);
        drawDisplayTest(device);
        const holdSeconds = readPositiveIntegerOption("--hold-seconds", 30);
        await pumpHostSession(device, holdSeconds);
      });
      return;
    case "zero-faders":
      await withSelectedUf8(async (device) => {
        await zeroFaders(device);
      });
      return;
  }
}

function printDevices(): void {
  const devices = listUf8Devices();
  if (devices.length === 0) {
    console.log(
      "No available UF8 D2XX device. Quit or pause SSL 360, which exclusively owns the USB connection while running.",
    );
    return;
  }
  for (const device of devices) {
    console.log(
      `${device.description} · ${device.serial} · id 0x${device.id.toString(16)}`,
    );
  }
}

function printDisplayFrames(): void {
  for (let displayIndex = 0; displayIndex < UF8_DISPLAY_COUNT; displayIndex += 1) {
    for (const frame of displayTestFrames(displayIndex)) {
      console.log(toHex(frame));
    }
  }
}

async function withSelectedUf8(
  run: (device: Uf8D2xxDevice) => Promise<void>,
): Promise<void> {
  const serial = selectedSerial();
  const device = Uf8D2xxDevice.open(serial);
  console.log(`Opened UF8 ${serial}`);
  try {
    await run(device);
  } finally {
    device.close();
  }
}

function selectedSerial(): string {
  const serialArgumentIndex = Bun.argv.indexOf("--serial");
  if (serialArgumentIndex !== -1) {
    const serial = Bun.argv[serialArgumentIndex + 1];
    if (serial === undefined || serial.length === 0) {
      throw new Error("--serial requires the UF8 serial number");
    }
    return serial;
  }

  const devices = listUf8Devices();
  if (devices.length !== 1) {
    throw new Error(
      devices.length === 0
        ? "No available UF8. Quit or pause SSL 360, then retry."
        : "Multiple UF8 devices found. Select one with --serial SERIAL.",
    );
  }
  const device = devices[0];
  if (device === undefined) {
    throw new Error("UF8 discovery returned an inconsistent device list");
  }
  return device.serial;
}

function drawDisplayTest(device: Uf8D2xxDevice): void {
  for (let displayIndex = 0; displayIndex < UF8_DISPLAY_COUNT; displayIndex += 1) {
    for (const frame of displayTestFrames(displayIndex)) {
      device.write(frame);
    }
  }
  console.log("Drew eight colour-coded control labels");
}

async function beginHostSession(device: Uf8D2xxDevice): Promise<void> {
  const startupFrames = [
    frameUf8Message(1, []),
    frameUf8Message(2, []),
    frameUf8Message(5, []),
    frameUf8Message(100, [0]),
  ];
  for (const frame of startupFrames) {
    device.write(frame);
    await Bun.sleep(50);
    device.readAvailable();
  }
  console.log("Sent UF8 identity, tile-init, and display-init sequence");
}

async function pumpHostSession(
  device: Uf8D2xxDevice,
  holdSeconds: number,
): Promise<void> {
  console.log(
    `Holding the direct UF8 session for ${holdSeconds} seconds with a 1 Hz identity poll`,
  );
  const deadline = performance.now() + holdSeconds * 1000;
  while (performance.now() < deadline) {
    device.write(frameUf8Message(1, []));
    await Bun.sleep(100);
    device.readAvailable();
    const remainingMilliseconds = deadline - performance.now();
    if (remainingMilliseconds > 0) {
      await Bun.sleep(Math.min(900, remainingMilliseconds));
    }
  }
}

function displayTestFrames(displayIndex: number): readonly Uint8Array[] {
  const colour = displayColours[displayIndex];
  const label = displayLabels[displayIndex];
  if (colour === undefined || label === undefined) {
    throw new Error(`Missing display test design for UF8 strip ${displayIndex}`);
  }
  return [
    drawUf8DisplayBox(
      displayIndex,
      0,
      0,
      UF8_DISPLAY_WIDTH,
      UF8_DISPLAY_HEIGHT,
      rgb565(3, 5, 9),
    ),
    drawUf8DisplayBox(displayIndex, 0, 0, UF8_DISPLAY_WIDTH, 25, colour),
    setUf8DisplayColour(displayIndex, rgb565(255, 255, 255)),
    drawUf8DisplayText(
      displayIndex,
      4,
      18,
      label,
      "dejavu-sans-bold-14",
    ),
    drawUf8DisplayBox(displayIndex, 12, 66, 104, 12, colour),
  ];
}

async function zeroFaders(device: Uf8D2xxDevice): Promise<void> {
  for (let faderIndex = 0; faderIndex < UF8_FADER_COUNT; faderIndex += 1) {
    device.write(setUf8FaderPosition(faderIndex, 0));
  }
  for (let faderIndex = 0; faderIndex < UF8_FADER_COUNT; faderIndex += 1) {
    device.write(setUf8FaderMotorEnabled(faderIndex, true));
  }
  await Bun.sleep(650);
  for (let faderIndex = 0; faderIndex < UF8_FADER_COUNT; faderIndex += 1) {
    device.write(setUf8FaderMotorEnabled(faderIndex, false));
  }
  console.log("Moved all eight faders to zero and disabled their motors");
}

function parseCommand(value: string | undefined): Command {
  switch (value) {
    case "list":
    case "preview":
    case "display-test":
    case "zero-faders":
      return value;
    case undefined:
      throw new Error(
        "Usage: bun run probe:uf8 <list|preview|display-test|zero-faders> [--serial SERIAL]",
      );
    default:
      throw new Error(`Unknown UF8 probe command: ${value}`);
  }
}

function readPositiveIntegerOption(name: string, fallback: number): number {
  const optionIndex = Bun.argv.indexOf(name);
  if (optionIndex === -1) {
    return fallback;
  }
  const rawValue = Bun.argv[optionIndex + 1];
  const value = rawValue === undefined ? Number.NaN : Number(rawValue);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} requires a positive integer`);
  }
  return value;
}

function toHex(frame: Uint8Array): string {
  return [...frame]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

await main();
