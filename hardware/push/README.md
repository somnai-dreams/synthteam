# Ableton Push 3 bridge

A dedicated hardware client that connects the Push 3 to the Synthteam
server over its local WebSocket, the same pattern as the Stream Deck
plugin. It replaces the console's Web MIDI path for the Push and adds
the one thing Web MIDI can't reach: the Push's 960x160 display.

The Push station has two kinds of activity, chosen by the server:

- **Trace the vector** (`push-path`): the classic order — the path
  lights up on the pads (next pad white), the screen mirrors it on a
  mini grid with progress, score, combo, ship integrity, the mission
  clock and the order deadline. Pad presses are forwarded to the
  server, which validates the trace. A HULL BREACH flash takes over
  the screen whenever mission integrity drops.
- **Defend the mothership** (`push-defend`): the server declares the
  activity with explicit difficulty parameters (`missileSpeed` in pads
  per second, `spawnIntervalMs`, `hull`) that ramp as the mission
  progresses. The bridge runs the minigame locally: the screen becomes
  the underside of our alien saucer (yellow bottom hemisphere, glowing
  window rim), missiles climb the pad columns, and pressing a
  missile's pad intercepts it. Every missile that reaches the top
  wounds the saucer visibly and costs a hull segment — the button row
  above the pads (CC 102-109) is the hull bar. Survive until the
  task's deadline and the server completes the activity; lose all hull
  and the bridge sends `push-defend-failed`, which the server scores
  like an expired order.

In the lobby the screen shows link status; game over shows the result.

Everything is JavaScript: `@julusian/midi` (RtMidi) for pads, buttons
and LEDs, and the `usb` package's WebUSB-shaped API for the display.
`push3.js` is a small reusable library (pad/encoder/dial events,
button backlights, RGBA frames to the screen); `bridge.js` is the
Synthteam client on top of it; `font.js` renders the text.

The Push 3 exposes the same USB display protocol as the Push 2
(Ableton's push-interface docs apply); only the USB product id differs.
Pads and LEDs go over the `Ableton Push 3 Live Port` MIDI port with the
fixed 8x8 grid at notes 36-99, bottom-left origin — no corner learning
required.

## Requirements

- Push 3 connected over USB, in Control Mode (not driving Live)
- Bun (Node 22+ also works: `node bridge.js`)

## Run

Start the Synthteam server, then:

```sh
cd hardware/push
bun install
bun bridge.js
```

The bridge sends `{"type": "push-join"}`, receives `push-state`
messages (mission phase + the active push-path task), and submits
`push-pad` hardware events. It reconnects automatically, so start
order doesn't matter. Point it at a non-default server with
`--server ws://host:port/ws`.

Note: only one process can hold the Push display — close Live and any
other Push tool before starting the bridge. Push 2 should work after
changing `PRODUCT_ID` to `0x1967` in `push3.js` (untested).
