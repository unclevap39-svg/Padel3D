import type { ShotIntent, ShotType } from '../core/types';

interface Gesture {
  id: number;
  kind: 'stick' | 'swipe' | ShotType;
  x0: number;
  y0: number;
  x: number;
  y: number;
}

const TAP = 14;

/**
 * Touch controls: a floating joystick on the left half of the screen, swipes on the right half
 * (direction of the swipe = direction of the shot, length = power) and two buttons, lob and
 * smash, which also accept a drag to aim. Keyboard and mouse work too, for desktop testing.
 */
export class TouchControls {
  /** Movement request: x right, z towards the camera, each -1..1. */
  readonly move = { x: 0, z: 0 };
  onShot: (intent: ShotIntent) => void = () => {};
  private root: HTMLElement;
  private base: HTMLElement;
  private knob: HTMLElement;
  private trail: HTMLElement;
  private gestures = new Map<number, Gesture>();
  private keys = new Set<string>();
  private enabled = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'controls hidden';
    this.root.innerHTML = `
      <div class="stick-base"><div class="stick-knob"></div></div>
      <div class="swipe-trail"></div>
      <div class="stick-hint">Déplacer</div>
      <div class="swipe-hint">Glisser pour frapper</div>
      <button class="shot-btn lob" data-shot="lob">LOB</button>
      <button class="shot-btn smash" data-shot="smash">SMASH</button>`;
    parent.appendChild(this.root);
    this.base = this.root.querySelector('.stick-base')!;
    this.knob = this.root.querySelector('.stick-knob')!;
    this.trail = this.root.querySelector('.swipe-trail')!;

    this.root.addEventListener('pointerdown', (e) => this.down(e));
    this.root.addEventListener('pointermove', (e) => this.moveEvent(e));
    this.root.addEventListener('pointerup', (e) => this.up(e));
    this.root.addEventListener('pointercancel', (e) => this.up(e, true));
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) {
      this.gestures.clear();
      this.move.x = 0;
      this.move.z = 0;
      this.base.classList.remove('active');
      this.trail.style.opacity = '0';
    }
  }

  /** Fade the first-time hints once the player has used the controls. */
  private dismissHints(): void {
    this.root.classList.add('used');
  }

  private down(e: PointerEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    const shot = target.dataset?.shot as ShotType | undefined;
    let kind: Gesture['kind'];
    if (shot) kind = shot;
    else if (e.clientX < window.innerWidth * 0.45) {
      if ([...this.gestures.values()].some((g) => g.kind === 'stick')) return;
      kind = 'stick';
    } else kind = 'swipe';
    const g: Gesture = { id: e.pointerId, kind, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY };
    this.gestures.set(e.pointerId, g);
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events have no capturable pointer.
    }
    if (kind === 'stick') {
      this.base.style.left = `${g.x0}px`;
      this.base.style.top = `${g.y0}px`;
      this.base.classList.add('active');
      this.knob.style.transform = 'translate(-50%, -50%)';
    } else if (shot) {
      target.classList.add('pressed');
    }
  }

  private moveEvent(e: PointerEvent): void {
    const g = this.gestures.get(e.pointerId);
    if (!g) return;
    g.x = e.clientX;
    g.y = e.clientY;
    const dx = g.x - g.x0;
    const dy = g.y - g.y0;
    if (g.kind === 'stick') {
      const R = 52;
      const len = Math.hypot(dx, dy);
      const k = len > R ? R / len : 1;
      this.knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
      // Small dead zone, then full speed quickly: easier on a phone than a linear stick.
      const m = Math.min(1, Math.max(0, (len - 6) / (R - 14)));
      this.move.x = len > 0 ? (dx / len) * m : 0;
      this.move.z = len > 0 ? (dy / len) * m : 0;
    } else {
      const len = Math.hypot(dx, dy);
      if (len > TAP) {
        this.trail.style.opacity = '1';
        this.trail.style.left = `${g.x0}px`;
        this.trail.style.top = `${g.y0}px`;
        this.trail.style.width = `${len}px`;
        this.trail.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      }
    }
  }

  private up(e: PointerEvent, cancelled = false): void {
    const g = this.gestures.get(e.pointerId);
    if (!g) return;
    this.gestures.delete(e.pointerId);
    if (g.kind === 'stick') {
      this.move.x = 0;
      this.move.z = 0;
      this.base.classList.remove('active');
      this.dismissHints();
      return;
    }
    this.trail.style.opacity = '0';
    this.root.querySelectorAll('.shot-btn.pressed').forEach((b) => b.classList.remove('pressed'));
    if (cancelled) return;
    const dx = g.x - g.x0;
    const dy = g.y - g.y0;
    const len = Math.hypot(dx, dy);
    const type: ShotType = g.kind === 'swipe' ? 'drive' : (g.kind as ShotType);
    const ref = Math.min(window.innerHeight, 440) * 0.5;
    let angle = 0;
    let power = g.kind === 'swipe' ? 0.5 : 0.7;
    if (len > TAP) {
      // Up the screen is straight ahead; a downward swipe still aims by its sideways part.
      angle = Math.atan2(dx, Math.abs(dy) + 1e-3);
      power = Math.max(0.12, Math.min(1, len / ref));
    }
    this.dismissHints();
    this.onShot({ type, power, angle });
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (!this.enabled) return;
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    const has = (...ks: string[]) => ks.some((x) => this.keys.has(x));
    this.move.x = (has('arrowright', 'd') ? 1 : 0) - (has('arrowleft', 'a', 'q') ? 1 : 0);
    this.move.z = (has('arrowdown', 's') ? 1 : 0) - (has('arrowup', 'w', 'z') ? 1 : 0);
    if (down && !e.repeat) {
      const angle = (has('arrowright', 'd') ? 0.5 : 0) - (has('arrowleft', 'a', 'q') ? 0.5 : 0);
      if (k === ' ' || k === 'j') this.onShot({ type: 'drive', power: e.shiftKey ? 0.9 : 0.55, angle });
      else if (k === 'k') this.onShot({ type: 'lob', power: 0.7, angle });
      else if (k === 'l') this.onShot({ type: 'smash', power: 0.9, angle });
    }
  }
}

export function vibrate(ms: number): void {
  try {
    if ('vibrate' in navigator) navigator.vibrate(ms);
  } catch {
    // Unsupported (iOS Safari) or blocked.
  }
}
