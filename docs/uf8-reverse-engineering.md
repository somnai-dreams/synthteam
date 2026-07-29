# SSL UF8 runtime protocol notes

These notes describe the narrow, reversible runtime interface recovered from
the locally installed SSL 360 `2.0.6.67265` application on 2026-07-28. They are
evidence for a Synthteam hardware adapter, not a complete protocol claim.

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

SSL 360 owns this USB interface exclusively. It must be paused before the
standalone probe can open the UF8, then restarted afterward.

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

The MVP probe implements the first three. Text uses ASCII bytes. The built-in
font IDs are:

1. Serif Bold 14
2. DejaVu Sans Bold 16
3. DejaVu Sans Bold 14
4. DejaVu Sans Bold 10

Display commands are wrapped in outer message code `100`. The implemented
subcommands are `11` for RGB565 colour, `13` for compact filled rectangles, and
`15` for compact text.

This is enough to put a stable game-control name at the top of every strip and
to use independent colour coding. The discovered bitmap path means arbitrary
art should also be possible, but its block transfer is deliberately left for a
separate, evidence-backed slice.

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
position zero to all eight faders, enables the motors for 650 ms, then disables
them again.

## Reproduce

Packet generation can be inspected without opening hardware:

```sh
bun run probe:uf8 preview
```

With SSL 360 paused:

```sh
bun run probe:uf8 list
bun run probe:uf8 display-test
bun run probe:uf8 zero-faders
```

If multiple units are present, append `--serial SERIAL`. The probe intentionally
does not store a device serial in the repository.

`bun:ffi` is experimental, so this adapter is currently a hardware validation
surface rather than the production mission transport. Once input event decoding
is recovered, a small native ABI shim is the likely durable replacement.
