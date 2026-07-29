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
