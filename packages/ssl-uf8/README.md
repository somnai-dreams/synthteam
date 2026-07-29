# @somnai-dreams/ssl-uf8

A Bun-first driver for taking direct runtime control of an SSL UF8:

- discover and open units by serial number;
- complete the runtime identity, firmware, switch-chain, and display handshake;
- maintain the controller watchdog;
- receive native 15-bit fader and absolute-encoder positions;
- draw RGB565 boxes and built-in-font text on all eight displays;
- position and enable each motor fader.

The package implements only the narrow runtime surface confirmed in
[`PROTOCOL.md`](./PROTOCOL.md). It does not contain firmware, bootloader,
EEPROM, or persistent-configuration commands.

## Install

```sh
bun add @somnai-dreams/ssl-uf8
```

## Requirements

- macOS;
- Bun 1.3 or newer;
- SSL 360° installed so its D2XX-compatible `ssld2xx.dylib` is available;
- SSL 360° and any other direct UF8 client stopped while this package owns the
  exclusive USB interface.

The library path defaults to the location used by the standard SSL 360°
installation. Pass `d2xxLibraryPath` to discovery or connection methods when
the application is installed elsewhere. The package does not redistribute
SSL software or binaries.

## Example

```ts
import {
  drawUf8DisplayBox,
  drawUf8DisplayText,
  listUf8Devices,
  rgb565,
  setUf8DisplayColour,
  Uf8Session,
} from "@somnai-dreams/ssl-uf8";

const [device] = listUf8Devices();
if (device === undefined) {
  throw new Error("No available UF8");
}

const session = await Uf8Session.connect(device.serial);
try {
  const blue = rgb565(30, 90, 255);
  session.write(drawUf8DisplayBox(0, 0, 0, 128, 160, blue));
  session.write(setUf8DisplayColour(0, rgb565(255, 255, 255)));
  session.write(
    drawUf8DisplayText(0, 8, 24, "DIRECT LINK", "dejavu-sans-bold-14"),
  );

  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    for (const message of session.pump()) {
      console.log(message);
    }
    // Pump regularly; it also maintains the UF8 host watchdog.
    await Bun.sleep(10);
  }
} finally {
  session.close();
}
```

SSL and UF8 are trademarks of Solid State Logic. This independent project is
not affiliated with or endorsed by Solid State Logic.
