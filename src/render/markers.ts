import * as THREE from 'three';

function ringTexture(): THREE.Texture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, s, s);
  // Soft disc, bright ring and a centre dot: readable from the far end of the court.
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.34)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0.16)');
  grad.addColorStop(0.72, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = '#fff';
  g.lineWidth = 11;
  g.beginPath();
  g.arc(s / 2, s / 2, s / 2 - 8, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(s / 2, s / 2, 7, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function disc(tex: THREE.Texture, color: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: tex,
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.02;
  m.renderOrder = 6;
  m.visible = false;
  return m;
}

const AIM = new THREE.Color(0xd8ef2f);
const AIM_OVER = new THREE.Color(0xff5a3c);
const LANDING = new THREE.Color(0xffffff);
const LANDING_OUT = new THREE.Color(0xff8a5c);

/**
 * Marks drawn on the court: where the player's shot is aimed (on the opponents' side) and
 * where the incoming ball is going to bounce (on the player's side).
 */
export class CourtMarkers {
  readonly group = new THREE.Group();
  private aim: THREE.Mesh;
  private landing: THREE.Mesh;
  private t = 0;
  private aimOn = 0;
  private landOn = 0;
  private aimWanted = false;
  private landWanted = false;

  constructor() {
    const tex = ringTexture();
    this.aim = disc(tex, 0xd8ef2f);
    this.landing = disc(tex, 0xffffff);
    this.group.add(this.aim, this.landing);
  }

  /** Aim marker: `over` 0..1 turns it red as the shot is overhit. `null` hides it. */
  setAim(target: { x: number; z: number } | null, over = 0): void {
    this.aimWanted = target !== null;
    if (!target) return;
    this.aim.position.x = target.x;
    this.aim.position.z = target.z;
    (this.aim.material as THREE.MeshBasicMaterial).color.copy(AIM).lerp(AIM_OVER, over);
  }

  /** Bounce marker for the incoming ball. `null` hides it. */
  setLanding(point: { x: number; z: number } | null, out = false): void {
    this.landWanted = point !== null;
    if (!point) return;
    this.landing.position.x = point.x;
    this.landing.position.z = point.z;
    (this.landing.material as THREE.MeshBasicMaterial).color.copy(out ? LANDING_OUT : LANDING);
  }

  update(dt: number): void {
    this.t += dt;
    const k = Math.min(1, dt * 12);
    this.aimOn += ((this.aimWanted ? 1 : 0) - this.aimOn) * k;
    this.landOn += ((this.landWanted ? 1 : 0) - this.landOn) * k;
    const pulse = 1 + Math.sin(this.t * 7) * 0.06;
    this.aim.visible = this.aimOn > 0.02;
    this.aim.scale.setScalar(2.1 * pulse);
    (this.aim.material as THREE.MeshBasicMaterial).opacity = 0.95 * this.aimOn;
    this.landing.visible = this.landOn > 0.02;
    this.landing.scale.setScalar(1.15 * (2 - pulse));
    (this.landing.material as THREE.MeshBasicMaterial).opacity = 0.8 * this.landOn;
  }
}
