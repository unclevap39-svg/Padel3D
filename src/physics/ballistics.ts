/**
 * Ball flight model shared by the Rapier world (forces applied every step), the trajectory
 * predictor used by the AI and aim assist, and the shot solver. Pure TypeScript.
 */
import { COURT } from '../rules/court';

export const BALL_RADIUS = 0.0335;
export const BALL_MASS = 0.058;
/** Thin-shell sphere: I = 2/3 m r². */
export const BALL_INERTIA = (2 / 3) * BALL_MASS * BALL_RADIUS * BALL_RADIUS;
export const GRAVITY = 9.81;
/** Rate at which spin decays in the air (1/s). */
export const SPIN_DAMPING = 0.15;

const AIR_DENSITY = 1.2;
const DRAG_COEFF = 0.55;
const AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
/** Drag acceleration = DRAG_K * |v| * v. */
export const DRAG_K = (0.5 * AIR_DENSITY * DRAG_COEFF * AREA) / BALL_MASS;
/** Magnus acceleration = MAGNUS_K * Cl * |v|² along (ω × v). */
export const MAGNUS_K = (0.5 * AIR_DENSITY * AREA) / BALL_MASS;

export interface SurfaceProps {
  restitution: number;
  friction: number;
}

/**
 * Restitution of the floor reproduces the regulation bounce (135-145 cm from a 2.54 m drop on a
 * hard surface gives e ≈ 0.74), slightly damped by sand-filled turf.
 */
export const SURFACES = {
  floor: { restitution: 0.72, friction: 0.55 },
  glass: { restitution: 0.76, friction: 0.22 },
  fence: { restitution: 0.42, friction: 0.5 },
  net: { restitution: 0.05, friction: 0.9 },
  ground: { restitution: 0.5, friction: 0.7 },
} satisfies Record<string, SurfaceProps>;

export const netHeightAt = (x: number): number =>
  COURT.netHeightCenter + ((COURT.netHeightPost - COURT.netHeightCenter) * Math.min(Math.abs(x), COURT.halfWidth)) / COURT.halfWidth;

/** Height of the side wall (glass + mesh) at a given z, and how much of it is glass. */
export function sideWallAt(z: number): { total: number; glass: number } {
  const d = COURT.halfLength - Math.abs(z); // distance from the back wall
  if (d <= COURT.sideStep1Length) return { total: COURT.sideStep1TotalHeight, glass: COURT.sideStep1GlassHeight };
  if (d <= COURT.sideStep1Length + COURT.sideStep2Length)
    return { total: COURT.sideStep2TotalHeight, glass: COURT.sideStep2GlassHeight };
  return { total: COURT.sideFenceHeight, glass: 0 };
}

export interface BallState {
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
}

export const cloneBall = (b: BallState): BallState => ({ ...b });

/** Aerodynamic acceleration (drag + Magnus), gravity excluded. Writes into `out`. */
export function aeroAccel(b: BallState, out: { x: number; y: number; z: number }): void {
  const speed = Math.hypot(b.vx, b.vy, b.vz);
  let ax = -DRAG_K * speed * b.vx;
  let ay = -DRAG_K * speed * b.vy;
  let az = -DRAG_K * speed * b.vz;
  const w = Math.hypot(b.wx, b.wy, b.wz);
  if (w > 1 && speed > 0.5) {
    const cl = 1 / (2 + speed / (BALL_RADIUS * w));
    const f = (MAGNUS_K * cl * speed) / w;
    ax += f * (b.wy * b.vz - b.wz * b.vy);
    ay += f * (b.wz * b.vx - b.wx * b.vz);
    az += f * (b.wx * b.vy - b.wy * b.vx);
  }
  out.x = ax;
  out.y = ay;
  out.z = az;
}

/**
 * Bounce of a spinning ball on a fixed surface with unit normal n (pointing away from the
 * surface), as the predictor sees it. It is calibrated on what the physics engine does, so that
 * a predicted path stays within a few tens of centimetres of the real one after a bounce:
 * friction takes μ·|vn| off the sliding speed (no more than what stops the slip) and leaves
 * the spin as it was. `tests/physics.test.ts` holds the two side by side.
 */
export function bounceOff(b: BallState, nx: number, ny: number, nz: number, s: SurfaceProps): void {
  const vn = b.vx * nx + b.vy * ny + b.vz * nz;
  if (vn >= 0) return;
  // Velocity of the contact point: v + ω × (-r n).
  const cx = b.vx - BALL_RADIUS * (b.wy * nz - b.wz * ny);
  const cy = b.vy - BALL_RADIUS * (b.wz * nx - b.wx * nz);
  const cz = b.vz - BALL_RADIUS * (b.wx * ny - b.wy * nx);
  const cn = cx * nx + cy * ny + cz * nz;
  let tx = cx - cn * nx;
  let ty = cy - cn * ny;
  let tz = cz - cn * nz;
  const slip = Math.hypot(tx, ty, tz);
  const jn = (1 + s.restitution) * -vn; // per unit mass
  b.vx += jn * nx;
  b.vy += jn * ny;
  b.vz += jn * nz;
  if (slip > 1e-6) {
    tx /= slip;
    ty /= slip;
    tz /= slip;
    // Impulse that would stop the slip entirely: slip / (1/m + r²/I) = 0.4 m slip for a shell.
    const stick = slip / (1 + (BALL_MASS * BALL_RADIUS * BALL_RADIUS) / BALL_INERTIA);
    const jt = Math.min(s.friction * -vn, stick);
    b.vx -= jt * tx;
    b.vy -= jt * ty;
    b.vz -= jt * tz;
  }
}

