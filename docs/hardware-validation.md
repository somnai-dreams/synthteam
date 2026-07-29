# Hardware validation

## 2026-07-28 · first attached-device pass

The central Mac was probed with the SSL UF8 and Stream Deck connected.
Device serial numbers are deliberately omitted from this repository.

### Confirmed

- macOS USB sees an **Elgato Stream Deck XL**, vendor `0x0fd9`, product
  `0x008f`, device version `1.10`.
- macOS USB sees **SSL Control I/F**, vendor `0x31e9`, product `0x0021`,
  device version `10.00`.
- The same SSL unit also exposes an **HID Controller**, product `0x0022`.
- The Synthteam Stream Deck WebSocket role receives the current 32-key layout
  and active routing task from the Bun server.
- Simulator-driven integration proves the normalized UF8, Push, and Stream Deck
  events reach the same authoritative mission state used by hardware adapters.

### Not yet confirmed

- CoreMIDI reported zero sources and zero destinations. SSL 360° was not
  installed, so the UF8 MIDI CC mapping could not yet be learned.
- The Stream Deck host application was not installed, so the local plugin could
  not yet be loaded onto the physical XL.
- Push was not connected during this pass.

### Reproduce

Run the read-only MIDI probe:

```sh
bun run probe:midi
```

Check USB identity in macOS System Information:

```sh
system_profiler SPUSBDataType -detailLevel mini
```

The next pass should record the visible MIDI endpoint names, learned UF8 CC
bindings, Push grid corner notes, and a full physical mission result.

## 2026-07-28 · UF8 runtime protocol pass

SSL 360 `2.0.6.67265` is now installed and the UF8 is claimed by its background
core. Inspection of the locally installed runtime established:

- the direct D2XX USB connection settings and packet framing;
- eight independent `128 × 160` RGB565 display surfaces;
- built-in commands for text, filled boxes, bitmap blocks, and graphic objects;
- motor position and enable commands for all eight faders.

Synthteam now has a Bun probe that can generate the recovered packets, draw a
colour-coded label test, and move all faders to the raw-zero (`-INF`) endpoint.
Direct hardware execution requires pausing SSL 360 because its core owns the
same USB interface exclusively.

See
[`packages/ssl-uf8/PROTOCOL.md`](../packages/ssl-uf8/PROTOCOL.md)
for the exact evidence boundary.

## 2026-07-28 · server-owned UF8 mission pass

The direct protocol was integrated into the Bun server and verified with the
attached UF8 while SSL 360 was stopped:

- the server completed the full direct handshake and held the connection;
- all eight screens showed their gameplay control names without the previous
  horizontal offset;
- the web console reported the attached serial as **DIRECT LINK**;
- the native input monitor received the initial fader bank at normalized
  positions `67, 70, 28, 28, 4, 48, 2, 20`;
- the first server motor pass moved all eight faders to approximately `1%`
  while raw zero still represented the physical `-INF` endpoint;
- a two-phone mission delivered `SET HULL SHEAR TO -40 DB` to the remote
  reader and the same control/target to the UF8 display;
- holding the normalized `-40 DB` stop completed a UF8 task for 100 points.

The remaining hardware gates are the exported Stream Deck profile, identifying
and integrating the disconnected Push, and completing a full five-level
no-simulator run. The original 90-second survival gate was replaced by
objective-based level progression on 2026-07-29.

Follow-up corrected the reset target to the surface's printed `0 dB` point:
normalized `75%`, raw protocol position `24575`.

## 2026-07-29 · full-screen UF8 scene pass

The attached UF8 completed a live state-transition demo using procedural
full-screen graphics:

- lobby hyperspace attract mode;
- giant `3–2–1` countdown digits;
- animated live-mission reactor columns;
- return to attract mode after mission reset.

The direct link remained connected as the scene changed and while the lobby
animation continued. The validation used two disposable local phone sockets and
the authoritative server mission transition path rather than a display-only
probe.
