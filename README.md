# Synthteam

Synthteam is a two-or-three-player local-network coordination game built around
real control surfaces:

- a 32-key Stream Deck XL for routing;
- an SSL UF8 for continuous reactor levels;
- an Ableton Push for spatial navigation paths.

All hardware connects to one central laptop. Every player joins from a phone
and claims one open controller. They receive instructions for somebody else's
controller and have to shout them across the room. The Bun server owns station
claims and mission state, and only accepts game actions from the physical
device bridge or the clearly labelled development simulator.

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
addresses on each phone, enter a call sign, and choose an open controller.

The mission can start with any two claimed controllers. A third phone adds the
remaining station to the routing cycle when it joins before launch. A
disconnected phone keeps its station reserved for ten seconds before the
controller becomes claimable again.

## Quick play without phones

The central console also has a **Quick Play** launcher. Choose any individual
Deck, UF8, or Push game to start it immediately with no phone claim or
countdown. The complete order remains visible on the console, all controls are
unlocked, and the selected game starts a fresh round after every clear or
timeout. Scores and combos continue until **Exit to Lobby** or another game is
selected.

Connected hardware receives the same task as a campaign. The console simulator
also makes Deck keys, UF8 faders, and Push pads available without a crew claim;
Push games that depend on its display, labelled buttons, dial, or touch strip
still require the physical controller.

## Mission rhythm

Every run starts at Level 1 and advances automatically when the crew clears
that level's objective quota:

| Level | UF8 | Stream Deck XL | Push |
| --- | --- | --- | --- |
| 1 | first 2 faders | first 2 columns | bottom-left 3×3 |
| 2 | first 3 faders | first 3 columns | bottom-left 4×4 |
| 3 | first 4 faders | first 4 columns | bottom-left 6×6 |
| 4 | first 6 faders | first 6 columns | full 8×8 |
| 5 | all 8 faders | all 8 columns | full 8×8 |

Locked controls stay dim and their inputs are ignored. Later levels also add
longer sequences, tighter fader holds, longer Push paths, shorter deadlines,
and eventually the Push defend activity.

The run uses three explicit kinds of play:

- **Orders** are cross-routed. A phone receives an instruction for somebody
  else's controller and the reader must shout it across the crew.
- **Interstitials** are six-second, self-directed hardware bursts between
  levels. One operator receives `DO THIS YOURSELF`; Deck hits a called key, UF8
  bottoms out the currently active faders, or Push hits the active region's
  four corners. Success grants a small bonus. Failure costs a little integrity
  but never blocks the next level.
- **Reactor Procedures** suspend ordinary orders. The UF8 shows a diagnostic
  code while another player's phone holds the complete calibration table. The
  operator reports the code and the reader calls back the two required fader
  stops.

Level 5 ends with the Reactor Procedure when the UF8 is in the crew. A
two-player Deck-and-Push crew completes the run directly after its final quota.

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
350–600 ms, depending on the current level.

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

## Console simulator

Quick Play exposes the selected controller simulator without requiring a phone.
Campaign runs expose simulators only for claimed controllers. The simulator is
useful for practice, tests, and UI work when hardware is not attached; the
multiplayer MVP gate still requires completing a campaign without touching the
central laptop after launch.

## Verification

```sh
bun test
bun run check
bun run build
bun run probe:midi
bun run probe:uf8 preview
```

`check` uses TypeScript 7 plus type-aware oxlint. The current tests cover
two-and-three-device task generation, five-level control bounds, cross-routing,
Deck hold/tap/release orders, interstitial transitions and penalties, the
shared reactor finale, standalone game construction, scoring, expiration,
station claim races and reconnect reservations, direct UF8 framing and input
decoding, protocol validation, and Push note-grid mapping.
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
- complete one full five-level run without using the development simulator.

The exact evidence from the first attached-device pass is recorded in
`docs/hardware-validation.md`.
