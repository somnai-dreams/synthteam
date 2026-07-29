# SSL UF8 runtime protocol notes

These notes describe the narrow, reversible runtime interface recovered from
the locally installed SSL 360 `2.0.6.67265` application on 2026-07-28. They are
evidence for this independent driver, not a complete protocol claim.

No firmware-update, bootloader, EEPROM, or persistent configuration command was
executed or added to the probe.

## Confirmed transport

SSL 360 communicates with the UF8's `SSL Control I/F` USB interface through its
bundled D2XX-compatible `ssld2xx.dylib`. The unit uses SSL vendor `0x31e9`,
product `0x0021`, and is opened by serial number.

The connection defaults recovered from `SslConnection` are:

- 115200 baud;
- 8 data bits, one stop bit, no parity;
- no flow control;
- 4000 ms read and write timeouts;
- 2 ms FTDI latency timer;
- receive and transmit queues purged after opening.

Only one process can own this USB interface. SSL 360 and any other direct UF8
client must remain stopped while a session is open.

## Serial frame

Every runtime command found so far has this shape:

```text
ff CODE LENGTH PAYLOAD... CHECKSUM
```

`LENGTH` is the payload byte count. `CHECKSUM` is the low eight bits of the
additive sum of `CODE`, `LENGTH`, and every payload byte. The `ff` start byte is
not included.

## Displays

The UF8 creates eight display objects, indexed `0` through `7`. Each one is
`128 × 160` pixels. The recovered display surface supports:

- per-display RGB565 drawing colour;
- filled rectangles;
- text at arbitrary coordinates using four built-in fonts;
- 16-bit bitmap blocks;
- higher-level graphic objects with updateable values.

The driver implements the first three. Text uses ASCII bytes. The built-in font
IDs are:

1. Serif Bold 14
2. DejaVu Sans Bold 16
3. DejaVu Sans Bold 14
4. DejaVu Sans Bold 10

Display commands are wrapped in outer message code `100`. The implemented
subcommands are `11` for RGB565 colour, `13` for compact filled rectangles, and
`15` for compact text.

The discovered bitmap path means arbitrary art should also be possible, but its
block transfer remains outside the confirmed implementation.

## Motor faders

Fader positions use outer message code `30` with:

```text
FADER_INDEX POSITION_U16_LE
```

Motor enable uses code `29` with:

```text
FADER_INDEX ENABLED_BOOL
```

The recovered range is `0` through `32767`. The standalone zeroing probe writes
the normalized printed `0 dB` position (`75%`, raw `24575`) to all eight
faders, enables the motors for 650 ms, then disables them again. Raw position
zero is the physical `-INF` endpoint, not audio unity.

Native fader-position input uses code `33`:

```text
FADER_INDEX POSITION_U16_LE [CONTROL_TYPE]
```

Three-byte packets are fader events. In four-byte extended packets, control
type `0` is a fader and `1` is an absolute encoder. The server rejects malformed
indices and values, then normalizes the 15-bit position to the game engine's
`0–100` range.

The runtime session performs the recovered identity, tile-init,
firmware-version, switch-chain acknowledgement, and display-init sequence.
Calling `Uf8Session.pump()` continuously decodes controller traffic and
reproduces SSL 360's command `27` flash-state tick every 150 ms. That tick also
services the UF8's runtime host watchdog. Closing the session returns the UF8 to
its host-loss screen until SSL 360 reconnects.

`bun:ffi` is experimental. A small native ABI shim remains a possible hardening
step if the direct FFI boundary proves unstable, but it is no longer required
for the MVP.
