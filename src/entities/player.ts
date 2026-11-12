import type { StrokeKind, Swing } from '../core/types';
import { COURT, type PlayerId, type Team, teamOf } from '../rules/court';

export type Mood = 'play' | 'celebrate' | 'dejected';

const ACCEL = 30;
const BRAKE = 36;
/** Players stay this far from the walls and the net. */
const WALL_MARGIN = 0.35;
const NET_MARGIN = 0.45;

/** Game-logic state of one player: position, movement and the swing in progress. No rendering. */
export class Player {
  readonly id: PlayerId;
  readonly team: Team;
  /** z sign of this player's half: +1 for team 0, -1 for team 1. */
  readonly sideSign: 1 | -1;
  /** Forward direction along z (towards the net). */
  readonly dir: 1 | -1;
  /** x direction of the player's right hand when facing the net. */
  readonly rightX: 1 | -1;
  /** x sign of the half this player usually covers. */
  readonly homeSign: 1 | -1;
  /** x sign of the half covered during the current point. */
  zone: 1 | -1;
  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  maxSpeed = 6;
  /** Desired movement, each component in -1..1 (magnitude clamped to 1). */
  wishX = 0;
  wishZ = 0;
  /** Point to run to; overrides wish when set. */
  moveTo: { x: number; z: number } | null = null;
  /** Speed limit while running to `moveTo` under the placement help; null for `maxSpeed`. */
  runSpeed: number | null = null;
  swing: Swing | null = null;
  mood: Mood = 'play';
  isHuman = false;
  /** False for the two players left out of a one-against-one match. */
  active = true;
  /** Server holding the ball out before dropping it. */
  holdingBall = false;
  /** Shot this player is getting ready for: the racket goes back before the swing is asked for. */
  prep: { stroke: StrokeKind; t: number } | null = null;
  /** Time the opponents last struck the ball: triggers the split step. */
  splitT = -10;

  constructor(id: PlayerId) {
    this.id = id;
    this.team = teamOf(id);
    this.sideSign = this.team === 0 ? 1 : -1;
    this.dir = -this.sideSign as 1 | -1;
    this.rightX = -this.dir as 1 | -1;
    // Team 0: player 0 right (+x), player 1 left. Team 1: player 2 on its right (-x), player 3 on its left.
    this.homeSign = (id === 0 || id === 3 ? 1 : -1) as 1 | -1;
    this.zone = this.homeSign;
  }

  place(x: number, z: number): void {
    this.x = x;
    this.z = z;
    this.vx = 0;
    this.vz = 0;
  }

  distanceTo(x: number, z: number): number {
    return Math.hypot(this.x - x, this.z - z);
  }

  update(dt: number, now: number): void {
    let wx = this.wishX;
    let wz = this.wishZ;
    let top = this.maxSpeed;
    if (this.moveTo) {
      if (this.runSpeed !== null) top = this.runSpeed;
      const dx = this.moveTo.x - this.x;
      const dz = this.moveTo.z - this.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.04) {
        wx = 0;
        wz = 0;
      } else {
        // Ease in over the last stretch so the player settles instead of overshooting.
        const speedWanted = Math.min(1, Math.sqrt((2 * BRAKE * d) / (top * top)) * 0.9);
        wx = (dx / d) * speedWanted;
        wz = (dz / d) * speedWanted;
      }
    }
    const m = Math.hypot(wx, wz);
    if (m > 1) {
      wx /= m;
      wz /= m;
    }
    // Planted feet while striking: slow right down around contact. A swing at thin air costs nothing.
    let limit = top;
    if (this.swing && this.swing.willHit) {
      const toContact = this.swing.contactT - now;
      if (toContact < 0.15 && toContact > -0.2) limit *= 0.35;
      else limit *= 0.75;
    }
    if (this.mood !== 'play') limit *= 0.4;
    const tx = wx * limit;
    const tz = wz * limit;
    const ddx = tx - this.vx;
    const ddz = tz - this.vz;
    const dd = Math.hypot(ddx, ddz);
    if (dd > 1e-6) {
      const braking = tx * this.vx + tz * this.vz < this.vx * this.vx + this.vz * this.vz - 1e-6;
      const step = Math.min(dd, (braking ? BRAKE : ACCEL) * dt);
      this.vx += (ddx / dd) * step;
      this.vz += (ddz / dd) * step;
    }
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    const maxX = COURT.halfWidth - WALL_MARGIN;
    if (this.x > maxX) {
      this.x = maxX;
      this.vx = Math.min(0, this.vx);
    } else if (this.x < -maxX) {
      this.x = -maxX;
      this.vx = Math.max(0, this.vx);
    }
    const zs = this.z * this.sideSign; // distance from the net, positive on own side
    const maxZ = COURT.halfLength - WALL_MARGIN;
    if (zs < NET_MARGIN) {
      this.z = NET_MARGIN * this.sideSign;
      if (this.vz * this.sideSign < 0) this.vz = 0;
    } else if (zs > maxZ) {
      this.z = maxZ * this.sideSign;
      if (this.vz * this.sideSign > 0) this.vz = 0;
    }
  }
}
