import * as THREE from 'three';
import { BALL_RADIUS, type BallState } from '../physics/ballistics';
import { createBallTextures, createBlobTexture } from '../render/textures';

/**
 * Ball visuals: a felt sphere, a soft contact shadow that tightens as the ball nears the floor,
 * and a short motion streak. The mesh is drawn slightly larger than regulation size so it stays
 * readable on a phone screen; the physics uses the real radius.
 */
export class BallView {
  static readonly VISUAL_SCALE = 1.35;
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh;
  private shadow: THREE.Mesh;
  private trail: THREE.Mesh;
  private trailPositions: Float32Array;
  private history: THREE.Vector3[] = [];
  private static readonly TRAIL_POINTS = 10;

  constructor() {
    const tex = createBallTextures();
    const mat = new THREE.MeshStandardMaterial({
      map: tex.map,
      normalMap: tex.normalMap,
      normalScale: new THREE.Vector2(0.6, 0.6),
      roughness: 0.95,
      metalness: 0,
      emissive: 0x3a4208,
      emissiveIntensity: 0.35,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS * BallView.VISUAL_SCALE, 24, 16), mat);
    this.mesh.castShadow = true;
    this.group.add(this.mesh);

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: createBlobTexture(0.1, 1.8),
        color: 0x000000,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
    this.group.add(this.shadow);

    // Streak: a camera-independent ribbon made of two crossed strips along the recent path.
    const n = BallView.TRAIL_POINTS;
    this.trailPositions = new Float32Array(n * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    const alpha = new Float32Array(n * 2);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      alpha[i * 2] = alpha[i * 2 + 1] = 1 - i / (n - 1);
      if (i < n - 1) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    geo.setIndex(idx);
    const trailMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform float uOpacity; varying float vA; void main(){ gl_FragColor = vec4(0.86, 0.95, 0.35, vA * vA * uOpacity); }`,
    });
    this.trail = new THREE.Mesh(geo, trailMat);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 5;
    this.group.add(this.trail);
  }

  reset(): void {
    this.history.length = 0;
  }

  update(b: Readonly<BallState>, rot: { x: number; y: number; z: number; w: number }, camera: THREE.Camera): void {
    this.mesh.position.set(b.px, b.py, b.pz);
    this.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);

    const h = Math.max(0, b.py - BALL_RADIUS);
    const size = 0.16 + h * 0.1;
    this.shadow.position.set(b.px, 0.006, b.pz);
    this.shadow.scale.setScalar(size);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.55 / (1 + h * 0.9);
    // No floor shadow once the ball is outside the enclosure.
    this.shadow.visible = Math.abs(b.px) < 5 && Math.abs(b.pz) < 10;

    // Trail.
    const hist = this.history;
    hist.unshift(new THREE.Vector3(b.px, b.py, b.pz));
    if (hist.length > BallView.TRAIL_POINTS) hist.length = BallView.TRAIL_POINTS;
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    const mat = this.trail.material as THREE.ShaderMaterial;
    mat.uniforms.uOpacity.value = Math.min(0.5, Math.max(0, (speed - 6) / 30));
    const toCam = new THREE.Vector3();
    const side = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const p = this.trailPositions;
    const r = BALL_RADIUS * BallView.VISUAL_SCALE * 0.8;
    for (let i = 0; i < BallView.TRAIL_POINTS; i++) {
      const cur = hist[Math.min(i, hist.length - 1)];
      const next = hist[Math.min(i + 1, hist.length - 1)];
      dir.subVectors(cur, next);
      toCam.subVectors(camera.position, cur);
      side.crossVectors(dir, toCam);
      if (side.lengthSq() < 1e-10) side.set(1, 0, 0);
      side.normalize().multiplyScalar(r * (1 - i / BallView.TRAIL_POINTS));
      p[i * 6] = cur.x + side.x;
      p[i * 6 + 1] = cur.y + side.y;
      p[i * 6 + 2] = cur.z + side.z;
      p[i * 6 + 3] = cur.x - side.x;
      p[i * 6 + 4] = cur.y - side.y;
      p[i * 6 + 5] = cur.z - side.z;
    }
    (this.trail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
