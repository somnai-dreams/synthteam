import { describe, expect, test } from "bun:test";
import {
  advanceMission,
  createMission,
  type MissionDependencies,
} from "../game/mission.ts";
import { STATIONS } from "./domain.ts";
import type { ConsoleSnapshot } from "./protocol.ts";
import {
  parseClientMessage,
  parseServerMessage,
  publicDirectiveForStation,
} from "./protocol.ts";

function deterministicDependencies(): MissionDependencies {
  let nextId = 0;
  return {
    random: () => 0.25,
    makeId: () => {
      nextId += 1;
      return `task-${nextId}`;
    },
  };
}

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
      pushBridgeConnected: false,
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

  test("publishes cross-routed, local, and procedure-specific directives", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);

    expect(
      publicDirectiveForStation(mission, "streamdeck").kind,
    ).toBe("order");

    advanceMission(mission, 19_000, dependencies);
    const local = publicDirectiveForStation(mission, "streamdeck");
    expect(local.kind).toBe("local-override");
    if (local.kind !== "local-override") {
      throw new Error("Expected local override directive");
    }
    expect(local.station).toBe("streamdeck");

    advanceMission(mission, 25_000, dependencies);
    advanceMission(mission, 43_000, dependencies);

    expect(
      publicDirectiveForStation(mission, "streamdeck").kind,
    ).toBe("reactor-manual");
    expect(
      publicDirectiveForStation(mission, "uf8").kind,
    ).toBe("reactor-operator");
    expect(
      publicDirectiveForStation(mission, "push").kind,
    ).toBe("reactor-support");
  });
});
