import type { Scoring } from '../rules/scoring';
import type { PlayerId } from '../rules/court';
import { teamOf } from '../rules/court';

const el = (tag: string, cls: string, html = ''): HTMLElement => {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = html;
  return e;
};

/** Minimal broadcast-style overlay: scoreboard, server marker, ball speed and short messages. */
export class Hud {
  readonly root: HTMLElement;
  onPause: () => void = () => {};
  private rows: HTMLElement[] = [];
  private banner: HTMLElement;
  private bannerSub: HTMLElement;
  private speed: HTMLElement;
  private prompt: HTMLElement;
  private fps: HTMLElement;
  private bannerTimer = 0;
  private speedTimer = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud hidden');
    const board = el('div', 'scoreboard');
    for (const name of ['VOUS', 'ADVERSAIRES']) {
      const row = el(
        'div',
        'score-row',
        `<span class="serve-dot"></span><span class="team">${name}</span><span class="sets"></span><span class="games">0</span><span class="points">0</span>`,
      );
      board.appendChild(row);
      this.rows.push(row);
    }
    this.root.appendChild(board);
    this.speed = el('div', 'ball-speed', '<span class="value">0</span><span class="unit">km/h</span>');
    this.root.appendChild(this.speed);
    const pause = el('button', 'pause-btn', '<span></span><span></span>');
    pause.setAttribute('aria-label', 'Pause');
    pause.addEventListener('click', () => this.onPause());
    this.root.appendChild(pause);
    const bannerWrap = el('div', 'banner');
    this.banner = el('div', 'banner-main');
    this.bannerSub = el('div', 'banner-sub');
    bannerWrap.append(this.banner, this.bannerSub);
    this.root.appendChild(bannerWrap);
    this.prompt = el('div', 'prompt');
    this.root.appendChild(this.prompt);
    this.fps = el('div', 'fps');
    this.root.appendChild(this.fps);
    parent.appendChild(this.root);
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }

  updateScore(s: Scoring, server: PlayerId): void {
    for (const t of [0, 1] as const) {
      const row = this.rows[t];
      row.classList.toggle('serving', teamOf(server) === t);
      (row.querySelector('.sets') as HTMLElement).innerHTML = s.completedSets.map((set) => `<i>${set[t]}</i>`).join('');
      (row.querySelector('.games') as HTMLElement).textContent = String(s.games[t]);
      const p = s.pointLabel(t);
      (row.querySelector('.points') as HTMLElement).textContent = p === '' ? '–' : p;
    }
    this.rows[0].parentElement!.classList.toggle('tiebreak', s.tiebreak);
  }

  /** Shows a message in the middle of the screen for a moment. */
  flash(main: string, sub = '', seconds = 1.8): void {
    this.banner.textContent = main;
    this.bannerSub.textContent = sub;
    this.banner.parentElement!.classList.add('show');
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.parentElement!.classList.remove('show'), seconds * 1000);
  }

  /** Names shown on the two scoreboard rows. */
  setNames(mine: string, theirs: string): void {
    (this.rows[0].querySelector('.team') as HTMLElement).textContent = mine.toUpperCase();
    (this.rows[1].querySelector('.team') as HTMLElement).textContent = theirs.toUpperCase().slice(0, 14);
  }

  /** Removes the centre message at once (before a full-screen panel opens). */
  clearBanner(): void {
    window.clearTimeout(this.bannerTimer);
    this.banner.parentElement!.classList.remove('show');
  }

  setSpeed(kmh: number): void {
    (this.speed.querySelector('.value') as HTMLElement).textContent = String(Math.round(kmh));
    this.speed.classList.add('show');
    window.clearTimeout(this.speedTimer);
    this.speedTimer = window.setTimeout(() => this.speed.classList.remove('show'), 2500);
  }

  setPrompt(text: string | null): void {
    this.prompt.textContent = text ?? '';
    this.prompt.classList.toggle('show', !!text);
  }

  setFps(text: string | null): void {
    this.fps.textContent = text ?? '';
    this.fps.style.display = text ? 'block' : 'none';
  }
}
