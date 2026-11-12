import { IDEAL_START, OVER_START } from '../core/shots';
import type { ShotType } from '../core/types';

interface Gesture {
  id: number;
  kind: 'stick' | 'button';
  x0: number;
  y0: number;
}

const KEY_SHOTS: Record<string, ShotType> = { ' ': 'drive', j: 'drive', k: 'lob', l: 'smash' };

/**
 * Touch controls: a floating joystick on the left of the screen to move, and three buttons on
 * the right to hit — FRAPPE, LOB and SMASH. Holding a button fills the power gauge; the ball is
 * struck when it comes within reach, at the power reached when the button was released (or
 * reached at contact if it is still held). While a button is down the joystick aims the shot.
 * Keyboard works too.
 */
export class TouchControls {
  /** Movement request: x right, z towards the camera, each -1..1. */
  readonly move = { x: 0, z: 0 };
  /** A shot button went down. */
  onPress: (type: ShotType) => void = () => {};
  /** The shot button in use was released. */
  onRelease: () => void = () => {};
  /** DOM root (exposed for tests and tooling). */
  readonly root: HTMLElement;
  private base: HTMLElement;
  private knob: HTMLElement;
  private buttons: Record<ShotType, HTMLElement>;
  private gestures = new Map<number, Gesture>();
  private keys = new Set<string>();
  private enabled = false;
  /** The button currently held: pointer id (or key name) and shot. */
  private active: { by: number | string; type: ShotType } | null = null;
  private ringOn: ShotType | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'controls hidden';
    this.root.innerHTML = `
      <div class="stick-base"><div class="stick-knob"></div></div>
      <div class="stick-hint">Déplacer · viser pendant la frappe</div>
      <div class="shot-hint">Maintenez pour frapper plus fort</div>
      <button class="shot-btn lob" data-shot="lob">LOB</button>
      <button class="shot-btn smash" data-shot="smash">SMASH</button>
      <button class="shot-btn drive" data-shot="drive">FRAPPE</button>`;
    parent.appendChild(this.root);
    this.base = this.root.querySelector('.stick-base')!;
    this.knob = this.root.querySelector('.stick-knob')!;
    this.buttons = {
      drive: this.root.querySelector('.shot-btn.drive')!,
      lob: this.root.querySelector('.shot-btn.lob')!,
      smash: this.root.querySelector('.shot-btn.smash')!,
    };

    this.root.addEventListener('pointerdown', (e) => this.down(e));
    this.root.addEventListener('pointermove', (e) => this.moveEvent(e));
    this.root.addEventListener('pointerup', (e) => this.up(e));
    this.root.addEventListener('pointercancel', (e) => this.up(e));
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
    window.addEventListener('blur', () => this.dropAll());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) this.dropAll();
  }

  /** Releases everything: the menu opened, or the page lost focus with a finger still down. */
  private dropAll(): void {
    this.gestures.clear();
    this.keys.clear();
    this.move.x = 0;
    this.move.z = 0;
    this.base.classList.remove('active');
    if (this.active) {
      this.active = null;
      this.onRelease();
    }
    for (const b of Object.values(this.buttons)) b.classList.remove('pressed');
    this.setGauge(null, 0);
  }

  /** Greys the shot buttons while a press would do nothing (between points). */
  setIdle(idle: boolean): void {
    this.root.classList.toggle('idle', idle);
  }

  /** Lights SMASH when the ball can be taken overhead; otherwise the button plays a normal shot. */
  setSmashReady(ready: boolean): void {
    this.buttons.smash.classList.toggle('ready', ready);
  }

  /** Draws the power gauge as a ring around the button being charged. */
  setGauge(type: ShotType | null, g: number): void {
    if (this.ringOn && this.ringOn !== type) {
      const old = this.buttons[this.ringOn];
      old.classList.remove('charging', 'ideal', 'over');
      old.style.removeProperty('--g');
    }
    this.ringOn = type;
    if (!type) return;
    const b = this.buttons[type];
    b.classList.add('charging');
    b.classList.toggle('ideal', g >= IDEAL_START && g <= OVER_START);
    b.classList.toggle('over', g > OVER_START);
    b.style.setProperty('--g', g.toFixed(3));
  }

  /** Fade the first-time hints once the player has used the controls. */
  private dismissHints(): void {
    this.root.classList.add('used');
  }

  private pressShot(by: number | string, type: ShotType): void {
    this.active = { by, type };
    for (const [t, b] of Object.entries(this.buttons)) b.classList.toggle('pressed', t === type);
    this.onPress(type);
  }

  private releaseShot(by: number | string): void {
    if (!this.active || this.active.by !== by) return;
    this.buttons[this.active.type].classList.remove('pressed');
    this.active = null;
    this.root.classList.add('hit-once');
    this.onRelease();
  }

  private down(e: PointerEvent): void {
    if (!this.enabled) return;
    e.preventDefault();
    const target = (e.target as HTMLElement).closest?.('[data-shot]') as HTMLElement | null;
    const shot = target?.dataset.shot as ShotType | undefined;
    if (shot) {
      this.gestures.set(e.pointerId, { id: e.pointerId, kind: 'button', x0: e.clientX, y0: e.clientY });
      try {
        target!.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events have no capturable pointer.
      }
      this.pressShot(e.pointerId, shot);
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
    this.releaseShot(e.pointerId);
  }

  private key(e: KeyboardEvent, down: boolean): void {
    if (!this.enabled) return;
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    const has = (...ks: string[]) => ks.some((x) => this.keys.has(x));
    this.move.x = (has('arrowright', 'd') ? 1 : 0) - (has('arrowleft', 'a', 'q') ? 1 : 0);
    this.move.z = (has('arrowdown', 's') ? 1 : 0) - (has('arrowup', 'w', 'z') ? 1 : 0);
    const shot = KEY_SHOTS[k];
    if (!shot) return;
    e.preventDefault();
    if (down && !e.repeat) this.pressShot(`key:${k}`, shot);
    else if (!down) this.releaseShot(`key:${k}`);
  }
}

export function vibrate(ms: number): void {
  try {
    if ('vibrate' in navigator) navigator.vibrate(ms);
  } catch {
    // Unsupported (iOS Safari) or blocked.
  }
}
