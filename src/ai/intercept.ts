import type { Player } from '../entities/player';
import type { PredSample, Prediction } from '../physics/ballistics';
import { COURT } from '../rules/court';

/** How far from the body the ball is struck, sideways. */
export const HIT_OFFSET = 0.62;
/** Maximum horizontal distance at which a swing still connects. */
export const REACH = 1.55;
export const MIN_HIT_HEIGHT = 0.18;
export const MAX_HIT_HEIGHT = 2.85;

export interface Intercept {
  /** Absolute game time of the contact. */
  t: number;
  ball: { x: number; y: number; z: number };
  /** Where the player should stand. */
  stance: { x: number; z: number };
  backhand: boolean;
  /** Struck before bouncing. */
  volley: boolean;
  overhead: boolean;
  afterWall: boolean;
  score: number;
}

export interface InterceptOptions {
  now: number;
  /** Absolute time of the prediction's first sample origin. */
  predT0: number;
  /** The ball must have bounced (return of serve). */
  mustBounce: boolean;
  reaction: number;
  /** Earliest contact, seconds from now. */
  minLead: number;
}

/** Position from which `p` would strike a ball at sample `s`, forehand or backhand. */
function stanceFor(p: Player, s: PredSample, backhand: boolean, overhead: boolean): { x: number; z: number } {
  const off = overhead ? 0.22 : HIT_OFFSET;
  let x = s.x - p.rightX * off * (backhand ? -1 : 1);
  // Stand behind the ball (further from the net) so it is met in front of the body.
  let zs = s.z * p.sideSign + (overhead ? 0.15 : 0.32);
  const maxX = COURT.halfWidth - 0.4;
  x = Math.max(-maxX, Math.min(maxX, x));
  zs = Math.max(0.6, Math.min(COURT.halfLength - 0.4, zs));
  return { x, z: zs * p.sideSign };
}

/**
 * Best place and time for a player to meet the predicted ball: comfortable height, reachable in
 * time, preferring volleys at the net and patience (letting it bounce or come off the glass)
 * at the back.
 */
export function bestIntercept(p: Player, pred: Prediction, o: InterceptOptions): Intercept | null {
  let best: Intercept | null = null;
  for (const s of pred.samples) {
    const t = o.predT0 + s.t;
    const lead = t - o.now;
    if (lead < o.minLead) continue;
    if (s.z * p.sideSign < 0.2) continue; // not on our side yet
    if (s.bounces >= 2) continue;
    if (o.mustBounce && s.bounces < 1) continue;
    if (s.y < MIN_HIT_HEIGHT + 0.07 || s.y > MAX_HIT_HEIGHT - 0.1) continue;

    const volley = s.bounces === 0;
    const overhead = s.y > 1.95;
    const netDist = s.z * p.sideSign;

    const fh = stanceFor(p, s, false, overhead);
    const bh = stanceFor(p, s, true, overhead);
    const dfh = p.distanceTo(fh.x, fh.z);
    const dbh = p.distanceTo(bh.x, bh.z);
    const backhand = !overhead && dbh + 0.35 < dfh;
    const stance = backhand ? bh : fh;
    const travel = backhand ? dbh : dfh;

    const timeAvail = lead - o.reaction;
    const slack = p.maxSpeed * Math.max(0, timeAvail) * 0.9 + 0.3 - travel;
    if (slack < 0) continue;

    let score = Math.min(slack, 1.2) * 0.6 - lead * 0.2;
    if (overhead) {
      // An overhead is an attacking chance near the net, awkward from the back.
      score += netDist < 6.5 ? 0.9 - Math.abs(s.y - 2.35) : -0.8;
    } else {
      score -= Math.abs(s.y - 1.0) * 1.3;
    }
    if (volley) score += netDist < 5 ? 1.0 : -1.6;
    if (s.walls > 0) score -= 0.35;
    if (netDist > COURT.halfLength - 0.7) score -= 1.2; // jammed against the back glass
    if (Math.abs(s.x) > COURT.halfWidth - 0.45) score -= 0.8;
    if (s.vy > 1.5 && !volley) score -= 0.3; // still climbing off the bounce: harder to time

    if (!best || score > best.score) {
      best = {
        t,
        ball: { x: s.x, y: s.y, z: s.z },
        stance,
        backhand,
        volley,
        overhead,
        afterWall: s.walls > 0,
        score,
      };
    }
  }
  return best;
}

/**
 * Contact for a swing requested right now (the human player): the first moment in the next
 * `window` seconds where the ball passes within reach of where the player will be.
 */
export function swingContact(
  p: Player,
  pred: Prediction,
  o: { now: number; predT0: number; mustBounce: boolean; minLead: number; window: number },
): Intercept | null {
  let best: Intercept | null = null;
  let bestCost = Infinity;
  for (const s of pred.samples) {
    const t = o.predT0 + s.t;
    const lead = t - o.now;
    if (lead < o.minLead) continue;
    if (lead > o.window) break;
    if (s.z * p.sideSign < 0.05) continue;
    if (s.bounces >= 2) continue;
    if (o.mustBounce && s.bounces < 1) continue;
    if (s.y < MIN_HIT_HEIGHT || s.y > MAX_HIT_HEIGHT) continue;
    // Player keeps drifting a little while winding up.
    const k = Math.min(lead, 0.15);
    const px = p.x + p.vx * k;
    const pz = p.z + p.vz * k;
    const d = Math.hypot(s.x - px, s.z - pz);
    if (d > REACH) continue;
    // Prefer the ball at a comfortable distance and height, and do not wait needlessly.
    const cost = Math.abs(d - HIT_OFFSET) + Math.abs(s.y - 1.0) * 0.25 + lead * 0.6;
    if (cost < bestCost) {
      bestCost = cost;
      const side = (s.x - px) * p.rightX; // > 0: ball on the racket side
      const overhead = s.y > 1.95;
      best = {
        t,
        ball: { x: s.x, y: s.y, z: s.z },
        stance: { x: px, z: pz },
        backhand: !overhead && side < -0.05,
        volley: s.bounces === 0,
        overhead,
        afterWall: s.walls > 0,
        score: -cost,
      };
    }
  }
  return best;
}
