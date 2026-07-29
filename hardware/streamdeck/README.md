# Stream Deck XL bridge

This plugin uses the Stream Deck application's native plugin WebSocket and
connects it to the Synthteam server at `ws://127.0.0.1:4179/ws`.

## Development install

1. Start Synthteam on its default port with `bun start`.
2. Copy or symlink `com.synthteam.deck.sdPlugin` into:
   `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`
3. Restart the Stream Deck application.
4. Create an XL profile, place the **Synthteam Switchboard** action on the
   first key, then copy it across all 32 keys.

The bridge uses each action instance's row and column, so all 32 positions must
contain the Synthteam action. A bundled profile will replace this manual step
after it can be exported and verified with the physical XL.

Synthteam begins with the first two columns active and unlocks more columns at
each level. The plugin renders the remaining keys as `LOCKED` and does not
forward their key events until the server activates them.

The plugin runtime is the Node 24 environment supplied by Stream Deck. The
plugin itself is dependency-free and the rest of Synthteam runs on Bun.
