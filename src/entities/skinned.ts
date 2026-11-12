import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { type Pose, type Proportions, solveLimb } from './animator';
import type { BodyRenderer, Outfit } from './character';

/** Loaded player model, shared by every character (each gets its own clone). */
export interface PlayerModel {
  scene: THREE.Object3D;
  /** Rest position of every bone's head and tail, in metres, model space. */
  rest: Map<string, { head: THREE.Vector3; tail: THREE.Vector3 }>;
  proportions: Proportions;
  darkSkin: THREE.Texture | null;
}

export async function loadPlayerModel(onProgress?: (fraction: number) => void): Promise<PlayerModel> {
  const draco = new DRACOLoader();
  const base = import.meta.env.BASE_URL;
  draco.setDecoderPath({ js: `${base}draco/draco_wasm_wrapper.js`, wasm: `${base}draco/draco_decoder.wasm` });
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/player.glb`, (e) => {
    if (onProgress && e.total > 0) onProgress(e.loaded / e.total);
  });
  draco.dispose();
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const rest = new Map<string, { head: THREE.Vector3; tail: THREE.Vector3 }>();
  scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      const head = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      const t = o.userData.tail as number[] | undefined;
      rest.set(o.name, { head, tail: t ? new THREE.Vector3(t[0], t[1], t[2]) : head.clone() });
    }
  });
  const g = (n: string) => {
    const r = rest.get(n);
    if (!r) throw new Error(`player model: missing bone ${n}`);
    return r.head;
  };
  const shoulderY = g('upperarm_l').y;
  const proportions: Proportions = {
    hipHeight: g('pelvis').y - 0.012,
    hipHalfWidth: Math.abs(g('thigh_l').x),
    thigh: g('thigh_l').distanceTo(g('calf_l')),
    shin: g('calf_l').distanceTo(g('foot_l')),
    ankleHeight: g('foot_l').y,
    footLength: 0.17,
    spine: shoulderY - g('pelvis').y,
    shoulderHalfWidth: Math.abs(g('upperarm_l').x),
    neck: g('head').y - shoulderY,
    headRadius: 0.105,
    upperArm: g('upperarm_l').distanceTo(g('lowerarm_l')),
    foreArm: g('lowerarm_l').distanceTo(g('hand_l')),
    hand: 0.09,
  };
  let darkSkin: THREE.Texture | null = null;
  try {
    darkSkin = await new THREE.TextureLoader().loadAsync(`${import.meta.env.BASE_URL}models/skin_dark.webp`);
    darkSkin.colorSpace = THREE.SRGBColorSpace;
    darkSkin.flipY = false;
  } catch {
    darkSkin = null;
  }
  return { scene, rest, proportions, darkSkin };
}

interface BoneRef {
  bone: THREE.Bone;
  parent: number; // index into the ordered list, -1 for the root
  restHead: THREE.Vector3;
  /** Offset of this bone's head from its parent's head at rest. */
  offset: THREE.Vector3;
  world: THREE.Quaternion;
  pos: THREE.Vector3;
  /** Set this frame by the pose; otherwise the bone follows its parent (with `local`). */
  driven: boolean;
  local: THREE.Quaternion;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _x = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _mid = new THREE.Vector3();
const _end = new THREE.Vector3();

/** Orthonormal frame with y along `dir` and x as close as possible to `pole`. */
function frame(dir: THREE.Vector3, pole: THREE.Vector3, out: THREE.Matrix4): THREE.Matrix4 {
  _x.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (_x.lengthSq() < 1e-8) {
    _x.set(1, 0, 0).addScaledVector(dir, -dir.x);
    if (_x.lengthSq() < 1e-8) _x.set(0, 0, 1);
  }
  _x.normalize();
  _z.crossVectors(_x, dir);
  return out.makeBasis(_x, dir, _z);
}

/** Rotation taking a rest limb (direction + pole) to its current direction and pole. */
function limbRotation(
  restDir: THREE.Vector3,
  restPole: THREE.Vector3,
  dir: THREE.Vector3,
  pole: THREE.Vector3,
  out: THREE.Quaternion,
): THREE.Quaternion {
  frame(restDir, restPole, _m1).transpose();
  frame(dir, pole, _m2).multiply(_m1);
  return out.setFromRotationMatrix(_m2);
}

interface LimbRest {
  upper: number;
  lower: number;
  end: number;
  upperDir: THREE.Vector3;
  lowerDir: THREE.Vector3;
  pole: THREE.Vector3;
  l1: number;
  l2: number;
}

/**
 * Skinned realistic body: converts the animator's joint positions into bone rotations.
 * Torso bones take their orientation from the pose; arms and legs are re-solved with the
 * model's own bone lengths so hands and feet land exactly on their targets.
 */
export class SkinnedBody implements BodyRenderer {
  readonly object: THREE.Object3D;
  readonly proportions: Proportions;
  private bones: BoneRef[] = [];
  private index = new Map<string, number>();
  private arms: LimbRest[] = [];
  private legs: LimbRest[] = [];
  private feet: Array<{ foot: number; restDir: THREE.Vector3 }> = [];

  constructor(model: PlayerModel, outfit: Outfit, darkSkin: boolean) {
    this.proportions = model.proportions;
    this.object = cloneSkinned(model.scene);
    this.object.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      const m = (mesh.material as THREE.MeshStandardMaterial).clone();
      mesh.material = m;
      const name = m.name;
      if (name === 'tee') m.color.setHex(outfit.shirt);
      else if (name === 'shorts') m.color.setHex(outfit.shorts);
      else if (name === 'hair') {
        m.color.setHex(outfit.hair).multiplyScalar(2.2);
        m.alphaTest = 0.4;
        m.transparent = false;
      } else if (name === 'skin') {
        if (darkSkin && model.darkSkin) m.map = model.darkSkin;
      } else if (name === 'shoes') {
        m.color.setHex(outfit.shoes);
      }
      m.envMapIntensity = 0.6;
    });

    // Ordered list of bones, parents first.
    const all: THREE.Bone[] = [];
    this.object.traverse((o) => {
      if ((o as THREE.Bone).isBone) all.push(o as THREE.Bone);
    });
    for (const bone of all) {
      const rest = model.rest.get(bone.name)!;
      const parentBone = bone.parent && (bone.parent as THREE.Bone).isBone ? (bone.parent as THREE.Bone) : null;
      const parent = parentBone ? this.index.get(parentBone.name)! : -1;
      const parentHead = parent >= 0 ? this.bones[parent].restHead : new THREE.Vector3();
      this.index.set(bone.name, this.bones.length);
      this.bones.push({
        bone,
        parent,
        restHead: rest.head.clone(),
        offset: rest.head.clone().sub(parentHead),
        world: new THREE.Quaternion(),
        pos: new THREE.Vector3(),
        driven: false,
        local: new THREE.Quaternion(),
      });
    }

    const head = (n: string) => model.rest.get(n)!.head;
    for (const s of ['l', 'r']) {
      const side = s === 'l' ? 1 : -1;
      const mk = (u: string, l: string, e: string, defaultPole: THREE.Vector3): LimbRest => {
        const a = head(u);
        const b = head(l);
        const c = head(e);
        const upperDir = b.clone().sub(a).normalize();
        const lowerDir = c.clone().sub(b).normalize();
        // Direction the middle joint points to at rest, if the limb is bent enough to tell.
        const ac = c.clone().sub(a).normalize();
        const bend = b.clone().sub(a);
        bend.addScaledVector(ac, -bend.dot(ac));
        const pole = bend.length() > 0.012 ? bend.normalize() : defaultPole.clone();
        return {
          upper: this.index.get(u)!,
          lower: this.index.get(l)!,
          end: this.index.get(e)!,
          upperDir,
          lowerDir,
          pole,
          l1: a.distanceTo(b),
          l2: b.distanceTo(c),
        };
      };
      this.arms.push(mk(`upperarm_${s}`, `lowerarm_${s}`, `hand_${s}`, new THREE.Vector3(0, 0, -1)));
      this.legs.push(mk(`thigh_${s}`, `calf_${s}`, `foot_${s}`, new THREE.Vector3(0, 0, 1)));
      this.feet.push({
        foot: this.index.get(`foot_${s}`)!,
        restDir: head(`ball_${s}`).clone().sub(head(`foot_${s}`)).normalize(),
      });

      // Fingers: a fixed curl. The racket hand closes around the grip, the other stays relaxed.
      const knuckles = head(`index_01_${s}`).clone().sub(head(`pinky_01_${s}`)).normalize();
      const curl = s === 'r' ? 1.0 : 0.4;
      for (const f of ['index', 'middle', 'ring', 'pinky']) {
        for (const j of ['01', '02', '03']) {
          const b = this.bones[this.index.get(`${f}_${j}_${s}`)!];
          b.local.setFromAxisAngle(knuckles, -side * curl * (j === '01' ? 0.9 : 1));
        }
      }
      const thumbAxis = model.rest.get(`thumb_01_${s}`)!.tail.clone().sub(head(`thumb_01_${s}`)).cross(knuckles).normalize();
      for (const j of ['02', '03']) {
        this.bones[this.index.get(`thumb_${j}_${s}`)!].local.setFromAxisAngle(thumbAxis, side * curl * 0.5);
      }
    }
  }

  private drive(name: string, q: THREE.Quaternion): void {
    const b = this.bones[this.index.get(name)!];
    b.world.copy(q);
    b.driven = true;
  }

  /** World position of bone `i` from its parent's (already computed) position and rotation. */
  private place(i: number): THREE.Vector3 {
    const b = this.bones[i];
    const p = this.bones[b.parent];
    return b.pos.copy(b.offset).applyQuaternion(p.world).add(p.pos);
  }

  update(pose: Pose): void {
    const B = this.bones;
    for (const b of B) b.driven = false;

    // --- Torso -------------------------------------------------------------------------------
    const pelvis = B[this.index.get('pelvis')!];
    this.drive('pelvis', pose.hipsQuat);
    this.drive('spine_01', _q.copy(pose.hipsQuat).slerp(pose.chestQuat, 0.35));
    this.drive('spine_02', _q.copy(pose.hipsQuat).slerp(pose.chestQuat, 0.7));
    this.drive('spine_03', pose.chestQuat);
    this.drive('clavicle_l', pose.chestQuat);
    this.drive('clavicle_r', pose.chestQuat);
    this.drive('neck_01', _q.copy(pose.chestQuat).slerp(pose.headQuat, 0.5));
    this.drive('head', pose.headQuat);

    // Positions down the torso so shoulders and hips are known before solving the limbs.
    const root = B[0];
    root.world.identity();
    root.pos.copy(root.restHead);
    for (let i = 1; i < B.length; i++) {
      const b = B[i];
      if (b === pelvis) {
        b.pos.copy(pose.hips);
        continue;
      }
      if (!b.driven) b.world.copy(B[b.parent].world).multiply(b.local);
      this.place(i);
    }

    // --- Arms and legs -----------------------------------------------------------------------
    const solve = (limb: LimbRest, target: THREE.Vector3, hint: THREE.Vector3) => {
      const rootPos = B[limb.upper].pos;
      _a.subVectors(hint, rootPos); // pole hint: where the animator put the middle joint
      solveLimb(rootPos, target, limb.l1, limb.l2, _a, _mid, _end);
      // Pole of the solved limb: the part of (mid - root) perpendicular to (end - root).
      _b.subVectors(_end, rootPos).normalize();
      _c.subVectors(_mid, rootPos);
      _c.addScaledVector(_b, -_c.dot(_b));
      if (_c.lengthSq() < 1e-8) _c.copy(_a);
      _c.normalize();
      const up = B[limb.upper];
      const lo = B[limb.lower];
      _a.subVectors(_mid, rootPos).normalize();
      limbRotation(limb.upperDir, limb.pole, _a, _c, up.world);
      up.driven = true;
      _a.subVectors(_end, _mid).normalize();
      limbRotation(limb.lowerDir, limb.pole, _a, _c, lo.world);
      lo.driven = true;
      lo.pos.copy(_mid);
      B[limb.end].pos.copy(_end);
    };
    for (let i = 0; i < 2; i++) {
      solve(this.arms[i], pose.wrist[i], pose.elbow[i]);
      // The hand follows the forearm.
      const hand = B[this.arms[i].end];
      hand.world.copy(B[this.arms[i].lower].world);
      hand.driven = true;

      solve(this.legs[i], pose.ankle[i], pose.knee[i]);
      const f = this.feet[i];
      const foot = B[f.foot];
      _a.subVectors(pose.toe[i], pose.ankle[i]).normalize();
      limbRotation(f.restDir, _b.set(0, 1, 0), _a, _c.set(0, 1, 0), foot.world);
      foot.driven = true;
    }

    // --- World rotations → local bone transforms -----------------------------------------------
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (b.parent < 0) {
        b.bone.quaternion.identity();
        continue;
      }
      const p = B[b.parent];
      if (!b.driven) {
        b.world.copy(p.world).multiply(b.local);
        b.bone.quaternion.copy(b.local);
      } else {
        b.bone.quaternion.copy(_q.copy(p.world).invert()).multiply(b.world);
      }
    }
    pelvis.bone.position.copy(pose.hips).sub(root.restHead);
  }
}
