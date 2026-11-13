import {
  CATALOG,
  type ItemKind,
  MODES,
  type ModeId,
  type Profile,
  TOURNAMENT_ROUNDS,
  buyItem,
  equipItem,
  itemById,
  levelOf,
  modeById,
  saveProfile,
  today,
} from '../core/profile';
import { type Settings, saveSettings } from '../core/settings';
import type { Difficulty } from '../core/types';
import type { LeaderRow, LobbyState, OnlineProfile, QueueMode } from '../net/lobby';
import { isStandalone } from './menu';

/** Screens of the home. `modes` is the mode picker opened from the lobby. */
export type HomeTab = 'play' | 'modes' | 'online' | 'shop' | 'locker' | 'profile' | 'settings';

export interface HomeCallbacks {
  onPlay: (mode: ModeId) => void;
  onSettingsChanged: () => void;
  /** Show these items on the hero character and the court (equipped or being tried on). */
  onLoadout: (loadout: Record<ItemKind, string>) => void;
  onTab: (tab: HomeTab) => void;
  /** Doubles or singles chosen: the partner joins or leaves the stage. */
  onFormat: (format: 'double' | 'single') => void;
  onHelp: () => void;
  onInstall: () => void;
  /** Online lobby actions. */
  onQueue: (mode: QueueMode) => void;
  onInvite: (kind: '1' | '2') => void;
  onJoin: (code: string) => void;
  onCancelOnline: () => void;
  onBoard: (kind: '1' | '2') => Promise<LeaderRow[] | null>;
}

/** Coin: a steel disc engraved with the seam of the ball. */
const PIECE =
  '<svg class="piece" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="#c9d0d8" stroke="#5e6977" stroke-width="1"/><circle cx="8" cy="8" r="5" fill="none" stroke="#7b8592" stroke-width=".8"/><path d="M3.4 5.2c2.6 1.2 2.6 4.4 0 5.6M12.6 5.2c-2.6 1.2-2.6 4.4 0 5.6" fill="none" stroke="#49525e" stroke-width="1.1" stroke-linecap="round"/></svg>';
const CHEVRON = '<svg class="chev" viewBox="0 0 9 12" aria-hidden="true"><path d="M2 1.2l5 4.800-5 4.800" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const CHECK = '<svg viewBox="0 0 9 9" aria-hidden="true"><path d="M1.6 4.700l2 2 3.800-4.200" fill="none" stroke="#141a05" stroke-width="1.700"/></svg>';
const GEAR =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="2.8"/><path d="M10 1.800v2.600M10 15.600v2.600M1.800 10h2.600M15.600 10h2.600M4.200 4.200l1.850 1.850M13.950 13.950l1.850 1.850M15.800 4.200l-1.850 1.850M6.050 13.950L4.200 15.800"/><circle cx="10" cy="10" r="5.9"/></svg>';
const BACK = '<svg viewBox="0 0 10 16" aria-hidden="true"><path d="M8.200 1.400L2 8l6.200 6.600" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const TROPHY =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1.500A3.500 3.500 0 0 0 7.500 11M17 6h3v1.500a3.500 3.500 0 0 1-3.500 3.500M12 14v4M8.500 20h7" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The main action: a felt ball with its two seams. */
const balle = (label: string, attrs: string, small = false): string =>
  `<button class="balle${small ? ' petite' : ''}" ${attrs}><svg class="couture" viewBox="0 0 180 56" preserveAspectRatio="none" aria-hidden="true"><path d="M10 -4C27 14 27 42 10 60M170 -4C153 14 153 42 170 60"/></svg><span>${label}</span></button>`;

const TABS: Array<[HomeTab, string]> = [
  ['play', 'Jouer'],
  ['online', 'En ligne'],
  ['locker', 'Vestiaire'],
  ['shop', 'Boutique'],
  ['profile', 'Carrière'],
];

const KINDS: Array<[ItemKind, string, string]> = [
  ['character', 'Personnage', 'Personnages'],
  ['racket', 'Raquette', 'Raquettes'],
  ['outfit', 'Tenue', 'Tenues'],
  ['court', 'Terrain', 'Terrains'],
  ['ball', 'Balle', 'Balles'],
];

const DIFFS: Array<[Difficulty, string]> = [
  ['easy', 'Facile'],
  ['medium', 'Moyen'],
  ['hard', 'Difficile'],
];

/** Rarity is told by the number of tightened bolts, and a tint on the pane's top edge. */
const RARITY: Record<string, { cls: string; bolts: number }> = {
  standard: { cls: 'r-commun', bolts: 1 },
  commun: { cls: 'r-commun', bolts: 1 },
  rare: { cls: 'r-rare', bolts: 2 },
  épique: { cls: 'r-epique', bolts: 3 },
  légendaire: { cls: 'r-legendaire', bolts: 4 },
};

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const fmt = (n: number) => n.toLocaleString('fr-FR');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const bolts = (rarity: string, withName: boolean): string => {
  const r = RARITY[rarity] ?? RARITY.commun;
  const dots = [0, 1, 2, 3].map((i) => `<i${i < r.bolts ? ' class="s"' : ''}></i>`).join('');
  return `<span class="rarete ${r.cls}"><span class="b4">${dots}</span>${withName ? rarity : ''}</span>`;
};

