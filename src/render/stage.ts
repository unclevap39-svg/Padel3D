import * as THREE from 'three';
import { buildCourt, buildSky, type CourtBuild } from './court';

export type QualityTier = 'low' | 'medium' | 'high';

interface TierSettings {
  maxPixelRatio: number;
  shadowSize: number; // 0 disables real-time shadows
  anisotropy: number;
}

const TIERS: Record<QualityTier, TierSettings> = {
  low: { maxPixelRatio: 1, shadowSize: 0, anisotropy: 2 },
  medium: { maxPixelRatio: 1.5, shadowSize: 1024, anisotropy: 4 },
  high: { maxPixelRatio: 2, shadowSize: 2048, anisotropy: 8 },
};

/**
 * Environment map rendered from a tiny procedural scene (night sky, four floodlight heads, the
 * blue court, dim stands) so reflections in the glass match what surrounds the court.
 */
function buildEnvironment(renderer: THREE.WebGLRenderer, floodlights: THREE.Vector3[]): THREE.Texture {
  const env = new THREE.Scene();
  env.add(buildSky());
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(60, 62, 66), side: THREE.DoubleSide });
  for (const p of floodlights) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.5), lamp);
    m.position.copy(p);
    m.lookAt(0, 1, 0);
    env.add(m);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 20), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.05, 0.2, 0.55) }));
  floor.rotation.x = -Math.PI / 2;
  env.add(floor);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.02, 0.03, 0.05) }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.05;
  env.add(apron);
  const stand = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.06, 0.07, 0.1), side: THREE.DoubleSide });
  for (const [x, z, ry] of [
    [0, -20, 0],
    [0, 20, Math.PI],
    [-15, 0, Math.PI / 2],
    [15, 0, -Math.PI / 2],
  ] as const) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(34, 7), stand);
    m.position.set(x, 4, z);
    m.rotation.y = ry;
    env.add(m);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.02, 0.1, 200, { size: 128, position: new THREE.Vector3(0, 1.6, 0) });
  pmrem.dispose();
  return rt.texture;
}

/** Owns the renderer, scene, camera, lights and the court. */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly court: CourtBuild;
  readonly keyLight: THREE.DirectionalLight;
  tier: QualityTier;
  /** Multiplier applied on top of the tier's pixel ratio by the adaptive controller (0.5..1). */
  resolutionScale = 1;
  /** Field of view for the current aspect ratio, before any zoom. */
  baseFov = 35;

  constructor(canvas: HTMLCanvasElement, tier: QualityTier) {
    this.tier = tier;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: tier !== 'low', powerPreference: 'high-performance', alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.shadowMap.enabled = TIERS[tier].shadowSize > 0;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 300);
    this.camera.position.set(0, 5.2, 16.5);
    this.camera.lookAt(0, 0.8, -2);

    const aniso = Math.min(TIERS[tier].anisotropy, this.renderer.capabilities.getMaxAnisotropy());
    this.court = buildCourt(aniso);
    this.scene.add(this.court.group);
    this.scene.add(buildSky());
    this.scene.fog = new THREE.Fog(0x0a1220, 45, 130);

    this.scene.environment = buildEnvironment(this.renderer, this.court.floodlights);
    this.scene.environmentIntensity = 0.55;

    // Four floodlights: the one behind the camera's right shoulder casts the shadows, the other
    // three fill. A hemisphere light stands in for light bounced around the arena.
    this.scene.add(new THREE.HemisphereLight(0xb4c8ee, 0x1b3158, 0.8));
    const f = this.court.floodlights;
    this.keyLight = new THREE.DirectionalLight(0xfff6ea, 1.7);
    const fills: THREE.DirectionalLight[] = [];
    f.forEach((p, i) => {
      const isKey = p.x > 0 && p.z > 0;
      const light = isKey ? this.keyLight : new THREE.DirectionalLight(0xeef3ff, 1.05);
      // Aim from higher than the mast heads: keeps shadows short, as under real arena rigs.
      light.position.set(p.x, 20, p.z);
      light.target.position.set(0, 0, 0);
      this.scene.add(light, light.target);
      if (!isKey) fills.push(light);
      void i;
    });
    const sh = this.keyLight.shadow;
    sh.camera.left = -8;
    sh.camera.right = 8;
    sh.camera.top = 12.5;
    sh.camera.bottom = -12.5;
    sh.camera.near = 2;
    sh.camera.far = 50;
    sh.bias = -0.0004;
    sh.normalBias = 0.03;
    sh.radius = 2.5;
    this.applyTier(tier);
    this.resize();
  }

  applyTier(tier: QualityTier): void {
    this.tier = tier;
    const t = TIERS[tier];
    const on = t.shadowSize > 0;
    this.renderer.shadowMap.enabled = on;
    this.keyLight.castShadow = on;
    if (on && this.keyLight.shadow.mapSize.x !== t.shadowSize) {
      this.keyLight.shadow.mapSize.set(t.shadowSize, t.shadowSize);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) m.needsUpdate = true;
    });
    this.resize();
  }

  get pixelRatio(): number {
    return Math.max(0.5, Math.min(window.devicePixelRatio || 1, TIERS[this.tier].maxPixelRatio) * this.resolutionScale);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole court width in view on narrow (portrait-ish) screens.
    this.baseFov = w / h > 1.5 ? 35 : Math.min(72, 35 * (1.5 / (w / h)));
    this.camera.fov = this.baseFov;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
