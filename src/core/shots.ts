/**
 * How a human player's shot is decided: the power gauge, the pace of each kind of shot and where
 * the ball is aimed. Pure functions shared by the simulation (which adds the execution error)
 * and by the view (which draws the aim marker), so both always agree — online guest included.
 */
import { COURT } from '../rules/court';
import type { ShotType, StrokeKind } from './types';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Seconds of holding a shot button to fill the gauge. */
export const CHARGE_TIME = 1.0;
/** Above this level the shot is overhit: faster and deeper, but much less accurate. */
export const OVER_START = 0.88;
/** Lower edge of the "ideal" zone drawn on the gauge. */
export const IDEAL_START = 0.55;
/** A button held this long is released automatically. */
export const MAX_HOLD = 4;

/** Gauge level after holding a button for `elapsed` seconds. */
export const gaugeAt = (elapsed: number): number => clamp(elapsed / CHARGE_TIME, 0, 1);

/** 0 below the overhit zone, 1 at full gauge. */
export const overOf = (g: number): number => clamp((g - OVER_START) / (1 - OVER_START), 0, 1);

export type ShotClass = 'serve' | 'lob' | 'smash' | 'bandeja' | 'volley' | 'drive';

/** Kind of shot actually played, from the button pressed and the stroke the contact allows. */
export function classify(type: ShotType, stroke: StrokeKind, contactY: number, isServe: boolean): ShotClass {
  if (isServe) return 'serve';
  if (type === 'lob') return 'lob';
  if (stroke === 'smash' && contactY > 1.85) return 'smash';
  if (stroke === 'bandeja') return 'bandeja';
  if (stroke === 'volley_fh' || stroke === 'volley_bh') return 'volley';
  // A smash asked for on a low ball is an ordinary drive: there is no free extra pace.
  return 'drive';
}

export interface Pace {
  /** Landing distance beyond the net, before any clamp. */
  depth: number;
  /** Launch speed, m/s. */
  speed: number;
  spin: 'flat' | 'top' | 'slice';
  spinRate: number;
  clearance: number;
  lob: boolean;
  lobAngle?: number;
}

/** Pace, depth and spin of a shot for a gauge level `g` (0..1). */
export function shotPace(cls: ShotClass, g: number): Pace {
  const over = overOf(g);
  switch (cls) {
    case 'serve':
      return { depth: 4.3 + 1.7 * g + 0.9 * over, speed: 13 + 10 * g, spin: 'slice', spinRate: 50, clearance: 0.2, lob: false };
    case 'lob':
      return { depth: 7.5 + 1.3 * g + 0.9 * over, speed: 12, spin: 'top', spinRate: 40, clearance: 0.22, lob: true, lobAngle: 0.92 + 0.14 * g };
    case 'smash':
      // Aimed around the service line: a steep bounce that rises out of reach, instead of a flat
      // ball that comes back off the glass at hip height.
      return { depth: 5.7 + 1.0 * g + 2.4 * over, speed: 22 + 16 * g, spin: 'top', spinRate: 30, clearance: 0.1, lob: false };
    case 'bandeja':
      return { depth: 7.0 + 1.4 * g + 0.8 * over, speed: 13 + 7 * g, spin: 'slice', spinRate: 110, clearance: 0.25, lob: false };
    case 'volley':
      return { depth: 4.8 + 3.2 * g + 1.0 * over, speed: 11 + 9 * g, spin: 'slice', spinRate: 70, clearance: 0.18, lob: false };
    default:
      return { depth: 6.1 + 2.3 * g + 1.0 * over, speed: 14.5 + 9.5 * g, spin: 'top', spinRate: 50 + 70 * g, clearance: 0.25, lob: false };
  }
}

/**
 * Spread of a human shot around its target, in metres. Smaller with the aim help, larger when
 * the ball is met badly (`quality` 0..1). The overhit penalty is applied separately.
 */
export function humanSigma(assist: number, quality: number, isServe: boolean): number {
  return (0.6 - 0.42 * assist) * (1 + (1 - quality) * 1.4) * (isServe ? 0.5 : 1);
}

/** Extra spread of an overhit shot. */
export const overError = (g: number): number => 1 + 1.3 * overOf(g);

export interface AimContext {
  cls: ShotClass;
  /** Gauge level 0..1. */
  g: number;
  /** Stick, -1..1, positive towards the player's right (screen right from behind the player). */
  aim: number;
  /** Where the ball is struck. */
  from: { x: number; z: number };
  /** World x direction of the player's right hand side. */
  rightX: 1 | -1;
  /** World z direction of the opponents' half. */
  fwd: 1 | -1;
  /** Aim help, 0..1. */
  assist: number;
  /** Spread of the shot (see `humanSigma`), without the overhit penalty. */
  sigma: number;
  /** World x sign of the service box to hit (serves only). */
  serveBox?: 1 | -1;
}

/**
 * Landing point aimed at. The stick places the ball across the court: released it goes back
 * safely towards the middle, pushed fully it goes to the corner — never beyond the lines. The
 * margin kept from the lines covers the shot's own spread, more generously with the aim help,
 * so a ball only goes out when it is overhit or badly met.
 */
export function aimTarget(c: AimContext): { x: number; z: number } {
  const pace = shotPace(c.cls, c.g);
  const k = 0.8 + 1.6 * c.assist;
  const aim = clamp(c.aim, -1, 1);
  if (c.cls === 'serve') {
    const box = c.serveBox ?? 1;
    const m = 0.3 + k * c.sigma;
    // Distance from the centre line inside the diagonal box. Beyond 3.85 m the ball would
    // reach the side mesh after its bounce, which is a fault.
    const lo = Math.max(0.55, m);
    const hi = Math.min(3.85, COURT.halfWidth - m);
    const bx = clamp(2.4 + aim * c.rightX * box * 1.7, lo, hi);
    const depth = clamp(pace.depth, 3.2, COURT.serviceLineZ - (0.3 + k * c.sigma * 1.2));
    return { x: box * bx, z: c.fwd * depth };
  }
  const mx = 0.3 + k * c.sigma;
  const mz = 0.35 + k * c.sigma * 1.2;
  const xSafe = Math.max(1, COURT.halfWidth - mx);
  // Own frame: +x is the player's right.
  const fx = clamp(c.from.x * c.rightX, -xSafe, xSafe);
  const neutral = fx * 0.45;
  const own = aim >= 0 ? neutral + (xSafe - neutral) * aim : neutral + (-xSafe - neutral) * -aim;
  const depth = clamp(pace.depth, 1.5, COURT.halfLength - mz);
  return { x: own * c.rightX, z: c.fwd * depth };
}
