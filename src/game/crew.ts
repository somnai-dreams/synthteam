import type {
  CrewMember,
  CrewSlots,
  Station,
} from "../shared/domain.ts";
import { STATIONS } from "../shared/domain.ts";

export const CREW_RESERVATION_MS = 10_000;

export type ClaimStationResult =
  | { kind: "claimed"; member: CrewMember }
  | { kind: "unavailable" };

export type ResumeCrewResult =
  | { kind: "resumed"; station: Station; member: CrewMember }
  | { kind: "expired" };

export function claimStation(
  crew: CrewSlots,
  station: Station,
  name: string,
  makeId: () => string,
): ClaimStationResult {
  if (crew[station] !== null) {
    return { kind: "unavailable" };
  }
  const member: CrewMember = {
    id: makeId(),
    name,
    station,
    connection: { kind: "connected" },
  };
  crew[station] = member;
  return { kind: "claimed", member };
}

export function resumeCrew(
  crew: CrewSlots,
  crewId: string,
): ResumeCrewResult {
  for (const station of STATIONS) {
    const member = crew[station];
    if (member?.id === crewId) {
      member.connection = { kind: "connected" };
      return { kind: "resumed", station, member };
    }
  }
  return { kind: "expired" };
}

export function reserveCrewStation(
  crew: CrewSlots,
  station: Station,
  crewId: string,
  now: number,
): boolean {
  const member = crew[station];
  if (member === null || member.id !== crewId) {
    return false;
  }
  member.connection = {
    kind: "reserved",
    endsAt: now + CREW_RESERVATION_MS,
  };
  return true;
}

export function releaseExpiredReservations(
  crew: CrewSlots,
  now: number,
): CrewMember[] {
  const released: CrewMember[] = [];
  for (const station of STATIONS) {
    const member = crew[station];
    if (
      member !== null &&
      member.connection.kind === "reserved" &&
      now >= member.connection.endsAt
    ) {
      crew[station] = null;
      released.push(member);
    }
  }
  return released;
}

export function connectedCrewStations(crew: CrewSlots): Station[] {
  return STATIONS.filter(
    (station) => crew[station]?.connection.kind === "connected",
  );
}
