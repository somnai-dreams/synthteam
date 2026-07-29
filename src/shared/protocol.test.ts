import { describe, expect, test } from "bun:test";
import { parseClientMessage } from "./protocol.ts";

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
  });
});