/** Drawing of an item in its own colours. */
function itemArt(kind: ItemKind, color: number, color2: number | undefined, cls: string, shape = 'round', bald = false): string {
  const c = hex(color);
  const c2 = hex(color2 ?? 0x14161a);
  if (kind === 'character') {
    // Head and shoulders: skin tone, hair colour.
    const hair = bald ? '' : `<path d="M13.500 23c-1.500-13 5-19 12.500-19s14 6 12.500 19c-1.500-6-5-9.500-12.500-9.500S15 17 13.500 23z" fill="${c}" stroke="rgba(255,255,255,.3)" stroke-width=".8"/>`;
    return `<svg class="${cls} haute" viewBox="0 0 52 66" aria-hidden="true">
      <path d="M4 66c0-13 8-19 22-19s22 6 22 19z" fill="#e9edf2" stroke="rgba(255,255,255,.45)" stroke-width="1.2"/>
      <rect x="21" y="36" width="10" height="13" rx="4" fill="${c2}"/>
      <ellipse cx="26" cy="24" rx="12" ry="15" fill="${c2}" stroke="rgba(0,0,0,.25)" stroke-width=".8"/>${hair}</svg>`;
  }
  if (kind === 'racket') {
    // Outline of the head: round, teardrop (wider towards the top) or diamond.
    const k = shape === 'teardrop' ? 0.16 : shape === 'diamond' ? 0.3 : 0;
    const ry = shape === 'diamond' ? 28 : 26.5;
    let d = '';
    for (let i = 0; i <= 36; i++) {
      const t = (i / 36) * Math.PI * 2;
      d += `${i ? 'L' : 'M'}${(26 + 23.2 * Math.sin(t) * (1 + k * Math.cos(t))).toFixed(1)} ${(28.5 - ry * Math.cos(t)).toFixed(1)}`;
    }
    return `<svg class="${cls} haute" viewBox="0 0 52 100" aria-hidden="true">
      <path d="M9.500 44L22.400 66h7.200L42.500 44z" fill="${c2}" stroke="rgba(255,255,255,.34)" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="${d}z" fill="${c2}" stroke="rgba(255,255,255,.42)" stroke-width="1.4"/>
      <rect x="22.4" y="63" width="7.2" height="32" rx="2" fill="#dfe3e8"/><path d="M22.400 69.500h7.200M22.400 74.500h7.200M22.400 79.500h7.200M22.400 84.500h7.200M22.400 89.500h7.200" stroke="#8d96a2" stroke-width="1"/>
      <rect x="21.2" y="93" width="9.6" height="5" rx="1.6" fill="#1a212b" stroke="#98a2af" stroke-width=".6"/>
      <path d="M20.600 54.500L26 63.200l5.400-8.700z" fill="#070b13" stroke="rgba(255,255,255,.25)" stroke-width=".7"/>
      <g fill="rgba(128,138,150,.55)"><circle cx="20" cy="14" r="1.25"/><circle cx="26" cy="14" r="1.25"/><circle cx="14" cy="21" r="1.25"/><circle cx="20" cy="21" r="1.25"/><circle cx="26" cy="21" r="1.25"/><circle cx="32" cy="21" r="1.25"/><circle cx="11" cy="28" r="1.25"/><circle cx="17" cy="28" r="1.25"/><circle cx="23" cy="28" r="1.25"/><circle cx="29" cy="28" r="1.25"/><circle cx="14" cy="35" r="1.25"/><circle cx="20" cy="35" r="1.25"/><circle cx="26" cy="35" r="1.25"/><circle cx="32" cy="35" r="1.25"/><circle cx="20" cy="42" r="1.25"/><circle cx="26" cy="42" r="1.25"/></g>
      <path d="M34.500 8.500C46.500 16 46.500 41 34.500 48.500" fill="none" stroke="${c}" stroke-width="4.2" stroke-linecap="round"/></svg>`;
  }
  if (kind === 'outfit') {
    return `<svg class="${cls}" viewBox="0 0 52 60" aria-hidden="true"><path d="M17 3L3 10l4 9.200 6-2.400v17h26v-17l6 2.400 4-9.200L35 3c-1.800 4.800-16.200 4.800-18 0z" fill="${c}" stroke="rgba(255,255,255,.5)" stroke-width="1.4" stroke-linejoin="round"/><path d="M14 37h24l3 19H28l-2-9-2 9H11z" fill="${hex(color2 ?? 0x1b2740)}" stroke="rgba(255,255,255,.4)" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
  }
  if (kind === 'court') {
    return `<svg class="${cls}" viewBox="0 0 52 60" aria-hidden="true"><path d="M12 6h28l8 48H4z" fill="${c}" stroke="#f5f7f8" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 30h36M26 16v28M10.300 16h31.400M6.300 44h39.400" stroke="#f5f7f8" stroke-width="1.2" fill="none"/></svg>`;
  }
  return `<svg class="${cls}" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="22" fill="${c}" stroke="rgba(0,0,0,.35)" stroke-width="1"/><path d="M9.500 11c10 6 10 24 0 30M42.500 11c-10 6-10 24 0 30" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>`;
}

/**
 * The game's home, in the manner of a lobby: the player's team stands on court in the live 3D
 * scene; a tab bar runs along the top, the mode and the big play button sit bottom right, the
 * day's challenge and the tournament on the left. The panels are panes of glass in steel
 * frames, like the walls of the court.
 */
