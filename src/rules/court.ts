/**
 * Official padel court dimensions (metres). Pure data: no rendering or physics imports,
 * so the rules engine can be unit-tested on its own.
 *
 * Axes: x across the width (-5..5), z along the length (-10..10), y up. The net is at z = 0.
 * Team 0 defends the z > 0 half, team 1 the z < 0 half.
 */
export const COURT = {
  halfWidth: 5,
  halfLength: 10,
  netHeightCenter: 0.88,
  netHeightPost: 0.92,
  serviceLineZ: 6.95,
  lineWidth: 0.05,
  /** Back wall: 3 m of glass topped by 1 m of wire mesh. */
  backGlassHeight: 3,
  backTotalHeight: 4,
  /** Side walls are stepped: 2 m long panel 3 m high, then 2 m long panel 2 m high. */
  sideStep1Length: 2,
  sideStep1GlassHeight: 3,
  sideStep1TotalHeight: 4,
  sideStep2Length: 2,
  sideStep2GlassHeight: 2,
  sideStep2TotalHeight: 3,
  /** Central part of the side walls is wire mesh only. */
  sideFenceHeight: 3,
} as const;

export type Team = 0 | 1;
/** Players 0 and 1 belong to team 0, players 2 and 3 to team 1. */
export type PlayerId = 0 | 1 | 2 | 3;

export const teamOf = (p: PlayerId): Team => (p >> 1) as Team;
export const otherTeam = (t: Team): Team => (t === 0 ? 1 : 0);
/** Which team's half a z coordinate belongs to. */
export const sideOfZ = (z: number): Team => (z > 0 ? 0 : 1);

export type ServeSide = 'right' | 'left';

/**
 * Sign of x for the given team's right-hand side. Team 0 faces -z, so its right is +x;
 * team 1 faces +z, so its right is -x.
 */
export const rightSign = (t: Team): 1 | -1 => (t === 0 ? 1 : -1);

/** x sign of the half the server must stand in. */
export function serverXSign(serverTeam: Team, side: ServeSide): 1 | -1 {
  const r = rightSign(serverTeam);
  return (side === 'right' ? r : -r) as 1 | -1;
}

/** x sign of the diagonal service box the serve must land in. */
export function serviceBoxXSign(serverTeam: Team, side: ServeSide): 1 | -1 {
  return -serverXSign(serverTeam, side) as 1 | -1;
}

/** True when a floor contact at (x, z) is inside the service box (lines are in). */
export function inServiceBox(x: number, z: number, receivingTeam: Team, boxXSign: 1 | -1): boolean {
  const tol = COURT.lineWidth / 2 + 0.0335; // half a line plus the ball radius: touching the line is in
  if (sideOfZ(z) !== receivingTeam) return false;
  if (Math.abs(z) > COURT.serviceLineZ + tol) return false;
  if (Math.abs(x) > COURT.halfWidth) return false;
  return x * boxXSign >= -tol;
}
