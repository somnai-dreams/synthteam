import { describe, expect, test } from "bun:test";
import {
  applyHardwareEvent,
  createMission,
  type MissionDependencies,
} from "../game/mission.ts";
import { REACTOR_PROFILES, STATIONS } from "./domain.ts";
import type {
  AnonymousSnapshot,
  ConsoleSnapshot,
} from "./protocol.ts";
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
  test("accepts an explicit phone station claim", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "phone-claim",
          name: "Mara",
          station: "uf8",
        }),
      ),
    ).toEqual({
      type: "phone-claim",
      name: "Mara",
      station: "uf8",
    });
  });

  test("accepts a crew reservation resume", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "phone-resume",
          crewId: "crew-1",
        }),
      ),
    ).toEqual({ type: "phone-resume", crewId: "crew-1" });
  });

  test("rejects a claim for an unknown station", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "phone-claim",
          name: "Mara",
          station: "launchpad",
        }),
      ),
    ).toBeNull();
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

  test("accepts a reserved crew station and rejects a malformed reservation", () => {
    const snapshot = {
      viewer: { kind: "anonymous" },
      crew: {
        streamdeck: null,
        uf8: {
          id: "crew-1",
          name: "Mara",
          station: "uf8",
          connection: { kind: "reserved", endsAt: 11_000 },
        },
        push: null,
      },
      phase: { kind: "lobby" },
      activity: [],
      phoneUrls: ["http://localhost:4179"],
      streamDeckConnected: false,
      pushBridgeConnected: false,
      uf8Connection: { kind: "disconnected", message: "waiting" },
    } satisfies AnonymousSnapshot;

    expect(
      parseServerMessage(JSON.stringify({ type: "snapshot", snapshot })),
    ).toEqual({ type: "snapshot", snapshot });
    expect(
      parseServerMessage(
        JSON.stringify({
          type: "snapshot",
          snapshot: {
            ...snapshot,
            crew: {
              ...snapshot.crew,
              uf8: {
                ...snapshot.crew.uf8,
                connection: { kind: "reserved" },
              },
            },
          },
        }),
      ),
    ).toBeNull();
  });

  test("publishes order, interstitial, and procedure-specific directives", () => {
    const dependencies = deterministicDependencies();
    const mission = createMission(1_000, STATIONS, dependencies);

    expect(
      publicDirectiveForStation(mission, "streamdeck").kind,
    ).toBe("order");

    mission.levelObjectivesCompleted = 2;
    if (mission.activity.kind !== "orders") {
      throw new Error("Expected order activity");
    }
    const deck = mission.activity.tasks.find(
      (task) => task.kind === "streamdeck-route",
    );
    if (deck === undefined) {
      throw new Error("Expected Stream Deck route");
    }
    applyHardwareEvent(
      mission,
      {
        kind: "streamdeck-key",
        keyIndex: deck.sourceKeyIndex,
        phase: "down",
      },
      2_000,
      dependencies,
    );
    applyHardwareEvent(
      mission,
      {
        kind: "streamdeck-key",
        keyIndex: deck.targetKeyIndex,
        phase: "down",
      },
      2_001,
      dependencies,
    );
    const solo = publicDirectiveForStation(mission, "streamdeck");
    const support = publicDirectiveForStation(mission, "uf8");
    expect(solo.kind).toBe("interstitial");
    expect(support.kind).toBe("interstitial-support");

    const profile = REACTOR_PROFILES[0];
    if (profile === undefined) {
      throw new Error("Expected reactor profile");
    }
    mission.level = 5;
    mission.activity = {
      kind: "reactor-procedure",
      startedAt: 3_000,
      endsAt: 23_000,
      procedure: {
        id: "procedure-1",
        reader: "streamdeck",
        createdAt: 3_000,
        deadlineAt: 23_000,
        profile,
        tolerance: 3,
        holdMs: 650,
        withinSince: null,
      },
    };

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
