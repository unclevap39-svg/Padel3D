/**
 * Procedural character animation. No free padel motion capture exists, so every movement is
 * generated from a model of how players move: footsteps planted in world space (a planted foot
 * never slides), limbs solved with two-bone IK, and strokes built as a kinetic chain timed so
 * the racket meets the ball at the real contact point.
 *
 * Everything is expressed in the character's local frame: origin on the ground under the hips,
 * +z forward, +y up, +x to the character's left (so the right hand lives at negative x).
 */
import * as THREE from 'three';
import type { StrokeKind, Swing } from '../core/types';
import type { Mood, Player } from './player';

export interface Proportions {
  hipHeight: number;
  hipHalfWidth: number;
  thigh: number;
  shin: number;
  ankleHeight: number;
  footLength: number;
  /** Hips to the shoulder line. */
  spine: number;
  shoulderHalfWidth: number;
  neck: number;
  headRadius: number;
  upperArm: number;
  foreArm: number;
  hand: number;
}

export const DEFAULT_PROPORTIONS: Proportions = {
  hipHeight: 0.93,
  hipHalfWidth: 0.095,
  thigh: 0.435,
  shin: 0.43,
  ankleHeight: 0.075,
  footLength: 0.17,
  spine: 0.46,
  shoulderHalfWidth: 0.185,
  neck: 0.1,
  headRadius: 0.105,
  upperArm: 0.29,
  foreArm: 0.265,
  hand: 0.09,
};

/** Distance from the wrist to the racket's sweet spot. */
export const RACKET_REACH = 0.33;

/** Joint positions and key orientations in the character's local frame. */
export class Pose {
  hips = new THREE.Vector3();
  chest = new THREE.Vector3();
  neck = new THREE.Vector3();
  head = new THREE.Vector3();
  hipsQuat = new THREE.Quaternion();
  chestQuat = new THREE.Quaternion();
  headQuat = new THREE.Quaternion();
  shoulder = [new THREE.Vector3(), new THREE.Vector3()]; // 0 = left, 1 = right
  elbow = [new THREE.Vector3(), new THREE.Vector3()];
  wrist = [new THREE.Vector3(), new THREE.Vector3()];
  hip = [new THREE.Vector3(), new THREE.Vector3()];
  knee = [new THREE.Vector3(), new THREE.Vector3()];
  ankle = [new THREE.Vector3(), new THREE.Vector3()];
  toe = [new THREE.Vector3(), new THREE.Vector3()];
  /** Unit vector from the right wrist along the racket handle. */
  racketDir = new THREE.Vector3(0, 1, 0);
  /** Unit normal of the racket face. */
  racketNormal = new THREE.Vector3(0, 0, 1);
}

type V3 = [number, number, number];

interface StrokeDef {
  /** Racket hand at the end of the take-back, and the racket's direction there. */
  back: V3;
  backDir: V3;
  /** Shoulder turn at the end of the take-back (radians, positive = to the left). */
  backYaw: number;
  /** Point the hand swings through between take-back and contact. */
  via: V3;
  contactDir: V3;
  contactYaw: number;
  follow: V3;
  followDir: V3;
  followYaw: number;
  /** Forward lean of the chest at the end of the swing. */
  followPitch: number;
  /** Fraction of the wind-up spent taking the racket back. */
  backFrac: number;
  overhead: boolean;
  /** Where the feet go for the shot, relative to the neutral stance: [x, z] for left and right. */
  stanceL: [number, number];
  stanceR: [number, number];
  /** Left hand during the take-back; null keeps it on the racket (two-handed preparation). */
  leftBack: V3 | null;
  /** Left hand during the forward swing and follow-through. */
  leftSwing: V3;
  /** Knee bend while loading, and how far the weight moves from back foot to front foot. */
  load: number;
  weightShift: number;
}

