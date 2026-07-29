import { describe, expect, test } from "bun:test";
import type { CrewSlots } from "../shared/domain.ts";
import {
  claimStation,
  connectedCrewStations,
  CREW_RESERVATION_MS,
  releaseExpiredReservations,
  reserveCrewStation,
  resumeCrew,
} from "./crew.ts";

function emptyCrew(): CrewSlots {
  return { streamdeck: null, uf8: null, push: null };
}

describe("crew station claims", () => {
  test("lets the first phone claim a station and rejects a racing claim", () => {
    const crew = emptyCrew();

    expect(
      claimStation(crew, "uf8", "Mara", () => "crew-1").kind,
    ).toBe("claimed");
    expect(
      claimStation(crew, "uf8", "Ivo", () => "crew-2"),
    ).toEqual({ kind: "unavailable" });
    expect(crew.uf8?.name).toBe("Mara");
  });

  test("reserves a disconnected station for ten seconds", () => {
    const crew = emptyCrew();
    claimStation(crew, "push", "Mara", () => "crew-1");

    expect(reserveCrewStation(crew, "push", "crew-1", 1_000)).toBe(true);
    expect(
      claimStation(crew, "push", "Ivo", () => "crew-2").kind,
    ).toBe("unavailable");
    expect(releaseExpiredReservations(crew, 1_000 + CREW_RESERVATION_MS - 1))
      .toEqual([]);
    expect(crew.push?.connection.kind).toBe("reserved");
  });

  test("releases a reservation after its deadline", () => {
    const crew = emptyCrew();
    claimStation(crew, "streamdeck", "Mara", () => "crew-1");
    reserveCrewStation(crew, "streamdeck", "crew-1", 1_000);

    expect(
      releaseExpiredReservations(crew, 1_000 + CREW_RESERVATION_MS),
    ).toEqual([
      {
        id: "crew-1",
        name: "Mara",
        station: "streamdeck",
        connection: {
          kind: "reserved",
          endsAt: 1_000 + CREW_RESERVATION_MS,
        },
      },
    ]);
    expect(crew.streamdeck).toBeNull();
  });

  test("reconnects to a reservation and prevents its release", () => {
    const crew = emptyCrew();
    claimStation(crew, "uf8", "Mara", () => "crew-1");
    reserveCrewStation(crew, "uf8", "crew-1", 1_000);

    expect(resumeCrew(crew, "crew-1").kind).toBe("resumed");
    expect(
      releaseExpiredReservations(crew, 1_000 + CREW_RESERVATION_MS),
    ).toEqual([]);
    expect(crew.uf8?.connection).toEqual({ kind: "connected" });
  });

  test("only counts actively connected stations for mission launch", () => {
    const crew = emptyCrew();
    claimStation(crew, "streamdeck", "Mara", () => "crew-1");
    claimStation(crew, "uf8", "Ivo", () => "crew-2");
    reserveCrewStation(crew, "uf8", "crew-2", 1_000);

    expect(connectedCrewStations(crew)).toEqual(["streamdeck"]);
  });
});
