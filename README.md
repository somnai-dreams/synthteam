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
- Chrome on the central hardware laptop for Web MIDI;
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

1. Connect the UF8 and open SSL 360°.
2. Put the UF8 into its MIDI CC layer.
3. Give its eight faders distinct CC assignments.
4. In the Synthteam console, select the UF8 MIDI input.
5. Choose **Learn faders 1 → 8**, then move each physical fader once in order.

The mapping is validated and stored in the central browser's local storage.
A fader task completes after the correct channel remains within its target
tolerance for 450 ms.

### Ableton Push

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
```

`check` uses TypeScript 7 plus type-aware oxlint. The current tests cover
two-and-three-device task generation, cross-routing, scoring, expiration,
controller-specific progress, protocol validation, and Push note-grid mapping.
`probe:midi` asks macOS CoreMIDI for the exact input and output endpoints
currently exposed to Chrome.

## Current hardware gate

The central laptop currently detects the connected Stream Deck XL and SSL UF8
over USB. The live probe found no CoreMIDI endpoints and no installed Stream
Deck or SSL 360° host application, so USB presence alone is not enough to run a
mission. Install the two vendor applications before calibration; SSL's own UF8
guide describes SSL 360° as required for the controller to function.

The remaining physical gates are:

- install Stream Deck, load the local plugin, and export a verified 32-key XL
  profile;
- install SSL 360°, expose eight UF8 MIDI CC faders, and learn them in the
  console;
- connect the Push, identify its generation, and tune its User-port LED
  palette;
- complete one 90-second mission without using the development simulator.

The exact evidence from the first attached-device pass is recorded in
`docs/hardware-validation.md`.
