import * as THREE from 'three';
import { createBlobTexture } from '../render/textures';
import { Animator, type Pose, type Proportions, RACKET_REACH } from './animator';
import type { Player } from './player';

export interface Outfit {
  /** Use the darker skin texture on the realistic model. */
  darkSkin?: boolean;
  shirt: number;
  shorts: number;
  skin: number;
  hair: number;
  shoes: number;
}

/** Something that can draw a pose: the jointed mannequin or a skinned model. */
export interface BodyRenderer {
  readonly object: THREE.Object3D;
  update(pose: Pose): void;
  /** Recolour shirt and shorts, when the body supports it. */
  setColors?(shirt: number, shorts: number): void;
}

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

interface Segment {
  mesh: THREE.Mesh;
  a: THREE.Vector3;
  b: THREE.Vector3;
}

/**
 * Jointed mannequin built from tapered segments. It is the fallback body, used while the
 * realistic model loads and on the lowest quality tier.
 */
export class Mannequin implements BodyRenderer {
  readonly object = new THREE.Group();
  private segments: Segment[] = [];
  private torso: THREE.Mesh;
  private pelvis: THREE.Mesh;
  private head: THREE.Mesh;
  private hands: THREE.Mesh[] = [];
  private feet: THREE.Mesh[] = [];
  private pose: Pose | null = null;

  constructor(outfit: Outfit) {
    const mat = (color: number, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
    const skin = mat(outfit.skin, 0.6);
    const shirt = mat(outfit.shirt, 0.85);
    const shorts = mat(outfit.shorts, 0.85);
    const shoes = mat(outfit.shoes, 0.6);
    const hair = mat(outfit.hair, 0.9);

    const add = (m: THREE.Mesh) => {
      m.castShadow = true;
      this.object.add(m);
      return m;
    };
    const seg = (rBottom: number, rTop: number, material: THREE.Material): THREE.Mesh => {
      const g = new THREE.CylinderGeometry(rTop, rBottom, 1, 12, 1);
      const m = add(new THREE.Mesh(g, material));
      // Round the ends so joints do not show gaps.
      const capA = new THREE.Mesh(new THREE.SphereGeometry(rBottom, 12, 8), material);
      capA.position.y = -0.5;
      const capB = new THREE.Mesh(new THREE.SphereGeometry(rTop, 12, 8), material);
      capB.position.y = 0.5;
      capA.castShadow = capB.castShadow = true;
      m.add(capA, capB);
      m.userData.caps = [capA, capB];
      return m;
    };

    this.torso = add(new THREE.Mesh(new THREE.CylinderGeometry(0.168, 0.135, 1, 16, 1), shirt));
    const shoulders = new THREE.Mesh(new THREE.SphereGeometry(0.168, 16, 10), shirt);
    shoulders.position.y = 0.5;
    shoulders.castShadow = true;
    this.torso.add(shoulders);
    this.torso.userData.cap = shoulders;
    this.pelvis = add(new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), shorts));
    this.head = add(new THREE.Mesh(new THREE.SphereGeometry(1, 20, 16), skin));
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(1.06, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), hair);
    hairCap.rotation.x = -0.25;
    hairCap.castShadow = true;
    this.head.add(hairCap);
    this.segments.push({ mesh: seg(0.045, 0.05, skin), a: new THREE.Vector3(), b: new THREE.Vector3() }); // neck (filled in update)

    for (let i = 0; i < 2; i++) {
      this.segments.push({ mesh: seg(0.056, 0.047, shirt), a: new THREE.Vector3(), b: new THREE.Vector3() }); // upper arm
      this.segments.push({ mesh: seg(0.043, 0.033, skin), a: new THREE.Vector3(), b: new THREE.Vector3() }); // forearm
      this.segments.push({ mesh: seg(0.088, 0.063, shorts), a: new THREE.Vector3(), b: new THREE.Vector3() }); // thigh
      this.segments.push({ mesh: seg(0.056, 0.04, skin), a: new THREE.Vector3(), b: new THREE.Vector3() }); // shin
      this.hands.push(add(new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), skin)));
      const foot = add(new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.075, 0.27), shoes));
      this.feet.push(foot);
    }
  }

  private place(s: Segment): void {
    _dir.subVectors(s.b, s.a);
    const len = Math.max(1e-4, _dir.length());
    s.mesh.position.addVectors(s.a, s.b).multiplyScalar(0.5);
    s.mesh.quaternion.setFromUnitVectors(UP, _dir.divideScalar(len));
    s.mesh.scale.set(1, len, 1);
    // Keep the end caps spherical despite the stretch.
    for (const cap of s.mesh.userData.caps as THREE.Mesh[]) cap.scale.set(1, 1 / len, 1);
  }

  update(pose: Pose): void {
    this.pose = pose;
    const S = this.segments;
    // Torso and pelvis.
    _dir.subVectors(pose.chest, pose.hips);
    const tl = _dir.length();
    this.torso.position.addVectors(pose.chest, pose.hips).multiplyScalar(0.5);
    this.torso.quaternion.copy(pose.chestQuat);
    this.torso.scale.set(1, tl, 0.68);
    (this.torso.userData.cap as THREE.Mesh).scale.set(1, 0.45 / tl, 1);
    this.pelvis.position.copy(pose.hips);
    this.pelvis.quaternion.copy(pose.hipsQuat);
    this.pelvis.scale.set(1.08, 0.82, 0.8);
    this.head.position.copy(pose.head);
    this.head.quaternion.copy(pose.headQuat);
    this.head.scale.set(0.094, 0.118, 0.106);

    S[0].a.copy(pose.chest);
    S[0].b.copy(pose.head);
    this.place(S[0]);
    for (let i = 0; i < 2; i++) {
      const o = 1 + i * 4;
      S[o].a.copy(pose.shoulder[i]);
      S[o].b.copy(pose.elbow[i]);
      S[o + 1].a.copy(pose.elbow[i]);
      S[o + 1].b.copy(pose.wrist[i]);
      S[o + 2].a.copy(pose.hip[i]);
      S[o + 2].b.copy(pose.knee[i]);
      S[o + 3].a.copy(pose.knee[i]);
      S[o + 3].b.copy(pose.ankle[i]);
      for (let k = 0; k < 4; k++) this.place(S[o + k]);
      this.hands[i].position.copy(pose.wrist[i]);
      // Shoe: from behind the ankle to the toe.
      const f = this.feet[i];
      _dir.subVectors(pose.toe[i], pose.ankle[i]);
      _dir.y += 0.055;
      f.position.copy(pose.ankle[i]).addScaledVector(_dir, 0.42);
      f.position.y -= 0.035;
      f.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _dir.normalize());
    }
    void this.pose;
  }
}

