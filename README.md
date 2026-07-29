# Synthteam

Synthteam is a two-or-three-player local-network coordination game built around
real control surfaces:

- a 32-key Stream Deck XL for routing;
- an SSL UF8 for continuous reactor levels;
- an Ableton Push for spatial navigation paths.

All hardware connects to one central laptop. Every player joins from a phone
and is automatically assigned the first free controller in Deck → UF8 → Push
order. They receive instructions for somebody else's controller and have to
shout them across the room. The Bun server owns the mission state and only
accepts game actions from the physical device bridge or the clearly labelled
development simulator.

## Start the MVP

Requirements:

- Bun 1.3 or newer;
- SSL 360° installed, but not running, so Synthteam can load its bundled UF8
  USB transport;
- Chrome on the central hardware laptop if Push uses Web MIDI;
- all phones and the central laptop on the same local network.

```sh
bun install
bun start
```

Open `http://localhost:4179/console` in Chrome on the central laptop. The
console prints and displays its available LAN addresses. Open one of those
addresses on each phone and enter a call sign.

The mission can start with two phones. A third phone automatically adds Push to
the routing cycle when it joins before launch.

## Connect the hardware

### SSL UF8

1. Install SSL 360° once, then quit the application and its background core.
2. Connect the UF8 before starting Synthteam.
3. Start Synthteam. The Bun server automatically opens the UF8 by serial number.
4. Confirm **SSL UF8 · DIRECT LINK** and the eight live fader meters in the
   central console.

The server performs the UF8 identity, firmware, switch-chain, and display
handshake; maintains the controller watchdog; owns all eight displays; receives
native 15-bit fader events; and drives the fader motors. It parks the bank at
the printed `0 dB` point when the bridge connects and at the start of each
mission.

UF8 orders use the labels printed beside the physical faders:
`+12`, `+6`, `0`, `-5`, `-10`, `-20`, `-30`, `-40`, `-60`, and `-INF`.
A task completes after the correct channel remains at its requested stop for
450 ms.

The standalone diagnostics require both Synthteam and SSL 360° to be stopped
because the direct USB transport is exclusive:

```sh
bun run probe:uf8 preview
bun run probe:uf8 list
bun run probe:uf8 display-test
bun run probe:uf8 zero-faders
```

See [`docs/uf8-reverse-engineering.md`](docs/uf8-reverse-engineering.md) for the
confirmed packet format and safety boundary.

### Ableton Push

Two ways to connect the Push:

**Push 3 bridge (recommended for Push 3).** A dedicated hardware client under
`hardware/push` connects straight to the server (like the Stream Deck plugin)
and additionally drives the Push's screen: live vector path, progress, score,
integrity, deadlines, and a HULL BREACH flash when the ship takes damage. No
grid learning needed. See `hardware/push/README.md`:

```sh
cd hardware/push
bun install
bun bridge.js
```

**Web MIDI via the console (any Push generation).**

1. Connect Push and enter User Mode.
2. Enable MIDI in the Synthteam console.
3. Select Push's User input and User output ports.
4. Choose **Learn 3 grid corners**.
5. Press bottom-left, bottom-right, then top-left when prompted.

Synthteam infers the complete 8×8 note grid from those three facts. During a
mission it lights the path, makes the next pad brightest, and validates the
physical trace order.

### Stream Deck XL

The dependency-free plugin source is under
`hardware/streamdeck/com.synthteam.deck.sdPlugin`.

1. Copy or symlink that directory into
   `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`.
2. Restart the Stream Deck application.
3. Create an XL profile and place **Synthteam Switchboard** on all 32 keys.

The plugin renders the server-owned key names directly onto the LCD keys and
forwards key-down/key-up events. It expects Synthteam on the default port 4179.
See `hardware/streamdeck/README.md` for the current profile limitation.

## Development simulator

The central console includes an explicit simulator for every controller active
in the current mission. It is useful for tests and UI work when the controllers
are not attached.
It is not intended for a production mission—the MVP gate requires completing
the mission without touching the central laptop after launch.

## Verification

```sh
bun test
bun run check
bun run build
bun run probe:midi
bun run probe:uf8 preview
```

`check` uses TypeScript 7 plus type-aware oxlint. The current tests cover
two-and-three-device task generation, cross-routing, scoring, expiration,
controller-specific progress, direct UF8 framing and input decoding, protocol
validation, and Push note-grid mapping.
`probe:midi` asks macOS CoreMIDI for the exact input and output endpoints
currently exposed to Chrome. `probe:uf8 preview` verifies direct UF8 packet
generation without opening the controller.

## Current hardware gate

The central laptop detects the connected Stream Deck XL and SSL UF8 over USB.
The Stream Deck plugin and server-owned UF8 transport have both reached the
authoritative mission loop. A live two-phone pass confirmed UF8 connection,
native fader input, motor parking, custom strip labels, printed-dB targets, and
task completion.

The remaining physical gates are:

- export and document a verified 32-key Stream Deck XL profile;
- connect the Push, identify its generation, and tune its User-port LED
  palette;
- complete one 90-second mission without using the development simulator.

The exact evidence from the first attached-device pass is recorded in
`docs/hardware-validation.md`.
