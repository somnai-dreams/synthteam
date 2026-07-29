# Synthteam MVP

Synthteam is a local, two-or-three-player coordination game built around three
different physical control surfaces. One laptop owns the hardware and runs the
Bun server. Each player reads private orders on a phone and shouts them to the
player standing at the controller that can complete them.

## Physical topology

```text
Phone: Deck crew ─┐
Phone: UF8 crew ──┼─ Wi-Fi ─> central Bun server
Phone: Push crew ─┘                 │
                                    ├─ Stream Deck XL plugin
                                    ├─ SSL UF8 direct USB runtime
                                    └─ Ableton Push User MIDI port
```

Phones never submit control actions. During a mission, valid actions can only
arrive through a hardware adapter or the explicitly labelled development
simulator in the central console.

Phones do not choose a station. The server assigns each new phone the first free
controller in Deck → UF8 → Push order. Two players therefore get the connected
Stream Deck and UF8 by default; the third adds Push.

## Controller-specific gameplay

### Stream Deck XL: routing and communications

The 32 LCD keys form a dynamic switchboard. The first MVP task asks the operator
to press a named source key followed by a named destination key. Later tasks can
add holds, chords, and ordered sequences without changing the game protocol.

### SSL UF8: reactor and propulsion

The eight motorized faders are continuous system levels. The first MVP task asks
the operator to move a named channel to one of the physical printed dB stops and
hold it there. The Bun server owns the direct USB session, draws every control
name and active target on the strip displays, receives native fader events, and
parks the motor bank at the printed `0 dB` point at mission start.

### Ableton Push: navigation and sensors

The 8×8 pad matrix is a spatial console. The first MVP task lights a short path
that the operator must trace in order. Push generation-specific discovery is a
hardware calibration concern, not a reason to flatten the task into a generic
button command.

## Mission rules

- There is one phone/crew slot per active controller.
- A mission starts with either two or three connected phones.
- The active stations form a routing cycle, so every reader always receives an
  order for another crew member's controller.
- Every phone receives an order for a different controller.
- Two or three orders run concurrently during a 90-second mission.
- Completing an order scores points, raises the combo, and repairs a small
  amount of integrity.
- A wrong discrete action costs a little integrity and resets that task's
  progress.
- An expired order costs significant integrity and is immediately replaced.
- The mission succeeds when time expires and fails when integrity reaches zero.

## MVP gate

The MVP is proven when either two or three players can join from phones and
complete a 90-second mission using only their assigned physical devices without
touching the central laptop after launch.

## Adapter boundary

The game engine never receives arbitrary strings or generic control values.
Every external input is normalized at the adapter boundary into one of:

- `streamdeck-key`, with a 0–31 coordinate-derived index and down/up phase;
- `uf8-fader`, with a 0–7 channel and normalized 0–100 value;
- `push-pad`, with an 8×8 coordinate, down/up phase, and velocity.

The Stream Deck plugin connects directly to the Bun WebSocket. The central
Chrome console owns Web MIDI only for Push because it is served from the trusted
`localhost` origin. The Bun server owns the exclusive UF8 USB connection.
Player phones do not request hardware permissions.