const tmpA = { x: 0, y: 0, z: 0 };

export function integrate(b: BallState, dt: number): void {
  aeroAccel(b, tmpA);
  const dvx = tmpA.x * dt;
  const dvy = (tmpA.y - GRAVITY) * dt;
  const dvz = tmpA.z * dt;
  // Trapezoidal position update: matches Rapier's sub-stepped integration closely.
  b.px += (b.vx + dvx * 0.5) * dt;
  b.py += (b.vy + dvy * 0.5) * dt;
  b.pz += (b.vz + dvz * 0.5) * dt;
  b.vx += dvx;
  b.vy += dvy;
  b.vz += dvz;
  const k = 1 / (1 + dt * SPIN_DAMPING);
  b.wx *= k;
  b.wy *= k;
  b.wz *= k;
}

export interface PredSample {
  t: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Floor bounces so far in this prediction. */
  bounces: number;
  /** Wall contacts so far in this prediction. */
  walls: number;
}

export interface Prediction {
  samples: PredSample[];
  /** First floor contact, if any. */
  firstBounce: { t: number; x: number; z: number } | null;
  secondBounceT: number;
  /** Ball stopped by the net. */
  net: boolean;
  /** Ball left the enclosure. */
  out: boolean;
  /** Touched a wall or the mesh before its first floor bounce. */
  wallBeforeBounce: boolean;
}

const PRED_DT = 1 / 120;

/**
 * Simulates the ball forward against a simplified court (floor, walls, net) until its second
 * floor bounce, the net, leaving the court, or `maxTime`. One sample every `sampleEvery` steps.
 */
export function predict(start: BallState, maxTime = 4, startBounces = 0, sampleEvery = 2): Prediction {
  const b = cloneBall(start);
  const res: Prediction = {
    samples: [],
    firstBounce: null,
    secondBounceT: Infinity,
    net: false,
    out: false,
    wallBeforeBounce: false,
  };
  let bounces = startBounces;
  let walls = 0;
  const steps = Math.ceil(maxTime / PRED_DT);
  const hw = COURT.halfWidth - BALL_RADIUS;
  const hl = COURT.halfLength - BALL_RADIUS;
  for (let i = 0; i < steps; i++) {
    const pz0 = b.pz;
    const px0 = b.px;
    const py0 = b.py;
    integrate(b, PRED_DT);
    const t = (i + 1) * PRED_DT;

    // Net.
    if (pz0 * b.pz < 0 || b.pz === 0) {
      if (b.py < netHeightAt(b.px) + BALL_RADIUS * 0.5 && Math.abs(b.px) < COURT.halfWidth) {
        res.net = true;
        break;
      }
    }
    // Side walls.
    if (Math.abs(b.px) > hw && Math.abs(b.pz) <= COURT.halfLength) {
      const wall = sideWallAt(b.pz);
      const sx = Math.sign(b.px);
      if (b.py < wall.total && b.vx * sx > 0) {
        b.px = sx * hw;
        bounceOff(b, -sx, 0, 0, b.py < wall.glass ? SURFACES.glass : SURFACES.fence);
        walls++;
        if (bounces === startBounces && startBounces === 0) res.wallBeforeBounce = true;
      }
    }
    // Back walls.
    if (Math.abs(b.pz) > hl && Math.abs(b.px) <= COURT.halfWidth) {
      const sz = Math.sign(b.pz);
      if (b.py < COURT.backTotalHeight && b.vz * sz > 0) {
        b.pz = sz * hl;
        bounceOff(b, 0, 0, -sz, b.py < COURT.backGlassHeight ? SURFACES.glass : SURFACES.fence);
        walls++;
        if (bounces === startBounces && startBounces === 0) res.wallBeforeBounce = true;
      }
    }
    if (Math.abs(b.px) > COURT.halfWidth + 0.3 || Math.abs(b.pz) > COURT.halfLength + 0.3) {
      res.out = true;
      break;
    }
    // Floor.
    if (b.py < BALL_RADIUS && b.vy < 0) {
      // Put the ball back where its path met the floor.
      const f = py0 > b.py ? Math.min(1, Math.max(0, (py0 - BALL_RADIUS) / (py0 - b.py))) : 1;
      b.px = px0 + (b.px - px0) * f;
      b.pz = pz0 + (b.pz - pz0) * f;
      b.py = BALL_RADIUS;
      bounceOff(b, 0, 1, 0, SURFACES.floor);
      bounces++;
      if (bounces === 1 && !res.firstBounce) res.firstBounce = { t, x: b.px, z: b.pz };
      if (bounces - startBounces >= 2 || bounces >= 2) {
        res.secondBounceT = t;
        res.samples.push({ t, x: b.px, y: b.py, z: b.pz, vx: b.vx, vy: b.vy, vz: b.vz, bounces, walls });
        break;
      }
    }
    if (i % sampleEvery === 0) {
      res.samples.push({ t, x: b.px, y: b.py, z: b.pz, vx: b.vx, vy: b.vy, vz: b.vz, bounces, walls });
    }
  }
  return res;
}

