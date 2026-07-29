# @synthteam/ableton-push

A Bun-first driver for using Ableton Push as an independent control surface:

- typed pad, button, encoder, dial, and touch-strip input;
- pad and button palette output, including MIDI-channel animations;
- direct `960 × 160` RGBA display frames with automatic keepalive;
- explicit Push 2 and Push 3 USB identities and configurable MIDI port
  matching.

Push 3 is the currently configured target. Push 2 uses Ableton's documented
display protocol and known USB product ID. Both models remain experimental
until they complete the package's attached-device validation matrix.

## Requirements

- Bun 1.3 or newer;
- a USB-connected Push in Control Mode;
- no other process, including Ableton Live, holding the Push display or selected
  MIDI port.

The native `usb` and `@julusian/midi` dependencies may require adding them to
the consuming application's `trustedDependencies` before `bun install`.

## Example

```ts
import {
  AbletonPush,
  HEIGHT,
  PAD_COLORS,
  WIDTH,
} from "@synthteam/ableton-push";

const push = await AbletonPush.open({ model: "push3" });
const unsubscribe = push.onInput((event) => {
  switch (event.kind) {
    case "pad":
      console.log(event.x, event.y, event.down, event.velocity);
      break;
    case "button":
    case "dial":
    case "encoder":
    case "strip":
    case "strip-touch":
      console.log(event);
      break;
  }
});

try {
  push.setPad(0, 0, PAD_COLORS.cyan);

  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  rgba.fill(255);
  await push.display.rgba(rgba);
} finally {
  unsubscribe();
  await push.close();
}
```

The display framing and much of the MIDI map follow Ableton's
[Push 2 MIDI and Display Interface Manual](https://github.com/Ableton/push-interface).
The event-oriented API was also informed by
[`garrensmith/abletonpush`](https://github.com/garrensmith/abletonpush).

Ableton and Push are trademarks of Ableton AG. This independent project is not
affiliated with or endorsed by Ableton.