export class Home {
  private root: HTMLElement;
  private body: HTMLElement;
  private top: HTMLElement;
  private plates: HTMLElement[];
  private settings: Settings;
  private profile: Profile;
  private cb: HomeCallbacks;
  private tab: HomeTab = 'play';
  private mode: ModeId;
  private kind: ItemKind = 'character';
  /** Item highlighted in the shop or locker (tried on, not necessarily owned). */
  private selected: string | null = null;
  private lobby: LobbyState = { kind: 'idle' };
  private online: OnlineProfile | null = null;
  private board: { kind: '1' | '2'; rows: LeaderRow[] | null; loading: boolean } | null = null;
  private timer = 0;

  constructor(parent: HTMLElement, settings: Settings, profile: Profile, cb: HomeCallbacks) {
    this.settings = settings;
    this.profile = profile;
    this.cb = cb;
    this.mode = profile.lastMode;
    this.root = document.createElement('div');
    this.root.className = 'home hidden';
    this.root.innerHTML =
      '<header class="barre"></header><main class="home-body"></main><div class="repere vous"></div><div class="repere partenaire"></div>';
    parent.appendChild(this.root);
    this.top = this.root.querySelector('.barre')!;
    this.body = this.root.querySelector('.home-body')!;
    this.plates = [this.root.querySelector('.repere.vous')!, this.root.querySelector('.repere.partenaire')!];
    this.root.addEventListener('click', (e) => this.click(e));
    this.root.addEventListener('input', (e) => this.input(e));
    this.root.addEventListener('change', (e) => this.change(e));
    this.root.addEventListener('submit', (e) => this.submit(e));
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
    if (on) {
      this.selected = null;
      if (this.tab === 'modes') this.tab = 'play';
      this.render();
      this.cb.onLoadout(this.profile.equipped);
      this.cb.onFormat(this.profile.format);
      this.cb.onTab(this.tab);
    }
  }

  /** Shows a section directly (used when a match ends or an invitation link is opened). */
  open(tab: HomeTab): void {
    this.tab = tab;
    if (this.visible) {
      this.cb.onTab(tab);
      this.render();
    }
  }