export type SpinKind = 'flat' | 'top' | 'slice';

export interface ShotSpec {
  from: { x: number; y: number; z: number };
  target: { x: number; z: number };
  /** Desired launch speed in m/s. The solver may lower it to clear the net or raise it to reach. */
  speed: number;
  spin: SpinKind;
  /** Spin rate in rad/s. */
  spinRate: number;
  /** High arc. */
  lob?: boolean;
  /** Launch angle for lobs, in radians. */
  lobAngle?: number;
  /** Required clearance above the net tape, in metres. */
  netClearance?: number;
}

export interface ShotSolution extends BallState {
  /** False when no trajectory met the constraints and a best effort is returned. */
  ok: boolean;
  speed: number;
}

interface Flight {
  range: number;
  /** Height above the net tape when crossing it, or +Infinity if the net is not crossed. */
  clearance: number;
}

function launch(spec: ShotSpec, dirX: number, dirZ: number, speed: number, angle: number): BallState {
  const ch = Math.cos(angle) * speed;
  // Top spin axis is up × direction; slice is the opposite.
  const sign = spec.spin === 'top' ? 1 : spec.spin === 'slice' ? -1 : 0;
  return {
    px: spec.from.x,
    py: spec.from.y,
    pz: spec.from.z,
    vx: dirX * ch,
    vy: Math.sin(angle) * speed,
    vz: dirZ * ch,
    wx: sign * spec.spinRate * dirZ,
    wy: 0,
    wz: sign * spec.spinRate * -dirX,
  };
}

function fly(b: BallState): Flight {
  const x0 = b.px;
  const z0 = b.pz;
  let clearance = Infinity;
  for (let i = 0; i < 1200; i++) {
    const pz0 = b.pz;
    const py0 = b.py;
    const px0 = b.px;
    integrate(b, PRED_DT);
    if (pz0 * b.pz <= 0 && pz0 !== b.pz) {
      const f = pz0 / (pz0 - b.pz);
      const y = py0 + (b.py - py0) * f;
      const x = px0 + (b.px - px0) * f;
      clearance = y - BALL_RADIUS - netHeightAt(x);
    }
    if (b.py <= BALL_RADIUS && b.vy < 0) break;
  }
  return { range: Math.hypot(b.px - x0, b.pz - z0), clearance };
}

/**
 * Finds a launch velocity that lands the ball on the target. Flat shots use the low arc at the
 * requested speed, slowing down (which raises the arc) until the net is cleared; lobs use a
 * fixed steep angle and solve for speed.
 */
export function solveShot(spec: ShotSpec): ShotSolution {
  const dx = spec.target.x - spec.from.x;
  const dz = spec.target.z - spec.from.z;
  const dist = Math.max(0.5, Math.hypot(dx, dz));
  const dirX = dx / dist;
  const dirZ = dz / dist;
  const margin = spec.netClearance ?? 0.12;

  if (spec.lob) {
    const angle = spec.lobAngle ?? 0.95;
    let lo = 3;
    let hi = 32;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (fly(launch(spec, dirX, dirZ, mid, angle)).range < dist) lo = mid;
      else hi = mid;
    }
    const speed = (lo + hi) / 2;
    return { ...launch(spec, dirX, dirZ, speed, angle), ok: true, speed };
  }

  const ANGLE_MIN = -0.7;
  const ANGLE_MAX = 0.62;
  let speed = spec.speed;
  let best: ShotSolution | null = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    // Not enough speed to reach even on the highest low arc: speed up.
    if (fly(launch(spec, dirX, dirZ, speed, ANGLE_MAX)).range < dist) {
      speed *= 1.12;
      if (speed > 50) break;
      continue;
    }
    let lo = ANGLE_MIN;
    let hi = ANGLE_MAX;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (fly(launch(spec, dirX, dirZ, speed, mid)).range < dist) lo = mid;
      else hi = mid;
    }
    const angle = (lo + hi) / 2;
    const flight = fly(launch(spec, dirX, dirZ, speed, angle));
    const sol = { ...launch(spec, dirX, dirZ, speed, angle), ok: flight.clearance >= margin, speed };
    if (sol.ok) return sol;
    best = sol;
    speed *= 0.93;
    if (speed < 5) break;
  }
  if (best) {
    // Last resort: lob it over.
    const lobbed = solveShot({ ...spec, lob: true, lobAngle: 0.8 });
    return { ...lobbed, ok: false };
  }
  return { ...launch(spec, dirX, dirZ, speed, 0.3), ok: false, speed };
}
