import { describe, expect, test } from "bun:test";
import type { ConsoleSnapshot } from "./protocol.ts";
import { parseClientMessage, parseServerMessage } from "./protocol.ts";

describe("client protocol", () => {
  test("accepts a complete phone join", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "phone-join",
          name: "Mara",
          resumeCrewId: null,
        }),
      ),
    ).toEqual({
      type: "phone-join",
      name: "Mara",
      resumeCrewId: null,
    });
  });

  test("rejects an invalid hardware coordinate at the boundary", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "hardware-event",
          event: {
            kind: "push-pad",
            point: { x: 8, y: 2 },
            phase: "down",
            velocity: 100,
          },
        }),
      ),
    ).toBeNull();
  });

  test("rejects malformed JSON", () => {
    expect(parseClientMessage("{oops")).toBeNull();
  });

  test("accepts the Stream Deck plugin handshake", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "streamdeck-join" })),
    ).toEqual({ type: "streamdeck-join" });
    expect(
      parseClientMessage(JSON.stringify({ type: "push-join" })),
    ).toEqual({ type: "push-join" });
  });

  test("accepts the server-owned UF8 connection state", () => {
    const snapshot = {
      viewer: { kind: "console" },
      crew: { streamdeck: null, uf8: null, push: null },
      phase: { kind: "lobby" },
      activity: [],
      phoneUrls: ["http://localhost:4179"],
      streamDeckConnected: false,
      uf8Connection: { kind: "connected", serial: "UF-200292" },
      mission: null,
      uf8Faders: [0, 0, 0, 0, 0, 0, 0, 0],
    } satisfies ConsoleSnapshot;

    expect(
      parseServerMessage(
        JSON.stringify({ type: "snapshot", snapshot }),
      ),
    ).toEqual({ type: "snapshot", snapshot });
  });
});