  /**
   * Where the players stand on screen (CSS pixels, top of the head), so that their name tags
   * follow them. `null` hides a tag.
   */
  setAnchors(points: Array<{ x: number; y: number } | null>): void {
    for (let i = 0; i < this.plates.length; i++) {
      const el = this.plates[i];
      const pt = this.tab === 'play' ? points[i] : null;
      if (!pt) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }
      if (el.style.display === 'none') el.style.display = '';
      // When the two players stand close on screen, the partner's tag slides aside so that the
      // two never cover each other.
      let x = pt.x;
      const me = points[0];
      if (i === 1 && me && Math.abs(pt.y - me.y) < 26) {
        const room = (this.plates[0].offsetWidth + el.offsetWidth) / 2 + 6;
        if (Math.abs(x - me.x) < room) x = me.x + (x >= me.x ? room : -room);
      }
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(pt.y)}px) translate(-50%, -100%)`;
    }
  }

  /** Online lobby state changed: searching, waiting for a friend, connecting, error… */
  setLobby(state: LobbyState, profile: OnlineProfile | null): void {
    this.lobby = state;
    this.online = profile ?? this.online;
    if (state.kind !== 'idle') this.board = null;
    window.clearInterval(this.timer);
    if (state.kind === 'searching') {
      this.timer = window.setInterval(() => {
        const el = this.body.querySelector('.search-time');
        if (el) el.textContent = this.elapsed(state.since);
      }, 1000);
    }
    if (this.visible && this.tab === 'online') this.render();
  }

  private elapsed(since: number): string {
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /** Re-draw after coins, level or settings changed elsewhere. */
  refresh(): void {
    if (this.visible) this.render();
  }

  private setTab(tab: HomeTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.selected = null;
    this.cb.onLoadout(this.profile.equipped);
    this.cb.onTab(tab);
    this.render();
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering

  private render(): void {
    const p = this.profile;
    const lv = levelOf(p.xp);
    const arc = (91.1 * lv.into) / lv.span;
    const ring = `<span class="anneau"><svg viewBox="0 0 34 34" aria-hidden="true"><circle class="fond" cx="17" cy="17" r="14.5"/><circle class="arc" cx="17" cy="17" r="14.5" stroke-dasharray="${arc.toFixed(1)} 91.1"/></svg><b>${lv.level}</b></span>`;
    const purse = `<div class="bourse" title="Pièces gagnées en jouant" aria-label="${fmt(p.coins)} pièces">${PIECE}<b>${fmt(p.coins)}</b></div>`;
    if (this.tab === 'modes') {
      this.top.innerHTML = `
        <button class="outil retour" data-tab="play" aria-label="Retour au salon">${BACK}</button>
        <div class="fil"><span class="onglet">Jouer</span><span class="onglet actif" aria-current="page">Mode de jeu</span></div>
        <span class="pousse"></span>
        <span class="profil" aria-label="Niveau ${lv.level}">${ring}</span>${purse}`;
    } else {
      // A little ball on the shop tab when something new can be afforded.
      const canBuy = CATALOG.some((i) => !p.owned.includes(i.id) && i.price <= p.coins);
      const tabs = TABS.map(([id, label]) => {
        const on = this.tab === id;
        const dot = id === 'shop' && canBuy && !on ? '<i class="point" aria-label="objets à votre portée"></i>' : '';
        return `<button class="onglet${on ? ' actif' : ''}" data-tab="${id}" ${on ? 'aria-current="page"' : ''}>${label}${dot}</button>`;
      }).join('');
      this.top.innerHTML = `
        <nav class="onglets" aria-label="Menu principal">${tabs}</nav>
        <span class="pousse"></span>
        <button class="profil" data-tab="profile" aria-label="${esc(p.name)}, niveau ${lv.level}">${ring}
          <span class="profil-t"><b class="pc-name">${esc(p.name)}</b><small>${fmt(lv.into)} / ${fmt(lv.span)} XP</small></span></button>
        ${purse}
        <button class="outil${this.tab === 'settings' ? ' actif' : ''}" data-tab="settings" aria-label="Réglages et aide">${GEAR}</button>`;
    }
    let html = '';
    if (this.tab === 'play') html = this.renderLobby();
    else if (this.tab === 'modes') html = this.renderModes();
    else if (this.tab === 'online') html = this.renderOnline();
    else if (this.tab === 'shop') html = this.renderItems(false);
    else if (this.tab === 'locker') html = this.renderItems(true);
    else if (this.tab === 'profile') html = this.renderProfile();
    else html = this.renderSettings();
    this.root.dataset.view = this.tab;
    this.body.innerHTML = html;
    this.plates[0].innerHTML = `<i class="bille"></i>Vous <small>${esc(p.name)}</small>`;
    this.plates[1].innerHTML = '<i class="ia"></i>IA <small>partenaire</small>';
  }

  /** Difficulty actually played in a mode, and whether the player may change it. */
  private difficultyOf(mode: ReturnType<typeof modeById>): { value: Difficulty; fixed: boolean } {
    if (mode.id === 'tournament') return { value: TOURNAMENT_ROUNDS[this.profile.tournamentRound].difficulty, fixed: true };
    if (mode.difficulty) return { value: mode.difficulty, fixed: true };
    return { value: this.settings.difficulty, fixed: false };
  }

  private rewardOf(mode: ReturnType<typeof modeById>): string {
    if (mode.id === 'daily' && this.profile.dailyDone === today()) return '<span class="detail">Bonus du jour obtenu</span>';
    return `<span class="detail">Victoire</span><span class="gain"><b>+${mode.winCoins}</b>${PIECE}</span>`;
  }

  private renderLobby(): string {
    const p = this.profile;
    const mode = modeById(this.mode);
    const diff = this.difficultyOf(mode);
    const daily = modeById('daily');
    const done = p.dailyDone === today();
    const round = p.tournamentRound;
    const rounds = TOURNAMENT_ROUNDS.map((x, i) => {
      const cls = i < round ? ' gagne' : i === round ? ' encours' : '';
      return `<span class="tour${cls}"><i>${i < round ? CHECK : ''}</i>${x.name.replace(/[- ]?(de )?finale$/i, '') || 'Finale'}</span>`;
    }).join('');
    const sub = mode.id === 'tournament' ? TOURNAMENT_ROUNDS[round].name : mode.tagline;
    return `
      <aside class="mur gauche" aria-label="À faire">
        <button class="vitre carte defi${done ? ' fait' : ''}" data-pick="daily">
          <span class="rang"><span class="sur">Défi du jour</span>
            <span class="etat">${done ? `Relevé<svg class="coche" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="#d4f03c"/><path d="M4.400 8.300l2.400 2.400 4.800-5" fill="none" stroke="#141a05" stroke-width="1.9"/></svg>` : '<i class="cercle"></i>'}</span></span>
          <span class="nom"><strong class="titre">Tie-break</strong><span class="detail">${DIFFS.find((d) => d[0] === daily.difficulty)![1].toLowerCase()}</span></span>
          <span class="pied"><span class="gain"><b>+${daily.winCoins}</b>${PIECE}</span><span class="aller">${done ? 'Rejouer' : 'Relever'}${CHEVRON}</span></span>
        </button>
        <button class="vitre carte tournoi" data-pick="tournament">
          <span class="rang"><span class="sur">Tournoi</span><span class="etat">Tour ${round + 1} / 3</span></span>
          <span class="tours" style="--fait:${round}">${rounds}</span>
        </button>
        <button class="vitre carte enligne" data-tab="online">
          <svg class="picto" viewBox="0 0 30 30" fill="none" stroke="#f5f7f8" stroke-width="1.5" aria-hidden="true"><path d="M5.500 20.500C8 8.500 22 8.500 24.500 20.500" stroke-dasharray="2.2 2.6"/><circle cx="5.5" cy="22.5" r="3"/><circle cx="24.5" cy="22.5" r="3"/><circle cx="15" cy="9.2" r="2.6" fill="#d4f03c" stroke="none"/></svg>
          <span class="txt"><strong class="titre">En ligne</strong><span class="detail">Classique · Classé</span></span>${CHEVRON}
        </button>
      </aside>
      <section class="mur droite" aria-label="Lancer un match">
        <button class="vitre mode" data-tab="modes" aria-label="Changer de mode de jeu">
          <span class="rang"><span class="sur">Mode</span><span class="changer"><span>Changer</span>${CHEVRON}</span></span>
          <strong class="titre">${mode.name}</strong>
          <span class="regles">${sub}<br><b>${p.format === 'double' ? 'Double 2v2' : 'Simple 1v1'}</b><i></i><b>${DIFFS.find((d) => d[0] === diff.value)![1]}</b></span>
          <span class="gainligne">${this.rewardOf(mode)}</span>
        </button>
        ${balle('Jouer', 'data-act="play"')}
      </section>`;
  }

  private renderModes(): string {
    const p = this.profile;
    const mode = modeById(this.mode);
    const diff = this.difficultyOf(mode);
    const signs: Partial<Record<ModeId, string>> = {
      quick: '<span class="num">1</span><span class="unite">set</span>',
      full: '<span class="num">2</span><span class="unite">sets <br>gagnants</span>',
      tiebreak: '<span class="num">7</span><span class="unite">premier <br>à sept</span>',
      tournament: '<span class="num">3</span><span class="unite">tours</span>',
      training:
        '<svg class="picto" viewBox="0 0 30 30" fill="none" stroke="#f5f7f8" stroke-width="1.6" aria-hidden="true"><path d="M2 8.800h26M15 8.800V29"/><circle cx="22" cy="17.5" r="3.4" fill="#d4f03c" stroke="none"/></svg><span class="unite">sans <br>pression</span>',
      daily:
        '<svg class="picto" viewBox="0 0 30 30" fill="none" stroke="#f5f7f8" stroke-width="1.6" aria-hidden="true"><path d="M3.800 7.800h22.400v19.400H3.800zM3.800 13h22.400M9.500 3.600v6M20.500 3.600v6"/><circle cx="15" cy="20" r="3.4" fill="#d4f03c" stroke="none"/></svg><span class="unite">bonus <br>quotidien</span>',
    };
    const cards = MODES.filter((m) => !m.hidden)
      .map((m) => {
        const on = m.id === this.mode;
        let mark = '<i class="bille"></i>';
        if (m.id === 'tournament') {
          mark = `<span class="trois" aria-label="Tour ${p.tournamentRound + 1} sur 3">${[0, 1, 2].map((i) => `<i class="${i < p.tournamentRound ? 'g' : i === p.tournamentRound ? 'c' : ''}"></i>`).join('')}</span>`;
        }
        return `<button class="vitre carte-mode${on ? ' choisi' : ''}" data-mode="${m.id}" role="radio" aria-checked="${on}">
          <span class="tete"><strong class="titre">${m.name}</strong>${mark}</span>
          <span class="bas"><span class="signe">${signs[m.id] ?? ''}</span></span></button>`;
      })
      .join('');
    const seg = (attr: string, value: string, label: string, on: boolean, disabled = false) =>
      `<button data-${attr}="${value}" class="${on ? 'choisi' : ''}" aria-pressed="${on}" ${disabled ? 'disabled' : ''}>${label}</button>`;
    return `
      <section class="mur modes">
        <div class="reglages">
          <div class="groupe format"><span class="sur">Format</span>
            <div class="segments" role="group" aria-label="Format">${seg('format', 'double', 'Double 2v2', p.format === 'double')}${seg('format', 'single', 'Simple 1v1', p.format === 'single')}</div></div>
          <div class="groupe difficulte"><span class="sur">Difficulté${diff.fixed ? ' <em>fixée par le mode</em>' : ''}</span>
            <div class="segments${diff.fixed ? ' fige' : ''}" role="group" aria-label="Difficulté">${DIFFS.map(([d, label]) => seg('diff', d, label, diff.value === d, diff.fixed)).join('')}</div></div>
        </div>
        <p class="resume">${mode.detail}</p>
        <div class="grille" role="radiogroup" aria-label="Mode de jeu">${cards}</div>
        <div class="vitre sans-boulons pied-modes">
          <span class="victoire">${this.rewardOf(mode)}</span>
          ${balle('Valider', 'data-tab="play"', true)}
        </div>
      </section>`;
  }

  private renderOnline(): string {
    const st = this.lobby;
    const o = this.online;
    const ratings = o ? `Classement · 1v1 <b>${o.r1}</b> · 2v2 <b>${o.r2}</b>` : 'Affrontez d’autres joueurs en direct';
    const head = `<div class="rayon-tete"><span class="sur">En ligne</span><small>${ratings}</small></div>`;
    const labels: Record<QueueMode, string> = { c2: 'Classique 2v2', r2: 'Classé 2v2', c1: 'Classique 1v1', r1: 'Classé 1v1' };
    const wall = (inner: string) => `<section class="mur large ligne">${head}${inner}</section>`;
    if (st.kind === 'searching') {
      return wall(`
        <div class="vitre attente">
          <div class="pulse" aria-hidden="true"></div>
          <h2 class="titre">Recherche d’un adversaire</h2>
          <p>${labels[st.mode]} · <span class="search-time">${this.elapsed(st.since)}</span></p>
          <p class="hint">Le match démarre dès qu’un autre joueur cherche le même mode. Peu de monde en ligne ? Invitez un ami avec un code.</p>
          <button class="verre-btn" data-act="cancel-online">Annuler</button>
        </div>`);
    }
    if (st.kind === 'hosting') {
      return wall(`
        <div class="vitre attente">
          <h2 class="titre">Code de la partie</h2>
          <div class="room-code" aria-label="Code">${st.code.split('').map((c) => `<span>${c}</span>`).join('')}</div>
          <p>${st.mode === 'i1' ? 'Un contre un' : 'Double : chacun joue avec un partenaire IA'} · en attente de votre ami…</p>
          <div class="actions">
            ${balle('Inviter', `data-act="share" data-code="${st.code}"`, true)}
            <button class="verre-btn" data-act="cancel-online">Annuler</button>
          </div>
        </div>`);
    }
    if (st.kind === 'joining' || st.kind === 'connecting') {
      const who = st.kind === 'connecting' && st.opponent ? `Connexion à ${esc(st.opponent)}…` : 'Connexion…';
      return wall(`
        <div class="vitre attente">
          <div class="pulse" aria-hidden="true"></div>
          <h2 class="titre">${who}</h2>
          <p class="hint">Mise en relation directe de vos deux appareils.</p>
          <button class="verre-btn" data-act="cancel-online">Annuler</button>
        </div>`);
    }
    if (st.kind === 'error') {
      return wall(`
        <div class="vitre attente">
          <h2 class="titre">Connexion impossible</h2>
          <p>${esc(st.message)}</p>
          ${balle('OK', 'data-act="cancel-online"', true)}
        </div>`);
    }
    if (this.board) {
      const b = this.board;
      const rows = b.loading
        ? '<p class="hint">Chargement…</p>'
        : !b.rows
          ? '<p class="hint">Classement indisponible pour le moment.</p>'
          : b.rows.length === 0
            ? '<p class="hint">Aucun match classé joué pour l’instant. Soyez le premier !</p>'
            : `<ol class="board">${b.rows.map((r, i) => `<li><span class="rank">${i + 1}</span><span class="who">${esc(r.name)}</span><span class="wl">${r.wins} V · ${r.losses} D</span><b>${r.rating}</b></li>`).join('')}</ol>`;
      return wall(`
        <div class="segments board-tabs" role="group" aria-label="Classement">
          <button data-board="2" class="${b.kind === '2' ? 'choisi' : ''}">Classement 2v2</button>
          <button data-board="1" class="${b.kind === '1' ? 'choisi' : ''}">Classement 1v1</button>
          <button data-act="close-board">Retour</button>
        </div>
        <div class="vitre sans-boulons board-wrap">${rows}</div>`);
    }
    const card = (mode: QueueMode, sub: string, ranked: boolean) =>
      `<button class="vitre carte-mode file${ranked ? ' classe' : ''}" data-queue="${mode}">
        <span class="tete"><strong class="titre">${labels[mode]}</strong>${ranked ? '<i class="bille"></i>' : ''}</span>
        <span class="bas"><span class="unite">${sub}</span></span></button>`;
    return wall(`
      <div class="grille deux">
        ${card('c2', 'Vous + un partenaire IA', false)}
        ${card('r2', 'Compte pour le classement', true)}
        ${card('c1', 'Seul contre seul', false)}
        ${card('r1', 'Compte pour le classement', true)}
      </div>
      <div class="vitre sans-boulons inviter">
        <div class="col">
          <span class="sur">Inviter un ami</span>
          <div class="actions">
            <button class="verre-btn" data-invite="1" aria-label="Inviter un ami en 1 contre 1">1v1</button>
            <button class="verre-btn" data-invite="2" aria-label="Inviter un ami en 2 contre 2">2v2</button>
          </div>
        </div>
        <form class="col join" data-join>
          <label class="sur" for="join-code">Code d’un ami</label>
          <div class="actions">
            <input id="join-code" type="text" inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="5" placeholder="CODE" />
            <button class="verre-btn plein" type="submit">Rejoindre</button>
          </div>
        </form>
        <button class="verre-btn classement" data-act="board" aria-label="Classement">${TROPHY}</button>
      </div>`);
  }

  private async loadBoard(kind: '1' | '2'): Promise<void> {
    this.board = { kind, rows: null, loading: true };
    this.render();
    const rows = await this.cb.onBoard(kind);
    if (this.board && this.board.kind === kind) {
      this.board = { kind, rows, loading: false };
      if (this.tab === 'online') this.render();
    }
  }

  /** Locker (owned items, to equip) and shop (everything, to buy): one slot open at a time. */
  private renderItems(ownedOnly: boolean): string {
    const p = this.profile;
    // Locker: what is yours first, the rest behind wire mesh. Shop: what is for sale first.
    const rank = (id: string) => (p.owned.includes(id) === ownedOnly ? 0 : 1);
    const items = CATALOG.filter((i) => i.kind === this.kind).sort((a, b) => rank(a.id) - rank(b.id));
    const mine = items.filter((i) => p.owned.includes(i.id)).length;
    const current = this.selected && items.some((i) => i.id === this.selected) ? this.selected : p.equipped[this.kind];
    const sel = itemById(current);
    const slots = KINDS.map(([k, label]) => {
      const eq = itemById(p.equipped[k]);
      const forSale = CATALOG.filter((i) => i.kind === k && !p.owned.includes(i.id)).length;
      const line = ownedOnly ? eq.name : forSale ? `${forSale} en vente` : 'Tout est à vous';
      return `<button class="vitre casier${this.kind === k ? ' choisi' : ''}" data-kind="${k}" role="tab" aria-selected="${this.kind === k}">
        <span class="sur">${label}</span><span class="nom">${line}</span>${ownedOnly ? bolts(eq.rarity, false) : ''}
        ${itemArt(k, eq.color, eq.color2, 'mini', eq.shape, eq.model === 'bruno')}</button>`;
    }).join('');
    const doors = items
      .map((i) => {
        const owned = p.owned.includes(i.id);
        const equipped = p.equipped[i.kind] === i.id;
        const r = RARITY[i.rarity] ?? RARITY.commun;
        const mark = equipped ? '<i class="bille"></i>Équipé' : '';
        const last = owned
          ? ownedOnly
            ? `<span class="ligne3">${i.rarity}</span>`
            : '<span class="ligne3 acquis">à vous</span>'
          : `<span class="ligne3 prix">${fmt(i.price)}${PIECE}</span>`;
        return `<button class="vitre porte ${r.cls}${i.id === current ? ' choisi' : ''}${owned ? '' : ' grille'}" data-item="${i.id}" role="radio" aria-checked="${i.id === current}">
          <span class="marque">${mark}</span>${itemArt(i.kind, i.color, i.color2, 'art', i.shape, i.model === 'bruno')}
          <strong class="titre">${i.name}</strong>${bolts(i.rarity, false)}${last}</button>`;
      })
      .join('');
    const owned = p.owned.includes(sel.id);
    const equipped = p.equipped[sel.kind] === sel.id;
    let action: string;
    if (equipped) action = '<span class="deja"><i class="bille"></i>Équipé</span>';
    else if (owned) action = balle('Équiper', `data-act="equip" data-id="${sel.id}"`, true);
    else if (p.coins >= sel.price) action = `<span class="prix">${fmt(sel.price)}${PIECE}</span>${balle('Acheter', `data-act="buy" data-id="${sel.id}" aria-label="Acheter ${sel.name} pour ${fmt(sel.price)} pièces"`, true)}`;
    else action = `<span class="prix manque">Il manque ${fmt(sel.price - p.coins)}${PIECE}</span>`;
    const title = KINDS.find((k) => k[0] === this.kind)![2];
    const count = ownedOnly ? `${mine} à vous${items.length > mine ? ` · ${items.length - mine} en boutique` : ''}` : 'Prix en pièces · gagnées en jouant';
    return `
      <section class="mur large vestiaire">
        <div class="casiers" role="tablist" aria-label="Emplacements">${slots}</div>
        <i class="poteau"></i>
        <div class="rayon">
          <div class="rayon-tete"><span class="sur">${title}</span><small>${count}</small></div>
          <div class="portes" role="radiogroup">${doors}</div>
          <div class="vitre sans-boulons fiche">
            <div class="qui"><div class="l1"><strong class="titre">${sel.name}</strong><span class="detail">${sel.note}</span></div>${bolts(sel.rarity, true)}</div>
            ${action}
          </div>
        </div>
      </section>`;
  }

  private renderProfile(): string {
    const p = this.profile;
    const s = p.stats;
    const lv = levelOf(p.xp);
    const rate = s.matches ? Math.round((s.wins / s.matches) * 100) : 0;
    const arc = (163.4 * lv.into) / lv.span;
    const cell = (label: string, value: string) => `<div class="vitre sans-boulons stat"><b class="num">${value}</b><span class="sur">${label}</span></div>`;
    return `
      <section class="mur large carriere">
        <div class="vitre fiche-joueur">
          <span class="anneau grand"><svg viewBox="0 0 60 60" aria-hidden="true"><circle class="fond" cx="30" cy="30" r="26"/><circle class="arc" cx="30" cy="30" r="26" stroke-dasharray="${arc.toFixed(1)} 163.4"/></svg><b>${lv.level}</b></span>
          <div class="qui">
            <label class="name-field"><span class="sr">Nom du joueur</span><input type="text" maxlength="14" value="${esc(p.name)}" data-name autocomplete="off" spellcheck="false" /></label>
            <small>Niveau ${lv.level} · ${fmt(lv.into)} / ${fmt(lv.span)} XP</small>
          </div>
          <div class="trophees" aria-label="${s.trophies} trophées">${TROPHY}<b>${s.trophies}</b></div>
        </div>
        <div class="stats">
          ${cell('Matchs', fmt(s.matches))}${cell('Victoires', fmt(s.wins))}${cell('Réussite', `${rate} %`)}${cell('Série record', fmt(s.bestStreak))}
          ${cell('Points gagnés', fmt(s.pointsWon))}${cell('Aces', fmt(s.aces))}${cell('Coups gagnants', fmt(s.winners))}${cell('Plus long échange', fmt(s.longestRally))}
        </div>
      </section>`;
  }

  private renderSettings(): string {
    const s = this.settings;
    const check = (key: keyof Settings, label: string) =>
      `<label class="toggle"><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''} /><span class="track"></span><span>${label}</span></label>`;
    return `
      <section class="mur large reglages-jeu">
        <div class="rayon-tete"><span class="sur">Réglages</span><small>Enregistrés sur cet appareil</small></div>
        <div class="vitre champs">
          <label class="field"><span>Aide au placement <b id="assist-val">${Math.round(s.assist * 100)} %</b></span>
            <input type="range" min="0" max="100" step="5" value="${Math.round(s.assist * 100)}" data-set="assist" /></label>
          <label class="field"><span>Qualité graphique</span>
            <select data-set="quality">
              ${[
                ['auto', 'Automatique'],
                ['high', 'Haute'],
                ['medium', 'Moyenne'],
                ['low', 'Basse'],
              ]
                .map(([v, l]) => `<option value="${v}" ${s.quality === v ? 'selected' : ''}>${l}</option>`)
                .join('')}
            </select></label>
          ${check('sound', 'Sons')}
          ${check('voice', 'Annonce vocale du score')}
          ${check('haptics', 'Vibration (Android)')}
          ${check('showFps', 'Images par seconde')}
        </div>
        <div class="actions">
          <button class="verre-btn" data-act="help">Comment jouer</button>
          ${isStandalone() ? '' : '<button class="verre-btn" data-act="install">Installer le jeu</button>'}
        </div>
      </section>`;
  }

  // ---------------------------------------------------------------------------------------------
  // Events

  private click(e: Event): void {
    const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    // The join form's own button submits the form; every other button is handled here.
    if (!t || t.disabled || t.closest('form')) return;
    const d = t.dataset;
    if (d.tab) return this.setTab(d.tab as HomeTab);
    if (d.pick) {
      // Shortcut from the lobby: the challenge or the tournament becomes the mode to play.
      this.mode = d.pick as ModeId;
      this.profile.lastMode = this.mode;
      saveProfile(this.profile);
      return this.render();
    }
    if (d.mode) {
      this.mode = d.mode as ModeId;
      this.profile.lastMode = this.mode;
      saveProfile(this.profile);
      return this.render();
    }
    if (d.format) {
      this.profile.format = d.format === 'single' ? 'single' : 'double';
      saveProfile(this.profile);
      this.cb.onFormat(this.profile.format);
      return this.render();
    }
    if (d.queue) return this.cb.onQueue(d.queue as QueueMode);
    if (d.invite) return this.cb.onInvite(d.invite === '1' ? '1' : '2');
    if (d.board) return void this.loadBoard(d.board === '1' ? '1' : '2');
    if (d.diff) {
      this.settings.difficulty = d.diff as Difficulty;
      saveSettings(this.settings);
      return this.render();
    }
    if (d.kind) {
      this.kind = d.kind as ItemKind;
      this.selected = null;
      this.cb.onLoadout(this.profile.equipped);
      return this.render();
    }
    if (d.item) {
      // Try it on: the hero and the court show the item straight away.
      this.selected = d.item;
      const item = itemById(d.item);
      this.cb.onLoadout({ ...this.profile.equipped, [item.kind]: item.id });
      return this.render();
    }
    switch (d.act) {
      case 'play':
        this.cb.onPlay(this.mode);
        break;
      case 'buy':
        if (d.id && buyItem(this.profile, d.id)) {
          this.cb.onLoadout(this.profile.equipped);
          this.render();
        }
        break;
      case 'equip':
        if (d.id && equipItem(this.profile, d.id)) {
          this.cb.onLoadout(this.profile.equipped);
          this.render();
        }
        break;
      case 'cancel-online':
        this.cb.onCancelOnline();
        break;
      case 'board':
        void this.loadBoard('2');
        break;
      case 'close-board':
        this.board = null;
        this.render();
        break;
      case 'share':
        void this.share(d.code ?? '');
        break;
      case 'help':
        this.cb.onHelp();
        break;
      case 'install':
        this.cb.onInstall();
        break;
    }
  }

  /** Sends the invitation through the phone's share sheet, or copies the link. */
  private async share(code: string): Promise<void> {
    const url = `${location.origin}${location.pathname}?room=${code}`;
    const text = `Rejoins-moi sur Padel 3D ! Code : ${code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Padel 3D', text, url });
      else {
        await navigator.clipboard.writeText(`${text} — ${url}`);
        const btn = this.body.querySelector('[data-act=share] span');
        if (btn) btn.textContent = 'Lien copié';
      }
    } catch {
      // Share sheet dismissed: nothing to do.
    }
  }

  private submit(e: Event): void {
    const form = (e.target as HTMLElement).closest('[data-join]');
    if (!form) return;
    e.preventDefault();
    const code = (form.querySelector('input') as HTMLInputElement).value;
    if (code.trim().length >= 4) this.cb.onJoin(code);
  }

  private input(e: Event): void {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if ('name' in t.dataset) {
      this.profile.name = t.value.trim().slice(0, 14) || 'Joueur';
      saveProfile(this.profile);
      const chip = this.top.querySelector('.pc-name');
      if (chip) chip.textContent = this.profile.name;
      return;
    }
    const key = t.dataset.set as keyof Settings | undefined;
    if (!key) return;
    const s = this.settings as unknown as Record<string, unknown>;
    if (t instanceof HTMLInputElement && t.type === 'checkbox') s[key] = t.checked;
    else if (key === 'assist') {
      s[key] = Number(t.value) / 100;
      const v = this.root.querySelector('#assist-val');
      if (v) v.textContent = `${t.value} %`;
    } else s[key] = t.value;
    saveSettings(this.settings);
    this.cb.onSettingsChanged();
  }

  private change(e: Event): void {
    // Selects fire `change` on some mobile browsers without a preceding `input`.
    if (e.target instanceof HTMLSelectElement) this.input(e);
  }
}