const STROKES: Record<StrokeKind, StrokeDef> = {
  forehand: {
    back: [-0.6, 1.05, -0.32], backDir: [-0.3, 0.78, -0.55], backYaw: -1.2,
    via: [-0.76, 0.7, -0.04],
    contactDir: [-0.92, -0.08, 0.38], contactYaw: -0.2,
    follow: [0.3, 1.52, 0.26], followDir: [0.62, 0.72, -0.22], followYaw: 0.85, followPitch: 0.16,
    backFrac: 0.5, overhead: false,
    stanceL: [-0.1, 0.3], stanceR: [-0.08, -0.2],
    leftBack: [-0.12, 1.22, 0.5], leftSwing: [0.3, 1.12, 0.14],
    load: 0.11, weightShift: 0.09,
  },
  backhand: {
    back: [0.42, 1.16, -0.16], backDir: [0.5, 0.8, -0.35], backYaw: 1.3,
    via: [0.54, 0.9, 0.1],
    contactDir: [0.9, -0.05, 0.42], contactYaw: 0.55,
    follow: [-0.64, 1.3, 0.34], followDir: [-0.75, 0.6, 0.25], followYaw: -0.1, followPitch: 0.1,
    backFrac: 0.5, overhead: false,
    stanceL: [0.1, -0.2], stanceR: [0.12, 0.32],
    leftBack: null, leftSwing: [0.46, 1.02, -0.36],
    load: 0.1, weightShift: 0.09,
  },
  volley_fh: {
    back: [-0.5, 1.3, 0.02], backDir: [-0.5, 0.85, -0.1], backYaw: -0.6,
    via: [-0.55, 1.22, 0.15],
    contactDir: [-0.85, 0.38, 0.35], contactYaw: -0.15,
    follow: [-0.25, 1.02, 0.55], followDir: [-0.6, 0.5, 0.6], followYaw: 0.12, followPitch: 0.12,
    backFrac: 0.45, overhead: false,
    stanceL: [-0.06, 0.34], stanceR: [0, -0.06],
    leftBack: [0.28, 1.18, 0.34], leftSwing: [0.34, 1.1, 0.1],
    load: 0.07, weightShift: 0.1,
  },
  volley_bh: {
    back: [0.3, 1.32, 0.04], backDir: [0.55, 0.8, -0.1], backYaw: 0.8,
    via: [0.36, 1.24, 0.16],
    contactDir: [0.85, 0.38, 0.35], contactYaw: 0.42,
    follow: [0.02, 1.02, 0.56], followDir: [0.3, 0.5, 0.8], followYaw: 0.1, followPitch: 0.12,
    backFrac: 0.45, overhead: false,
    stanceL: [0, -0.06], stanceR: [0.08, 0.34],
    leftBack: null, leftSwing: [0.42, 1.05, -0.22],
    load: 0.07, weightShift: 0.1,
  },
  smash: {
    back: [-0.3, 1.72, -0.32], backDir: [0.1, 0.35, -0.93], backYaw: -1.0,
    via: [-0.3, 2.04, -0.14],
    contactDir: [-0.1, 0.93, 0.35], contactYaw: -0.05,
    follow: [0.32, 0.86, 0.45], followDir: [0.4, -0.6, 0.68], followYaw: 0.9, followPitch: 0.6,
    backFrac: 0.55, overhead: true,
    stanceL: [-0.06, 0.26], stanceR: [-0.06, -0.26],
    leftBack: [0.2, 1.98, 0.28], leftSwing: [0.16, 1.12, 0.2],
    load: 0.1, weightShift: 0.12,
  },
  bandeja: {
    back: [-0.5, 1.68, -0.28], backDir: [-0.3, 0.6, -0.74], backYaw: -1.3,
    via: [-0.56, 1.86, -0.1],
    contactDir: [-0.55, 0.76, 0.34], contactYaw: -0.65,
    follow: [0.15, 1.22, 0.46], followDir: [0.4, 0.3, 0.86], followYaw: 0.2, followPitch: 0.2,
    backFrac: 0.55, overhead: true,
    stanceL: [-0.06, 0.28], stanceR: [-0.06, -0.26],
    leftBack: [0.18, 1.9, 0.3], leftSwing: [0.2, 1.15, 0.2],
    load: 0.08, weightShift: 0.08,
  },
  serve: {
    back: [-0.5, 0.78, -0.42], backDir: [-0.3, -0.5, -0.8], backYaw: -0.85,
    via: [-0.56, 0.56, -0.12],
    contactDir: [-0.8, -0.45, 0.4], contactYaw: -0.2,
    follow: [0.1, 1.36, 0.45], followDir: [0.3, 0.8, 0.5], followYaw: 0.55, followPitch: 0.1,
    backFrac: 0.6, overhead: false,
    stanceL: [-0.04, 0.24], stanceR: [0, -0.14],
    leftBack: [-0.33, 0.95, 0.36], leftSwing: [0.3, 1.1, 0.16],
    load: 0.06, weightShift: 0.07,
  },
};

const READY_HAND = new THREE.Vector3(-0.13, 1.0, 0.33);
const READY_DIR = new THREE.Vector3(0.42, 0.8, 0.42).normalize();

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Analytic two-bone IK: writes the middle joint and the (possibly clamped) end joint. */
export function solveLimb(
  root: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
  pole: THREE.Vector3,
  outMid: THREE.Vector3,
  outEnd: THREE.Vector3,
): void {
  _d.subVectors(target, root);
  let dist = _d.length();
  if (dist < 1e-5) {
    _d.set(0, -1, 0);
    dist = 1e-5;
  }
  _d.divideScalar(dist);
  const reach = Math.max(Math.abs(l1 - l2) + 0.01, Math.min(l1 + l2 - 0.004, dist));
  const cosA = clamp01((l1 * l1 + reach * reach - l2 * l2) / (2 * l1 * reach) * 0.5 + 0.5) * 2 - 1;
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d));
  if (_p.lengthSq() < 1e-6) _p.set(_d.y, -_d.x, 0);
  _p.normalize();
  outMid.copy(root).addScaledVector(_d, l1 * cosA).addScaledVector(_p, l1 * sinA);
  outEnd.copy(root).addScaledVector(_d, reach);
}

