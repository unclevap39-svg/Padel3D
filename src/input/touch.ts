import type { ShotIntent, ShotType } from '../core/types';

interface Gesture {
  id: number;
  kind: 'stick' | 'button';
  x0: number;
  y0: number;
}

/** Shot played by each button: fixed pace, aimed with the joystick. */
const SHOT_POWER: Record<ShotType, number> = { drive: 0.62, lob: 0.7, smash: 0.92 };
/** Full sideways stick aims this far from straight ahead (radians). */
const AIM_ANGLE = 0.62;

/**
 * Touch controls: a floating joystick on the left of the screen to move, and three buttons on
 * the right to hit — FRAPPE, LOB and SMASH. The ball goes where the joystick points at the
 * moment the button is pressed (straight ahead when it is released). Keyboard works too.
 */
export class TouchControls {
  /** Movement request: x right, z towards the camera, each -1..1. */
  readonly move = { x: 0, z: 0 };
  onShot: (intent: ShotIntent) => void = () => {};
  /** DOM root (exposed for tests and tooling). */
  readonly root: HTMLElement;
  private base: HTMLElement;
  private knob: HTMLElement;
  private gestures = new Map<number, Gesture>();
  private keys = new Set<string>();
  private enabled = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'controls hidden';
    this.root.innerHTML = `
      <div class="stick-base"><div class="stick-knob"></div></div>
      <div class="stick-hint">Déplacer et viser</div>
      <button class="shot-btn lob" data-shot="lob">LOB</button>
      <button class="shot-btn smash" data-shot="smash">SMASH</button>
      <button class="shot-btn drive" data-shot="drive">FRAPPE</button>`;
    parent.appendChild(this.root);
    this.base = this.root.querySelector('.stick-base')!;
    this.knob = this.root.querySelector('.stick-knob')!;

    this.root.addEventListener('pointerdown', (e) => this.down(e));
    this.root.addEventListener('pointermove', (e) => this.moveEvent(e));
    this.root.addEventListener('pointerup', (e) => this.up(e));
    this.root.addEventListener('pointercancel', (e) => this.up(e));
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
      this.root.querySelectorAll('.shot-btn.pressed').forEach((b) => b.classList.remove('pressed'));
    }
  }

  /** Fade the first-time hint once the player has used the controls. */
  private dismissHints(): void {
    this.root.classList.add('used');
  }

  private down(e: PointerEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    const shot = target.dataset?.shot as ShotType | undefined;
    if (shot) {
      // Buttons act on press, not release: timing a shot must feel immediate.
      this.gestures.set(e.pointerId, { id: e.pointerId, kind: 'button', x0: e.clientX, y0: e.clientY });
      target.classList.add('pressed');
      this.dismissHints();
      this.onShot({ type: shot, power: SHOT_POWER[shot], angle: this.move.x * AIM_ANGLE });
      return;
    }
    // Anywhere else on the left two thirds of the screen: the joystick appears under the thumb.
    if (e.clientX > window.innerWidth * 0.66) return;
    if ([...this.gestures.values()].some((g) => g.kind === 'stick')) return;
    this.gestures.set(e.pointerId, { id: e.pointerId, kind: 'stick', x0: e.clientX, y0: e.clientY });
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events have no capturable pointer.
    }
    this.base.style.left = `${e.clientX}px`;
    this.base.style.top = `${e.clientY}px`;
    this.base.classList.add('active');
    this.knob.style.transform = 'translate(-50%, -50%)';
  }

  private moveEvent(e: PointerEvent): void {
    const g = this.gestures.get(e.pointerId);
    if (!g || g.kind !== 'stick') return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    const R = 52;
    const len = Math.hypot(dx, dy);
    const k = len > R ? R / len : 1;
    this.knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
    // Small dead zone, then full speed quickly: easier on a phone than a linear stick.
    const m = Math.min(1, Math.max(0, (len - 6) / (R - 14)));
    this.move.x = len > 0 ? (dx / len) * m : 0;
    this.move.z = len > 0 ? (dy / len) * m : 0;
  }

  private up(e: PointerEvent): void {
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
    if (![...this.gestures.values()].some((x) => x.kind === 'button')) {
      this.root.querySelectorAll('.shot-btn.pressed').forEach((b) => b.classList.remove('pressed'));
    }
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
      const angle = this.move.x * AIM_ANGLE;
      if (k === ' ' || k === 'j') this.onShot({ type: 'drive', power: SHOT_POWER.drive, angle });
      else if (k === 'k') this.onShot({ type: 'lob', power: SHOT_POWER.lob, angle });
      else if (k === 'l') this.onShot({ type: 'smash', power: SHOT_POWER.smash, angle });
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