const racketFaceTextures = new Map<number, THREE.Texture>();
function racketFace(accent: number): THREE.Texture {
  const cached = racketFaceTextures.get(accent);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#16181c';
  ctx.fillRect(0, 0, 256, 256);
  // Coloured arc and the drilled holes typical of a padel racket.
  ctx.strokeStyle = `#${accent.toString(16).padStart(6, '0')}`;
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.arc(128, 128, 96, Math.PI * 1.05, Math.PI * 1.95);
  ctx.stroke();
  ctx.fillStyle = '#04050a';
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++) {
      const px = 48 + x * 20 + (y % 2) * 10;
      const py = 56 + y * 18;
      if (Math.hypot(px - 128, py - 128) < 84) {
        ctx.beginPath();
        ctx.arc(px, py, 4.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  racketFaceTextures.set(accent, tex);
  return tex;
}

export type RacketShape = 'round' | 'teardrop' | 'diamond';
export type RacketFinish = 'matte' | 'gloss' | 'metal';

/** Outline of the head, seen face on: round, wider towards the top (teardrop) or more so (diamond). */
function headOutline(shape: RacketShape): THREE.Shape {
  const rx = 0.122;
  const ry = shape === 'diamond' ? 0.142 : 0.134;
  const k = shape === 'round' ? 0 : shape === 'teardrop' ? 0.16 : 0.3;
  const s = new THREE.Shape();
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * Math.PI * 2;
    const x = rx * Math.sin(t) * (1 + k * Math.cos(t));
    const y = ry * Math.cos(t);
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  return s;
}

/** Padel racket: origin at the grip, +y along the handle, +z the face normal. */
export function buildRacket(accent = 0xd8ef2f, frame = 0x14161a, shape: RacketShape = 'round', finish: RacketFinish = 'gloss'): THREE.Group {
  const g = new THREE.Group();
  const look = finish === 'matte' ? { roughness: 0.85, metalness: 0 } : finish === 'metal' ? { roughness: 0.22, metalness: 0.95 } : { roughness: 0.35, metalness: 0.2 };
  const frameMat = new THREE.MeshStandardMaterial({ color: frame, ...look });
  const faceMat = new THREE.MeshStandardMaterial({ map: racketFace(accent), roughness: finish === 'matte' ? 0.8 : 0.5, metalness: 0.1 });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.9 });
  const depth = 0.036;
  const geo = new THREE.ExtrudeGeometry(headOutline(shape), { depth, bevelEnabled: false, curveSegments: 12 });
  // The face texture is square: map the outline's bounding square onto it.
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 0.3 + 0.5, uv.getY(i) / 0.3 + 0.5);
  geo.translate(0, 0, -depth / 2);
  const head = new THREE.Mesh(geo, [faceMat, frameMat]);
  head.position.y = RACKET_REACH;
  head.castShadow = true;
  g.add(head);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.0175, 0.17, 12), gripMat);
  grip.position.y = 0.045;
  grip.castShadow = true;
  g.add(grip);
  for (const s of [-1, 1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.1, 0.03), frameMat);
    bar.position.set(s * 0.026, 0.165, 0);
    bar.rotation.z = -s * 0.32;
    g.add(bar);
  }
  return g;
}

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3();
const _g = new THREE.Vector3();