interface Foot {
  /** Planted position in world space (the ball of the foot). */
  x: number;
  z: number;
  stepping: boolean;
  t: number;
  dur: number;
  fromX: number;
  fromZ: number;
  lift: number;
  /** Current height above the ground. */
  y: number;
  /** Foot pitch: positive = heel up, toes down. */
  pitch: number;
  /** 0..1: how far behind the hips the planted foot trails (drives the heel lift). */
  trail: number;
}

/**
 * Drives one character. Call `update` once per rendered frame, then read `pose`,
 * `worldX/worldZ` and `yaw`.
 *
 * What it models, from the ground up:
 * - footwork: planted steps that never slide, a stride that lengthens into a run with a flight
 *   phase, heel-to-toe roll, hips that turn towards the direction of travel while the chest
 *   keeps facing the ball, and a split step when the opponents strike;
 * - the stroke as a kinetic chain: early preparation as the ball approaches, a step into the
 *   shot, loading and extending the legs, hips opening before the shoulders, the racket head
 *   lagging behind the hand, weight moving onto the front foot, a full follow-through;
 * - small things that make a body look alive: breathing, bouncing on the toes, head on the ball.
 */
export class Animator {
  readonly pose = new Pose();
  /** Body measurements; replaced when a model with its own skeleton is attached. */
  prop: Proportions;
  worldX = 0;
  worldZ = 0;
  /** Facing angle: 0 looks along +z. */
  yaw = 0;
  private feet: [Foot, Foot];
  private initialised = false;
  private time = 0;
  private crouch = 0;
  private leanX = 0;
  private leanZ = 0;
  private hipTurn = 0;
  private hipY = 0;
  private pelvisRoll = 0;
  private prepW = 0;
  private lastKind: StrokeKind = 'forehand';
  private moodT = 0;
  private lastMood: Mood = 'play';
  private headYaw = 0;
  private headPitch = 0;
  private hopY = 0;
  private pvx = 0;
  private pvz = 0;
  private accX = 0;
  private accZ = 0;
  private stanceW = 0;
  private stance: [[number, number], [number, number]] = [
    [0, 0],
    [0, 0],
  ];
  private halfStance = 0.2;

  // Scratch vectors.
  private handR = new THREE.Vector3();
  private handL = new THREE.Vector3();
  private rDir = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private tmp3 = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();

  constructor(prop: Proportions = DEFAULT_PROPORTIONS) {
    this.prop = prop;
    const mk = (): Foot => ({ x: 0, z: 0, stepping: false, t: 0, dur: 0.2, fromX: 0, fromZ: 0, lift: 0, y: 0, pitch: 0, trail: 0 });
    this.feet = [mk(), mk()];
  }

  /** World → local (x, z) for the current root transform. */
  private toLocal(wx: number, wz: number, out: THREE.Vector3): THREE.Vector3 {
    const dx = wx - this.worldX;
    const dz = wz - this.worldZ;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return out.set(dx * c - dz * s, 0, dx * s + dz * c);
  }

  /** World position where foot `i` wants to be, `ahead` seconds along the current velocity. */
  private homeFoot(i: number, vx: number, vz: number, ahead: number, out: { x: number; z: number }): void {
    const side = i === 0 ? 1 : -1; // left foot at +x
    // Neutral stance turned with the pelvis, plus the stance the current shot calls for.
    const ch = Math.cos(this.hipTurn);
    const sh = Math.sin(this.hipTurn);
    const bx = side * this.halfStance;
    const lx = bx * ch + this.stance[i][0] * this.stanceW;
    const lz = -bx * sh + this.stance[i][1] * this.stanceW;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    out.x = this.worldX + lx * c + lz * s + vx * ahead;
    out.z = this.worldZ - lx * s + lz * c + vz * ahead;
  }

