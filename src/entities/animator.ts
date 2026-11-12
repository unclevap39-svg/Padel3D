/**
 * Procedural character animation. No CC0 padel motion capture exists, so every movement is
 * generated: footsteps are planted in world space (a planted foot never slides), limbs are
 * solved with two-bone IK, and strokes are hand paths timed so the racket meets the ball at the
 * real contact point.
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

interface StrokeDef {
  back: [number, number, number];
  backDir: [number, number, number];
  backYaw: number;
  via: [number, number, number];
  contactDir: [number, number, number];
  contactYaw: number;
  follow: [number, number, number];
  followDir: [number, number, number];
  followYaw: number;
  /** Forward lean of the chest at the end of the swing. */
  followPitch: number;
  /** Fraction of the wind-up spent taking the racket back. */
  backFrac: number;
  overhead: boolean;
}

const STROKES: Record<StrokeKind, StrokeDef> = {
  forehand: {
    back: [-0.6, 1.02, -0.3], backDir: [-0.3, 0.75, -0.6], backYaw: -1.1,
    via: [-0.74, 0.72, -0.02],
    contactDir: [-0.92, -0.08, 0.38], contactYaw: -0.25,
    follow: [0.28, 1.5, 0.28], followDir: [0.6, 0.72, -0.2], followYaw: 0.75, followPitch: 0.15,
    backFrac: 0.5, overhead: false,
  },
  backhand: {
    back: [0.42, 1.18, -0.14], backDir: [0.5, 0.8, -0.35], backYaw: 1.25,
    via: [0.52, 0.92, 0.1],
    contactDir: [0.9, -0.05, 0.42], contactYaw: 0.5,
    follow: [-0.62, 1.28, 0.34], followDir: [-0.75, 0.6, 0.25], followYaw: -0.15, followPitch: 0.1,
    backFrac: 0.5, overhead: false,
  },
  volley_fh: {
    back: [-0.5, 1.28, 0.02], backDir: [-0.5, 0.85, -0.1], backYaw: -0.55,
    via: [-0.55, 1.2, 0.15],
    contactDir: [-0.85, 0.38, 0.35], contactYaw: -0.15,
    follow: [-0.25, 1.02, 0.55], followDir: [-0.6, 0.5, 0.6], followYaw: 0.12, followPitch: 0.12,
    backFrac: 0.45, overhead: false,
  },
  volley_bh: {
    back: [0.3, 1.3, 0.04], backDir: [0.55, 0.8, -0.1], backYaw: 0.75,
    via: [0.36, 1.22, 0.16],
    contactDir: [0.85, 0.38, 0.35], contactYaw: 0.4,
    follow: [0.02, 1.02, 0.56], followDir: [0.3, 0.5, 0.8], followYaw: 0.1, followPitch: 0.12,
    backFrac: 0.45, overhead: false,
  },
  smash: {
    back: [-0.3, 1.72, -0.3], backDir: [0.1, 0.35, -0.93], backYaw: -0.95,
    via: [-0.3, 2.02, -0.14],
    contactDir: [-0.1, 0.93, 0.35], contactYaw: -0.1,
    follow: [0.3, 0.88, 0.45], followDir: [0.4, -0.6, 0.68], followYaw: 0.85, followPitch: 0.55,
    backFrac: 0.55, overhead: true,
  },
  bandeja: {
    back: [-0.5, 1.68, -0.26], backDir: [-0.3, 0.6, -0.74], backYaw: -1.25,
    via: [-0.56, 1.86, -0.1],
    contactDir: [-0.55, 0.76, 0.34], contactYaw: -0.65,
    follow: [0.15, 1.22, 0.46], followDir: [0.4, 0.3, 0.86], followYaw: 0.2, followPitch: 0.2,
    backFrac: 0.55, overhead: true,
  },
  serve: {
    back: [-0.5, 0.78, -0.42], backDir: [-0.3, -0.5, -0.8], backYaw: -0.8,
    via: [-0.56, 0.56, -0.12],
    contactDir: [-0.8, -0.45, 0.4], contactYaw: -0.2,
    follow: [0.1, 1.36, 0.45], followDir: [0.3, 0.8, 0.5], followYaw: 0.5, followPitch: 0.1,
    backFrac: 0.6, overhead: false,
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
  /** Planted position in world space. */
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
}

/**
 * Drives one character: turns towards play, plants and lifts the feet, and plays strokes and
 * moods. Call `update` once per rendered frame, then read `pose`, `worldX/worldZ` and `yaw`.
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
  private gait = 0; // accumulated step count, drives arm swing
  private crouch = 0;
  private leanX = 0;
  private leanZ = 0;
  private moodT = 0;
  private lastMood: Mood = 'play';
  private headYaw = 0;
  private headPitch = 0;
  private hopY = 0;

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
    const mk = (): Foot => ({ x: 0, z: 0, stepping: false, t: 0, dur: 0.2, fromX: 0, fromZ: 0, lift: 0, y: 0 });
    this.feet = [mk(), mk()];
  }

  /** World → local (x, z) for the current root transform. */
  private toLocal(wx: number, wz: number, out: THREE.Vector3): THREE.Vector3 {
    const dx = wx - this.worldX;
    const dz = wz - this.worldZ;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    // Rotation by -yaw about y.
    return out.set(dx * c - dz * s, 0, dx * s + dz * c);
  }

  private homeFoot(i: number, vx: number, vz: number, ahead: number, out: { x: number; z: number }): void {
    const side = i === 0 ? 1 : -1; // left foot at +x
    const halfStance = 0.2;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    out.x = this.worldX + side * halfStance * c + vx * ahead;
    out.z = this.worldZ - side * halfStance * s + vz * ahead;
  }

  update(dt: number, player: Player, now: number, ball: { x: number; y: number; z: number }, ballLive: boolean): void {
    const P = this.prop;
    const pose = this.pose;
    const vx = player.vx;
    const vz = player.vz;
    const speed = Math.hypot(vx, vz);
    this.worldX = player.x;
    this.worldZ = player.z;

    // --- Facing: towards the net, turning partly towards the ball ----------------------------
    const netYaw = player.dir > 0 ? 0 : Math.PI;
    let targetYaw = netYaw;
    if (ballLive && player.mood === 'play') {
      const toBall = Math.atan2(ball.x - player.x, ball.z - player.z);
      const rel = Math.max(-0.9, Math.min(0.9, wrapAngle(toBall - netYaw)));
      targetYaw = netYaw + rel * 0.6;
    }
    if (!this.initialised) this.yaw = targetYaw;
    this.yaw += wrapAngle(targetYaw - this.yaw) * damp(7, dt);

    // --- Feet --------------------------------------------------------------------------------
    const home = { x: 0, z: 0 };
    if (!this.initialised) {
      for (let i = 0; i < 2; i++) {
        this.homeFoot(i, 0, 0, 0, home);
        this.feet[i].x = home.x;
        this.feet[i].z = home.z;
      }
      this.initialised = true;
    }
    const stepDur = Math.max(0.15, 0.3 - 0.025 * speed);
    const threshold = 0.1 + Math.min(0.14, speed * 0.03);
    let worst = -1;
    let worstErr = threshold;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const other = this.feet[1 - i];
      if (f.stepping) continue;
      this.homeFoot(i, vx, vz, 0.05, home);
      const err = Math.hypot(f.x - home.x, f.z - home.z);
      // At a run both feet may be off the ground briefly; when slow, one stays planted.
      const otherOk = !other.stepping || (speed > 3.2 && other.t > 0.45);
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
      f.lift = 0.05 + Math.min(0.13, speed * 0.022);
      this.gait++;
    }
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      if (!f.stepping) {
        f.y = 0;
        continue;
      }
      f.t += dt / f.dur;
      const t = Math.min(1, f.t);
      // Land ahead of the hips so the foot is under the body mid-stance.
      this.homeFoot(i, vx, vz, f.dur * (1 - t) + stepDur * 0.5, home);
      const k = smooth(t);
      f.x = f.fromX + (home.x - f.fromX) * k;
      f.z = f.fromZ + (home.z - f.fromZ) * k;
      f.y = Math.sin(Math.PI * t) * f.lift;
      if (f.t >= 1) {
        f.stepping = false;
        f.y = 0;
      }
    }

    // --- Mood timing -------------------------------------------------------------------------
    if (player.mood !== this.lastMood) {
      this.lastMood = player.mood;
      this.moodT = 0;
    }
    this.moodT += dt;
    const celebrating = player.mood === 'celebrate';
    const dejected = player.mood === 'dejected';
    const moodW = player.mood === 'play' ? 0 : smooth(clamp01(this.moodT / 0.35));

    // --- Stroke phase ------------------------------------------------------------------------
    const swing: Swing | null = player.swing;
    let def: StrokeDef | null = null;
    let u = 0; // 0..1 wind-up to contact
    let v = 0; // 0..1 contact to recovery
    let strokeW = 0;
    if (swing) {
      def = STROKES[swing.stroke];
      if (now < swing.contactT) {
        u = clamp01((now - swing.startT) / Math.max(0.05, swing.contactT - swing.startT));
        strokeW = smooth(clamp01(u / 0.25));
      } else {
        u = 1;
        v = clamp01((now - swing.contactT) / Math.max(0.05, swing.endT - swing.contactT));
        strokeW = 1 - smooth(clamp01((v - 0.6) / 0.4));
      }
    }

    // --- Body: hips, lean, crouch ------------------------------------------------------------
    const local = this.tmp;
    this.toLocal(this.worldX + vx, this.worldZ + vz, local); // velocity in local frame
    const lvx = local.x;
    const lvz = local.z;
    this.leanX += (lvx * 0.012 - this.leanX) * damp(8, dt);
    this.leanZ += (lvz * 0.016 - this.leanZ) * damp(8, dt);
    const readyCrouch = player.mood === 'play' ? 0.05 : 0;
    const strokeCrouch = def && !def.overhead ? 0.06 * strokeW : 0;
    this.crouch += (readyCrouch + strokeCrouch + Math.min(0.05, speed * 0.008) - this.crouch) * damp(10, dt);

    // Feet in local space.
    const footL = this.toLocal(this.feet[0].x, this.feet[0].z, pose.ankle[0]);
    footL.y = P.ankleHeight + this.feet[0].y;
    const footR = this.toLocal(this.feet[1].x, this.feet[1].z, pose.ankle[1]);
    footR.y = P.ankleHeight + this.feet[1].y;

    // Jump for high overheads, hop when celebrating.
    let jump = 0;
    if (def?.overhead && swing) {
      const need = Math.max(0, swing.contact.y - 2.45);
      const tJump = now < swing.contactT ? smooth(clamp01((u - 0.55) / 0.45)) : 1 - smooth(clamp01(v / 0.5));
      jump = Math.min(0.4, need) * tJump;
    }
    const hopTarget = celebrating ? Math.abs(Math.sin(this.moodT * 7)) * 0.07 * clamp01(2 - this.moodT * 0.6) : 0;
    this.hopY += (hopTarget - this.hopY) * damp(20, dt);
    const lift = jump + this.hopY;
    if (lift > 0.01) {
      footL.y += lift;
      footR.y += lift;
    }

    // Hip height: low enough that both legs reach their feet.
    let hipY = P.hipHeight - this.crouch + lift;
    const legLen = P.thigh + P.shin;
    for (let i = 0; i < 2; i++) {
      const a = pose.ankle[i];
      const side = i === 0 ? 1 : -1;
      const hx = a.x - side * P.hipHalfWidth - this.leanX;
      const hz = a.z - this.leanZ;
      const horiz = Math.hypot(hx, hz);
      const maxY = a.y + Math.sqrt(Math.max(0.05, legLen * legLen * 0.985 - horiz * horiz));
      // Only the planted leg constrains the hips.
      if (!this.feet[i].stepping && maxY < hipY) hipY = Math.max(maxY, P.hipHeight - 0.3);
    }
    const bob = speed > 0.3 ? Math.sin((this.feet[0].stepping ? this.feet[0].t : this.feet[1].t) * Math.PI) * 0.018 : 0;
    pose.hips.set(this.leanX, hipY + bob, this.leanZ);

    // --- Torso orientation -------------------------------------------------------------------
    let chestYaw = 0;
    let chestPitch = 0.14 + Math.min(0.16, Math.max(-0.06, lvz * 0.03));
    let chestRoll = -lvx * 0.02;
    if (def && swing) {
      let yawS: number;
      let pitchS = 0;
      if (now < swing.contactT) {
        const b = smooth(clamp01(u / def.backFrac));
        const f = clamp01((u - def.backFrac) / (1 - def.backFrac));
        yawS = def.backYaw * b + (def.contactYaw - def.backYaw) * f * f;
      } else {
        const f = smooth(clamp01(v / 0.55));
        yawS = def.contactYaw + (def.followYaw - def.contactYaw) * f;
        pitchS = def.followPitch * f;
      }
      chestYaw = yawS * strokeW;
      chestPitch += pitchS * strokeW;
      if (def.overhead && now < swing.contactT) chestPitch -= 0.22 * strokeW * smooth(clamp01(u / 0.6));
    }
    if (dejected) chestPitch += 0.22 * moodW;
    if (celebrating) chestPitch -= 0.12 * moodW;

    this.e.set(chestPitch * 0.35, chestYaw * 0.4, chestRoll * 0.5, 'YXZ');
    pose.hipsQuat.setFromEuler(this.e);
    this.e.set(chestPitch, chestYaw, chestRoll, 'YXZ');
    pose.chestQuat.setFromEuler(this.e);

    // Spine from the hips to the shoulder line, bending with the chest.
    this.tmp.set(0, P.spine, 0).applyQuaternion(this.q.copy(pose.hipsQuat).slerp(pose.chestQuat, 0.6));
    pose.chest.copy(pose.hips).add(this.tmp);
    pose.neck.copy(pose.chest).add(this.tmp.set(0, P.neck, 0.01).applyQuaternion(pose.chestQuat));

    // Head tracks the ball.
    let hy = 0;
    let hp = 0;
    if (ballLive && player.mood === 'play') {
      this.toLocal(ball.x, ball.z, this.tmp2);
      this.tmp2.y = ball.y - (pose.neck.y + 0.1);
      hy = Math.atan2(this.tmp2.x, Math.max(0.2, this.tmp2.z)) - chestYaw;
      hp = -Math.atan2(this.tmp2.y, Math.hypot(this.tmp2.x, this.tmp2.z));
    }
    if (dejected) hp = 0.45;
    if (celebrating) hp = -0.25;
    this.headYaw += (Math.max(-1.1, Math.min(1.1, hy)) - this.headYaw) * damp(9, dt);
    this.headPitch += (Math.max(-0.7, Math.min(0.6, hp)) - this.headPitch) * damp(9, dt);
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
    // Ready position, with a little arm swing while moving.
    const swingArm = speed > 0.5 ? Math.sin(this.gait * Math.PI + (this.feet[0].stepping ? this.feet[0].t : this.feet[1].t) * Math.PI) * Math.min(0.1, speed * 0.02) : 0;
    handR.copy(READY_HAND);
    handR.z += swingArm;
    handR.y -= this.crouch * 0.6;
    rDir.copy(READY_DIR);
    let leftFree = 0; // 0: left hand on the racket throat, 1: left hand elsewhere
    const leftTarget = this.tmp3.set(0.3, 1.02 - swingArm * 0.5, 0.22 - swingArm);

    if (def && swing) {
      // Contact hand position: back off from the ball along the racket.
      this.toLocal(swing.contact.x, swing.contact.z, this.tmp2);
      this.tmp2.y = swing.contact.y - jump;
      const cDir = this.tmp.set(def.contactDir[0], def.contactDir[1], def.contactDir[2]).normalize();
      const contactHand = this.tmp2.addScaledVector(cDir, -RACKET_REACH);
      // Keep it within the arm's reach of the shoulder; the body leans the rest of the way.
      const sh = pose.shoulder[1];
      const armMax = P.upperArm + P.foreArm - 0.02;
      const off = _d.subVectors(contactHand, sh);
      const dist = off.length();
      if (dist > armMax) {
        const extra = Math.min(0.45, dist - armMax);
        off.normalize();
        // Lean the hips towards the ball (only a part of the excess), then clamp the hand.
        pose.hips.addScaledVector(_p.set(off.x, 0, off.z), extra * 0.6 * strokeW);
        contactHand.copy(sh).addScaledVector(off, armMax);
      }

      const sHand = _p;
      const sDir = _d;
      if (now < swing.contactT) {
        const b = smooth(clamp01(u / def.backFrac));
        const f = clamp01((u - def.backFrac) / (1 - def.backFrac));
        const ff = f * f * (3 - 2 * f) * 0.4 + f * f * 0.6; // accelerate into the ball
        // Ready → back, then a curved path through `via` to the contact point.
        const bx = READY_HAND.x + (def.back[0] - READY_HAND.x) * b;
        const by = READY_HAND.y + (def.back[1] - READY_HAND.y) * b;
        const bz = READY_HAND.z + (def.back[2] - READY_HAND.z) * b;
        const a0 = (1 - ff) * (1 - ff);
        const a1 = 2 * ff * (1 - ff);
        const a2 = ff * ff;
        sHand.set(
          a0 * bx + a1 * def.via[0] + a2 * contactHand.x,
          a0 * by + a1 * def.via[1] + a2 * contactHand.y,
          a0 * bz + a1 * def.via[2] + a2 * contactHand.z,
        );
        sDir.set(
          READY_DIR.x + (def.backDir[0] - READY_DIR.x) * b,
          READY_DIR.y + (def.backDir[1] - READY_DIR.y) * b,
          READY_DIR.z + (def.backDir[2] - READY_DIR.z) * b,
        );
        sDir.lerp(cDir, ff).normalize();
      } else {
        const f = smooth(clamp01(v / 0.55));
        sHand.set(
          contactHand.x + (def.follow[0] - contactHand.x) * f,
          contactHand.y + (def.follow[1] - contactHand.y) * f,
          contactHand.z + (def.follow[2] - contactHand.z) * f,
        );
        // Swing through: push forward a little before wrapping up.
        sHand.z += Math.sin(Math.PI * f) * 0.18;
        sDir.set(def.followDir[0], def.followDir[1], def.followDir[2]).normalize();
        sDir.lerpVectors(cDir, sDir, f).normalize();
      }
      handR.lerp(sHand, strokeW);
      rDir.lerp(sDir, strokeW).normalize();
      leftFree = strokeW;
      // Left arm: balance, or point at the ball for overheads, or drop the ball when serving.
      if (def.overhead && now < swing.contactT) {
        leftTarget.set(0.22, 1.95, 0.28);
      } else if (swing.stroke === 'serve' && now < swing.contactT && u < 0.35) {
        leftTarget.set(-0.33, 0.95, 0.36);
      } else if (swing.stroke === 'backhand' || swing.stroke === 'volley_bh') {
        leftTarget.set(0.42, 1.0, -0.2);
      } else {
        leftTarget.set(0.4, 1.12, 0.22);
      }
    }
    if (player.holdingBall && !swing) {
      // Ball held out in the palm, ready to be dropped for the serve.
      leftTarget.set(-0.33, 0.95, 0.36);
      leftFree = 1;
    }
    if (celebrating) {
      const pump = Math.sin(this.moodT * 9) * 0.08 * clamp01(2.2 - this.moodT * 0.7);
      handR.lerp(_p.set(-0.3, 1.92 + pump, 0.12), moodW);
      rDir.lerp(_d.set(-0.15, 0.97, 0.1), moodW).normalize();
      leftTarget.set(0.3, 1.32 + pump * 0.5, 0.26);
      leftFree = Math.max(leftFree, moodW);
    } else if (dejected) {
      handR.lerp(_p.set(-0.3, 0.74, 0.06), moodW);
      rDir.lerp(_d.set(0.05, -0.92, 0.38), moodW).normalize();
      leftTarget.set(0.27, 0.96, 0.04);
      leftFree = Math.max(leftFree, moodW);
    }

    // Left hand: on the racket throat in the ready position, otherwise at its own target.
    handL.copy(handR).addScaledVector(rDir, 0.21);
    handL.lerp(leftTarget, leftFree);

    // Hands are defined relative to a standing, forward-facing torso: follow the hips' drift.
    handR.x += pose.hips.x * 0.5;
    handR.z += pose.hips.z * 0.5;
    handL.x += pose.hips.x * 0.5;
    handL.z += pose.hips.z * 0.5;

    // --- Limbs -------------------------------------------------------------------------------
    solveLimb(pose.shoulder[1], handR, P.upperArm, P.foreArm, this.tmp.set(-0.55, -0.75, -0.35), pose.elbow[1], pose.wrist[1]);
    solveLimb(pose.shoulder[0], handL, P.upperArm, P.foreArm, this.tmp.set(0.55, -0.75, -0.35), pose.elbow[0], pose.wrist[0]);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      this.tmp.set(side * 0.12, 0, 1);
      solveLimb(pose.hip[i], pose.ankle[i], P.thigh, P.shin, this.tmp, pose.knee[i], this.tmp2);
      pose.ankle[i].copy(this.tmp2);
      // Toes point forward; a lifted foot tips down a little.
      const f = this.feet[i];
      pose.toe[i].set(pose.ankle[i].x + side * 0.02, Math.max(0.02, pose.ankle[i].y - P.ankleHeight + 0.02 - f.y * 0.25), pose.ankle[i].z + P.footLength);
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
