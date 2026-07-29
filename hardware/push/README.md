# Ableton Push 3 bridge

A dedicated hardware client that connects the Push 3 to the Synthteam
server over its local WebSocket, the same pattern as the Stream Deck
plugin. It replaces the console's Web MIDI path for the Push and adds
the one thing Web MIDI can't reach: the Push's 960x160 display.

During a mission the display shows the live vector path (mirroring the
pad LEDs), trace progress, score, combo, ship integrity, the mission
clock and order deadline — and flashes HULL BREACH when integrity
drops. In the lobby it shows link status; game over shows the result.

The Push 3 exposes the same USB display protocol as the Push 2
(Ableton's push-interface docs apply); only the USB product id differs.
Pads and LEDs go over the `Ableton Push 3 Live Port` MIDI port with the
fixed 8x8 grid at notes 36-99, bottom-left origin — no corner learning
required.

## Requirements

- Push 3 connected over USB, in Control Mode (not driving Live)
- `libusb` (`brew install libusb`)
- [uv](https://docs.astral.sh/uv/)

## Run

Start the Synthteam server, then:

```sh
cd hardware/push
uv run bridge.py
```

The bridge sends `{"type": "push-join"}`, receives `push-state`
messages (mission phase + the active push-path task), and submits
`push-pad` hardware events. It reconnects automatically, so start
order doesn't matter. Point it at a non-default server with
`--server ws://host:port/ws`.

Note: only one process can hold the Push display — close Live and any
other Push tool before starting the bridge. Push 1/2 owners: the MIDI
side matches Push 2 as-is (Push 1 untested); for Push 2 the display
works after changing `PRODUCT_ID` to `0x1967` in `push3_display.py`.