  update(dt: number, player: Player, now: number, ball: { x: number; y: number; z: number }, ballLive: boolean): void {
    const P = this.prop;
    const pose = this.pose;
    const vx = player.vx;
    const vz = player.vz;
    const speed = Math.hypot(vx, vz);
    this.worldX = player.x;
    this.worldZ = player.z;
    this.time += dt;
    const playing = player.mood === 'play';

    // --- Facing: towards the net, turning partly towards the ball ----------------------------
    const netYaw = player.dir > 0 ? 0 : Math.PI;
    let targetYaw = netYaw;
    if (ballLive && playing) {
      const toBall = Math.atan2(ball.x - player.x, ball.z - player.z);
      const rel = Math.max(-0.9, Math.min(0.9, wrapAngle(toBall - netYaw)));
      targetYaw = netYaw + rel * 0.6;
    }
    if (!this.initialised) this.yaw = targetYaw;
    this.yaw += wrapAngle(targetYaw - this.yaw) * damp(7, dt);

    // Velocity and acceleration in the body frame.
    const local = this.toLocal(this.worldX + vx, this.worldZ + vz, this.tmp);
    const lvx = local.x;
    const lvz = local.z;
    if (dt > 1e-5) {
      const k = damp(10, dt);
      this.accX += ((vx - this.pvx) / dt - this.accX) * k;
      this.accZ += ((vz - this.pvz) / dt - this.accZ) * k;
    }
    this.pvx = vx;
    this.pvz = vz;
    const runW = smooth(clamp01((speed - 1.2) / 2.6));

    // Pelvis turns towards the direction of travel (sideways and diagonal runs), up to ~50°.
    const travel = speed > 0.5 ? Math.atan2(lvx, Math.abs(lvz) + 0.25) : 0;
    this.hipTurn += (Math.max(-0.9, Math.min(0.9, travel * 0.62 * runW)) - this.hipTurn) * damp(8, dt);

    // --- Mood timing -------------------------------------------------------------------------
    if (player.mood !== this.lastMood) {
      this.lastMood = player.mood;
      this.moodT = 0;
    }
    this.moodT += dt;
    const celebrating = player.mood === 'celebrate';
    const dejected = player.mood === 'dejected';
    const moodW = playing ? 0 : smooth(clamp01(this.moodT / 0.35));

    // --- Stroke and preparation phase ----------------------------------------------------------
    const swing: Swing | null = player.swing;
    const prep = !swing && playing && player.prep && player.prep.t - now < 0.85 && player.prep.t - now > -0.05 ? player.prep : null;
    if (swing) {
      // A swing that follows a different preparation starts from the ready position.
      if (swing.stroke !== this.lastKind && !(swing.stroke === 'smash' && this.lastKind === 'bandeja')) this.prepW = 0;
      if (now >= swing.contactT) this.prepW = 0;
      this.lastKind = swing.stroke;
    } else if (prep) {
      if (prep.stroke !== this.lastKind) {
        // Changing sides: relax first, then take the racket back the other way.
        this.prepW += (0 - this.prepW) * damp(14, dt);
        if (this.prepW < 0.08) this.lastKind = prep.stroke;
      } else {
        this.prepW += (1 - this.prepW) * damp(7, dt);
      }
    } else {
      this.prepW += (0 - this.prepW) * damp(5, dt);
    }
    const active = swing !== null || this.prepW > 0.01;
    const def: StrokeDef | null = active ? STROKES[swing ? swing.stroke : this.lastKind] : null;
    let u = 0; // 0..1 wind-up to contact
    let v = 0; // 0..1 contact to recovery
    let W = this.prepW * 0.9; // how much of the stroke pose is applied
    let back = 1; // 0..1 take-back
    let fwd = 0; // 0..1 forward swing (take-back position → contact)
    let afterContact = false;
    if (swing && def) {
      if (now < swing.contactT) {
        u = clamp01((now - swing.startT) / Math.max(0.05, swing.contactT - swing.startT));
        W = Math.max(smooth(clamp01(u / 0.25)), this.prepW * 0.9);
        back = Math.max(smooth(clamp01(u / def.backFrac)), this.prepW);
        fwd = clamp01((u - def.backFrac) / (1 - def.backFrac));
      } else {
        afterContact = true;
        u = 1;
        fwd = 1;
        v = clamp01((now - swing.contactT) / Math.max(0.05, swing.endT - swing.contactT));
        W = 1 - smooth(clamp01((v - 0.6) / 0.4));
      }
    }
    // Kinetic chain: the hips open first, then the shoulders, then the arm, then the racket head.
    const hipF = smooth(clamp01(fwd * 1.5));
    const chestF = smooth(clamp01((fwd - 0.12) / 0.78));
    const armF = fwd * fwd * (0.6 + 0.4 * (3 - 2 * fwd));
    const racketF = Math.pow(armF, 1.5);
    const followF = afterContact ? smooth(clamp01(v / 0.55)) : 0;

    // Feet take the stance of the shot unless the player is busy running.
    const stanceTarget = def ? W * (1 - smooth(clamp01((speed - 1.2) / 2.5))) : 0;
    this.stanceW += (stanceTarget - this.stanceW) * damp(12, dt);
    if (def) {
      this.stance[0] = def.stanceL;
      this.stance[1] = def.stanceR;
    }

    // --- Split step: a small hop as the opponents strike, landing wide and low ------------------
    let splitHop = 0;
    let splitCrouch = 0;
    let splitWide = 0;
    const sp = now - player.splitT;
    if (sp >= 0 && sp < 0.45 && speed < 3 && playing && !swing) {
      if (sp < 0.2) splitHop = Math.sin((Math.PI * sp) / 0.2) * 0.045;
      else splitCrouch = (1 - (sp - 0.2) / 0.25) * 0.07;
      splitWide = 0.07 * (1 - sp / 0.45);
    }
    this.halfStance = 0.2 - 0.09 * runW + splitWide;

    // --- Feet --------------------------------------------------------------------------------
    const home = { x: 0, z: 0 };
    if (!this.initialised) {
      for (let i = 0; i < 2; i++) {
        this.homeFoot(i, 0, 0, 0, home);
        this.feet[i].x = home.x;
        this.feet[i].z = home.z;
      }
      this.hipY = P.hipHeight;
      this.initialised = true;
    }
    // Short quick steps when adjusting, long strides when running.
    const stepDur = speed < 1 ? 0.2 : Math.max(0.24, 0.34 - 0.014 * speed);
    const threshold = 0.1 + Math.min(0.42, speed * 0.075);
    let worst = -1;
    let worstErr = threshold;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const other = this.feet[1 - i];
      if (f.stepping) continue;
      this.homeFoot(i, vx, vz, 0.03, home);
      const err = Math.hypot(f.x - home.x, f.z - home.z);
      f.trail = clamp01((err - 0.35 * threshold) / (0.65 * threshold)) * runW;
      // At a run both feet are off the ground for a moment; when slow, one stays planted.
      const otherOk = !other.stepping || (speed > 3 && other.t > 0.5);
      if (otherOk && err > worstErr) {
        worstErr = err;
        worst = i;
      }
    }
    if (worst >= 0) {
      const f = this.feet[worst];
      f.stepping = true;
      f.t = 0;
      f.dur = stepDur;
      f.fromX = f.x;
      f.fromZ = f.z;
      f.lift = 0.045 + Math.min(0.3, speed * 0.045);
    }
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      if (!f.stepping) {
        f.y = 0;
        // Heel peels off the ground as the foot trails behind, ready to push off.
        f.pitch += (0.7 * f.trail - f.pitch) * damp(18, dt);
        continue;
      }
      f.t += dt / f.dur;
      const t = Math.min(1, f.t);
      // Land ahead of the hips so the foot is under the body mid-stance.
      this.homeFoot(i, vx, vz, f.dur * (1 - t) + stepDur * 0.3, home);
      const k = smooth(t);
      f.x = f.fromX + (home.x - f.fromX) * k;
      f.z = f.fromZ + (home.z - f.fromZ) * k;
      // The heel kicks up early in the swing and the foot comes through low before landing.
      f.y = Math.sin(Math.PI * Math.pow(t, 0.8)) * f.lift;
      const want = t < 0.45 ? 0.95 : 0.95 - ((t - 0.45) / 0.55) * 1.25; // toe down, then toe up to land on the heel
      f.pitch += (want * runW - f.pitch) * damp(22, dt);
      if (f.t >= 1) {
        f.stepping = false;
        f.y = 0;
      }
    }

    // --- Body: lean, crouch, weight -----------------------------------------------------------
    // Lean into acceleration (starting, stopping, changing direction) and a little into speed.
    this.toLocal(this.worldX + this.accX, this.worldZ + this.accZ, this.tmp);
    const lax = Math.max(-25, Math.min(25, this.tmp.x));
    const laz = Math.max(-25, Math.min(25, this.tmp.z));
    this.leanX += (lvx * 0.01 + lax * 0.0035 - this.leanX) * damp(7, dt);
    this.leanZ += (lvz * 0.012 + laz * 0.0035 - this.leanZ) * damp(7, dt);

    let strokeCrouch = 0;
    let weight = 0; // hips forward (+) or back (-) over the feet
    if (def) {
      if (!afterContact) {
        const load = def.load * back * (1 - 0.75 * hipF); // bend, then drive up through the ball
        strokeCrouch = load * W;
        weight = (-0.6 * back * (1 - hipF) + hipF) * def.weightShift * W;
      } else {
        strokeCrouch = def.load * 0.35 * W;
        weight = def.weightShift * (1 - 0.6 * followF) * W;
      }
    }
    const liveBounce = ballLive && playing && speed < 1.2 && !swing ? Math.abs(Math.sin(this.time * 5.2)) * 0.012 : 0;
    const crouchTarget = (playing ? 0.055 : 0) + strokeCrouch + Math.min(0.05, speed * 0.008) + splitCrouch - liveBounce;
    this.crouch += (crouchTarget - this.crouch) * damp(14, dt);

    // Jump for high overheads, hop when celebrating.
    let jump = 0;
    if (def?.overhead && swing) {
      const need = Math.max(0, swing.contact.y - 2.45);
      const tJump = now < swing.contactT ? smooth(clamp01((u - 0.55) / 0.45)) : 1 - smooth(clamp01(v / 0.5));
      jump = Math.min(0.4, need) * tJump;
    }
    const hopTarget = celebrating ? Math.abs(Math.sin(this.moodT * 7)) * 0.07 * clamp01(2 - this.moodT * 0.6) : 0;
    this.hopY += (hopTarget - this.hopY) * damp(20, dt);
    const lift = jump + this.hopY + splitHop;

    // Feet in local space: ankle above the planted ball of the foot, toes ahead.
    const footYaw = this.hipTurn;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const side = i === 0 ? 1 : -1;
      const fy = footYaw + side * 0.14;
      const fx = Math.sin(fy);
      const fz = Math.cos(fy);
      const a = this.toLocal(f.x, f.z, pose.ankle[i]);
      const heel = Math.max(0, f.pitch);
      // On the toes the ankle rises and moves forward over the ball of the foot.
      a.x += fx * heel * 0.05;
      a.z += fz * heel * 0.05;
      a.y = P.ankleHeight + f.y + heel * 0.085 + lift;
      const cp = Math.cos(f.pitch);
      pose.toe[i].set(
        a.x + fx * P.footLength * cp,
        Math.max(0.015 + f.y * 0.4 + lift, a.y - P.ankleHeight + 0.02 - Math.sin(f.pitch) * P.footLength),
        a.z + fz * P.footLength * cp,
      );
    }

    // Hip height: low enough for the planted leg to reach its foot, rising between strides.
    const hx = this.leanX;
    const hz = this.leanZ + weight;
    let hipTarget = P.hipHeight - this.crouch + lift;
    const legLen = P.thigh + P.shin;
    for (let i = 0; i < 2; i++) {
      if (this.feet[i].stepping) continue;
      const a = pose.ankle[i];
      const side = i === 0 ? 1 : -1;
      const horiz = Math.hypot(a.x - side * P.hipHalfWidth - hx, a.z - hz);
      const maxY = a.y + Math.sqrt(Math.max(0.05, legLen * legLen * 0.985 - horiz * horiz));
      if (maxY < hipTarget) hipTarget = Math.max(maxY, P.hipHeight - 0.3);
    }
    const stepT = this.feet[0].stepping ? this.feet[0].t : this.feet[1].stepping ? this.feet[1].t : 0;
    hipTarget += Math.sin(Math.PI * stepT) * (0.012 + 0.03 * runW);
    this.hipY += (hipTarget - this.hipY) * damp(lift > 0.01 ? 60 : 22, dt);
    // Weight sways over the supporting foot at a walk; idle players shift their weight slowly.
    const sway = this.feet[0].stepping ? -0.02 : this.feet[1].stepping ? 0.02 : Math.sin(this.time * 0.8) * 0.012 * (1 - runW);
    pose.hips.set(hx + sway * (1 - runW * 0.6), this.hipY, hz);

    // --- Torso orientation -------------------------------------------------------------------
    // Pelvis: follows the stride (the forward leg's hip leads) and drops on the swinging side.
    const stride = pose.ankle[0].z - pose.ankle[1].z;
    const strideYaw = -Math.max(-0.2, Math.min(0.2, stride * 0.3)) * runW;
    const rollTarget = (this.feet[0].stepping ? -0.06 : this.feet[1].stepping ? 0.06 : 0) * (0.4 + 0.6 * runW);
    this.pelvisRoll += (rollTarget - this.pelvisRoll) * damp(12, dt);

    const breath = Math.sin(this.time * 1.7);
    let chestYaw = 0;
    let hipsYaw = 0;
    let chestPitch = 0.14 + Math.min(0.2, Math.max(-0.08, lvz * 0.028 + laz * 0.004)) + breath * 0.01;
    const chestRoll = -lvx * 0.02 - lax * 0.004;
    if (def) {
      if (!afterContact) {
        chestYaw = def.backYaw * back + (def.contactYaw - def.backYaw) * chestF;
        hipsYaw = def.backYaw * 0.5 * back + (def.contactYaw * 0.9 - def.backYaw * 0.5) * hipF;
        if (def.overhead) chestPitch -= 0.24 * W * back * (1 - chestF); // arch back under the ball
      } else {
        chestYaw = def.contactYaw + (def.followYaw - def.contactYaw) * followF;
        hipsYaw = def.contactYaw * 0.9 + (def.followYaw * 0.6 - def.contactYaw * 0.9) * followF;
        chestPitch += def.followPitch * followF * W;
      }
      chestYaw *= W;
      hipsYaw *= W;
    }
    if (dejected) chestPitch += 0.22 * moodW;
    if (celebrating) chestPitch -= 0.12 * moodW;

    const pelvisYaw = this.hipTurn + strideYaw + hipsYaw;
    const chestYawTotal = this.hipTurn * 0.3 - strideYaw * 0.8 + chestYaw;
    this.e.set(chestPitch * 0.35, pelvisYaw, this.pelvisRoll + chestRoll * 0.4, 'YXZ');
    pose.hipsQuat.setFromEuler(this.e);
    this.e.set(chestPitch, chestYawTotal, chestRoll - this.pelvisRoll * 0.5, 'YXZ');
    pose.chestQuat.setFromEuler(this.e);

    // Spine from the hips to the shoulder line, bending with the chest.
    this.tmp.set(0, P.spine + breath * 0.003, 0).applyQuaternion(this.q.copy(pose.hipsQuat).slerp(pose.chestQuat, 0.6));
    pose.chest.copy(pose.hips).add(this.tmp);
    pose.neck.copy(pose.chest).add(this.tmp.set(0, P.neck, 0.01).applyQuaternion(pose.chestQuat));

    // Head stays on the ball.
    let hy = 0;
    let hp = 0;
    if (ballLive && playing) {
      this.toLocal(ball.x, ball.z, this.tmp2);
      this.tmp2.y = ball.y - (pose.neck.y + 0.1);
      hy = Math.atan2(this.tmp2.x, Math.max(0.2, this.tmp2.z)) - chestYawTotal;
      hp = -Math.atan2(this.tmp2.y, Math.hypot(this.tmp2.x, this.tmp2.z));
    }
    if (dejected) hp = 0.45;
    if (celebrating) hp = -0.25;
    this.headYaw += (Math.max(-1.2, Math.min(1.2, hy)) - this.headYaw) * damp(10, dt);
    this.headPitch += (Math.max(-0.7, Math.min(0.6, hp)) - this.headPitch) * damp(10, dt);
    this.e.set(this.headPitch - chestPitch * 0.6, this.headYaw, 0, 'YXZ');
    pose.headQuat.copy(pose.chestQuat).multiply(this.q.setFromEuler(this.e));
    pose.head.copy(pose.neck).add(this.tmp.set(0, P.headRadius * 1.05, 0.015).applyQuaternion(pose.headQuat));

    // Shoulders and hip joints.
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      pose.shoulder[i].copy(pose.chest).add(this.tmp.set(side * P.shoulderHalfWidth, -0.02, 0).applyQuaternion(pose.chestQuat));
      pose.hip[i].copy(pose.hips).add(this.tmp.set(side * P.hipHalfWidth, -0.03, 0).applyQuaternion(pose.hipsQuat));
    }

    // --- Hands -------------------------------------------------------------------------------
    const handR = this.handR;
    const handL = this.handL;
    const rDir = this.rDir;
    const drop = P.hipHeight - this.hipY; // hands come down with the body
    handR.copy(READY_HAND);
    handR.y -= drop * 0.7;
    rDir.copy(READY_DIR);
    let leftFree = 0; // 0: left hand on the racket throat, 1: left hand at its own target
    const leftTarget = this.tmp3.set(0.3, 1.02, 0.22);

    // Running: arms pump opposite to the legs, racket carried upright.
    const pump = Math.max(-1, Math.min(1, stride / 0.6));
    const pumpW = runW * (1 - W) * (playing ? 1 : 0);
    if (pumpW > 0.001) {
      const base = this.hipY + 0.2;
      handR.lerp(_p.set(-0.25, base + 0.07 * pump, 0.14 + 0.2 * pump), pumpW * 0.85);
      rDir.lerp(_d.set(0.12, 0.8, 0.58), pumpW * 0.85).normalize();
      leftTarget.set(0.25, base - 0.07 * pump, 0.14 - 0.2 * pump);
      leftFree = pumpW;
    }

    if (def) {
      const sHand = _p;
      const sDir = _d;
      const cDir = this.tmp.set(def.contactDir[0], def.contactDir[1], def.contactDir[2]).normalize();
      const contactHand = this.tmp2;
      if (swing) {
        // Contact hand position: back off from the ball along the racket.
        this.toLocal(swing.contact.x, swing.contact.z, contactHand);
        contactHand.y = swing.contact.y - jump;
        contactHand.addScaledVector(cDir, -RACKET_REACH);
        // Keep it within reach of the shoulder; the body leans the rest of the way.
        const sh = pose.shoulder[1];
        const armMax = P.upperArm + P.foreArm - 0.02;
        const off = sDir.subVectors(contactHand, sh);
        const dist = off.length();
        if (dist > armMax) {
          const extra = Math.min(0.45, dist - armMax);
          off.normalize();
          pose.hips.addScaledVector(sHand.set(off.x, 0, off.z), extra * 0.6 * W * armF);
          contactHand.copy(sh).addScaledVector(off, armMax);
        }
      } else {
        contactHand.set(def.back[0], def.back[1], def.back[2]);
      }

      if (!afterContact) {
        // Ready → take-back, then a curved path through `via` to the contact point.
        const bx = READY_HAND.x + (def.back[0] - READY_HAND.x) * back;
        const by = READY_HAND.y + (def.back[1] - READY_HAND.y) * back - drop * 0.5;
        const bz = READY_HAND.z + (def.back[2] - READY_HAND.z) * back;
        const a0 = (1 - armF) * (1 - armF);
        const a1 = 2 * armF * (1 - armF);
        const a2 = armF * armF;
        sHand.set(
          a0 * bx + a1 * def.via[0] + a2 * contactHand.x,
          a0 * by + a1 * (def.via[1] - drop * 0.5) + a2 * contactHand.y,
          a0 * bz + a1 * def.via[2] + a2 * contactHand.z,
        );
        // The racket head lags behind the hand, then whips through at contact.
        sDir.set(
          READY_DIR.x + (def.backDir[0] - READY_DIR.x) * back,
          READY_DIR.y + (def.backDir[1] - READY_DIR.y) * back,
          READY_DIR.z + (def.backDir[2] - READY_DIR.z) * back,
        );
        sDir.lerp(cDir, racketF).normalize();
      } else {
        sHand.set(
          contactHand.x + (def.follow[0] - contactHand.x) * followF,
          contactHand.y + (def.follow[1] - contactHand.y) * followF,
          contactHand.z + (def.follow[2] - contactHand.z) * followF,
        );
        // Swing through the ball before wrapping up.
        sHand.z += Math.sin(Math.PI * followF) * 0.2;
        sDir.set(def.followDir[0], def.followDir[1], def.followDir[2]).normalize();
        sDir.lerpVectors(cDir, sDir, followF).normalize();
      }
      handR.lerp(sHand, W);
      rDir.lerp(sDir, W).normalize();

      // Left arm: points at the ball or steadies the racket in preparation, then balances.
      const serveHold = swing?.stroke === 'serve' && u >= 0.35;
      if (!afterContact && fwd < 0.25 && !serveHold) {
        if (def.leftBack) {
          leftTarget.set(def.leftBack[0], def.leftBack[1] - drop * 0.5, def.leftBack[2]);
          leftFree = Math.max(leftFree, W);
        } else {
          leftFree = leftFree * (1 - W); // stays on the racket throat
        }
      } else {
        const k = afterContact ? 1 : smooth(clamp01((fwd - 0.25) / 0.4));
        leftTarget.set(def.leftSwing[0], def.leftSwing[1] - drop * 0.5, def.leftSwing[2]);
        leftFree = Math.max(leftFree, W * (def.leftBack ? 1 : k));
      }
    }
    if (player.holdingBall && !swing) {
      // Ball held out in the palm, ready to be dropped for the serve.
      leftTarget.set(-0.33, 0.95, 0.36);
      leftFree = 1;
    }
    if (celebrating) {
      const fist = Math.sin(this.moodT * 9) * 0.08 * clamp01(2.2 - this.moodT * 0.7);
      handR.lerp(_p.set(-0.3, 1.92 + fist, 0.12), moodW);
      rDir.lerp(_d.set(-0.15, 0.97, 0.1), moodW).normalize();
      leftTarget.set(0.3, 1.32 + fist * 0.5, 0.26);
      leftFree = Math.max(leftFree, moodW);
    } else if (dejected) {
      handR.lerp(_p.set(-0.3, 0.74, 0.06), moodW);
      rDir.lerp(_d.set(0.05, -0.92, 0.38), moodW).normalize();
      leftTarget.set(0.27, 0.96, 0.04);
      leftFree = Math.max(leftFree, moodW);
    }

    // Left hand: on the racket throat in the ready position, otherwise at its own target.
    handL.copy(handR).addScaledVector(rDir, 0.21);
    handL.lerp(leftTarget, clamp01(leftFree));

    // Hands are defined relative to a centred torso: follow the hips' drift.
    handR.x += pose.hips.x * 0.6;
    handR.z += pose.hips.z * 0.6;
    handL.x += pose.hips.x * 0.6;
    handL.z += pose.hips.z * 0.6;

    // --- Limbs -------------------------------------------------------------------------------
    solveLimb(pose.shoulder[1], handR, P.upperArm, P.foreArm, this.tmp.set(-0.55, -0.75, -0.35), pose.elbow[1], pose.wrist[1]);
    solveLimb(pose.shoulder[0], handL, P.upperArm, P.foreArm, this.tmp.set(0.55, -0.75, -0.35), pose.elbow[0], pose.wrist[0]);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      // Knees point where the feet point.
      const fy = footYaw + side * 0.14;
      this.tmp.set(Math.sin(fy), 0, Math.cos(fy));
      const toeDx = pose.toe[i].x - pose.ankle[i].x;
      const toeDy = pose.toe[i].y - pose.ankle[i].y;
      const toeDz = pose.toe[i].z - pose.ankle[i].z;
      solveLimb(pose.hip[i], pose.ankle[i], P.thigh, P.shin, this.tmp, pose.knee[i], this.tmp2);
      // If the leg could not reach, the foot comes with it: keep the toe attached to the ankle.
      pose.ankle[i].copy(this.tmp2);
      pose.toe[i].set(pose.ankle[i].x + toeDx, pose.ankle[i].y + toeDy, pose.ankle[i].z + toeDz);
    }

    pose.racketDir.copy(rDir);
    // Racket face: perpendicular to the handle, facing forward as much as possible.
    this.tmp.set(0, 0, 1);
    if (def?.overhead && swing && now >= swing.contactT - 0.12) this.tmp.set(0, -0.3, 1);
    pose.racketNormal.copy(this.tmp).addScaledVector(rDir, -this.tmp.dot(rDir));
    if (pose.racketNormal.lengthSq() < 1e-4) pose.racketNormal.set(1, 0, 0);
    pose.racketNormal.normalize();
  }
}