/** One player on screen: body, racket and a soft contact shadow, driven by an Animator. */
export class CharacterView {
  readonly group = new THREE.Group();
  readonly animator: Animator;
  body: BodyRenderer;
  private racket: THREE.Group;
  private shadow: THREE.Mesh;
  private marker: THREE.Mesh | null = null;
  /** Current colours, re-applied when the body is swapped. */
  outfit: Outfit;

  constructor(outfit: Outfit, highlight: boolean) {
    this.outfit = outfit;
    this.animator = new Animator();
    this.body = new Mannequin(outfit);
    this.group.add(this.body.object);
    this.racket = buildRacket();
    this.group.add(this.racket);

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: createBlobTexture(0.15, 1.5),
        color: 0x000000,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.005;
    this.shadow.scale.set(0.95, 0.75, 1);
    this.shadow.renderOrder = 1;
    this.group.add(this.shadow);

    if (highlight) {
      // Thin ring under the player you control.
      this.marker = new THREE.Mesh(
        new THREE.RingGeometry(0.42, 0.47, 40),
        new THREE.MeshBasicMaterial({ color: 0xd8ef2f, transparent: true, opacity: 0.75, depthWrite: false }),
      );
      this.marker.rotation.x = -Math.PI / 2;
      this.marker.position.y = 0.008;
      this.marker.renderOrder = 2;
      this.group.add(this.marker);
    }
  }

  /** Changes the racket's colours (shop items). */
  setRacket(accent: number, frame: number, shape: RacketShape = 'round', finish: RacketFinish = 'gloss'): void {
    this.group.remove(this.racket);
    this.racket = buildRacket(accent, frame, shape, finish);
    this.group.add(this.racket);
  }

  /** Changes shirt and shorts colours (shop items). */
  setOutfit(outfit: Outfit): void {
    this.outfit = outfit;
    if (this.body instanceof Mannequin) {
      this.group.remove(this.body.object);
      this.body = new Mannequin(outfit);
      this.group.add(this.body.object);
    } else {
      this.body.setColors?.(outfit.shirt, outfit.shorts);
    }
  }

  /** Swap the mannequin for a loaded model, adopting its body measurements. */
  setBody(body: BodyRenderer, proportions?: Proportions): void {
    this.group.remove(this.body.object);
    this.body = body;
    this.group.add(body.object);
    if (proportions) this.animator.prop = proportions;
  }

  /** From the wrist to the middle of the closed hand, along the forearm. */
  private gripOffset(pose: Pose): THREE.Vector3 {
    return _g.subVectors(pose.wrist[1], pose.elbow[1]).normalize().multiplyScalar(0.075);
  }

  update(dt: number, player: Player, now: number, ball: { x: number; y: number; z: number }, ballLive: boolean): void {
    const a = this.animator;
    a.update(dt, player, now, ball, ballLive);
    this.group.position.set(a.worldX, 0, a.worldZ);
    this.group.rotation.y = a.yaw;
    const pose = a.pose;
    this.body.update(pose);

    // Racket in the right hand.
    _x.crossVectors(pose.racketDir, pose.racketNormal).normalize();
    _m.makeBasis(_x, pose.racketDir, pose.racketNormal);
    this.racket.quaternion.setFromRotationMatrix(_m);
    this.racket.position.copy(pose.wrist[1]).addScaledVector(pose.racketDir, 0.02).add(this.gripOffset(pose));
    this.shadow.position.x = pose.hips.x;
    this.shadow.position.z = pose.hips.z;
  }
}
