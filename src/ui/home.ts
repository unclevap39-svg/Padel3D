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

export type HomeTab = 'play' | 'online' | 'shop' | 'locker' | 'profile' | 'settings';

export interface HomeCallbacks {
  onPlay: (mode: ModeId) => void;
  onSettingsChanged: () => void;
  /** Show these items on the hero character and the court (equipped or being tried on). */
  onLoadout: (loadout: Record<ItemKind, string>) => void;
  onTab: (tab: HomeTab) => void;
  onHelp: () => void;
  onInstall: () => void;
  /** Online lobby actions. */
  onQueue: (mode: QueueMode) => void;
  onInvite: (kind: '1' | '2') => void;
  onJoin: (code: string) => void;
  onCancelOnline: () => void;
  onBoard: (kind: '1' | '2') => Promise<LeaderRow[] | null>;
}

const ICONS = {
  coin: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#f6c93a"/><circle cx="10" cy="10" r="6.2" fill="none" stroke="#b8860b" stroke-width="1.4"/><path d="M10 6v8M7.6 8.2h3.6a1.4 1.4 0 0 1 0 2.8H8.6a1.4 1.4 0 0 0 0 2.8h3.8" fill="none" stroke="#8a6508" stroke-width="1.3" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" fill="currentColor"/></svg>',
  shop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14l-1.2 11.5a1.5 1.5 0 0 1-1.5 1.5H7.7a1.5 1.5 0 0 1-1.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 8V6.5a3.5 3.5 0 0 1 7 0V8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  locker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 3.5 3 6.5l1.8 4 2.2-1V20h10V9.500l2.2 1 1.800-4-5.500-3a3.500 3.500 0 0 1-7 0z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  profile: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 20.500c.8-4 3.700-6 7.500-6s6.700 2 7.500 6" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linecap="round"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.200" fill="none" stroke="currentColor" stroke-width="1.800"/><path d="M12 2.800v3M12 18.200v3M2.800 12h3M18.200 12h3M5.500 5.500l2.100 2.100M16.400 16.400l2.100 2.100M5.500 18.500l2.100-2.100M16.400 7.600l2.100-2.100" stroke="currentColor" stroke-width="1.800" stroke-linecap="round"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v1.500A3.500 3.500 0 0 0 7.500 11M17 6h3v1.500a3.500 3.500 0 0 1-3.500 3.500M12 14v4M8.500 20h7" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3c3 3.2 3 14.800 0 18M12 3c-3 3.200-3 14.800 0 18" fill="none" stroke="currentColor" stroke-width="1.800"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.500l4.500 4.500L19 7.500" fill="none" stroke="currentColor" stroke-width="2.600" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const TABS: Array<[HomeTab, string, string]> = [
  ['play', 'Accueil', ICONS.play],
  ['online', 'En ligne', ICONS.globe],
  ['shop', 'Boutique', ICONS.shop],
  ['locker', 'Vestiaire', ICONS.locker],
  ['profile', 'Profil', ICONS.profile],
  ['settings', 'Réglages', ICONS.settings],
];

const KINDS: Array<[ItemKind, string]> = [
  ['racket', 'Raquettes'],
  ['outfit', 'Tenues'],
  ['court', 'Terrains'],
  ['ball', 'Balles'],
];

const DIFFS: Array<[Difficulty, string]> = [
  ['easy', 'Facile'],
  ['medium', 'Moyen'],
  ['hard', 'Difficile'],
];

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const fmt = (n: number) => n.toLocaleString('fr-FR');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The game's home: mode selection, shop, locker room, profile and settings, laid over the live
 * 3D scene with the player's character on the right.
 */
export class Home {
  private root: HTMLElement;
  private body: HTMLElement;
  private top: HTMLElement;
  private nav: HTMLElement;
  private settings: Settings;
  private profile: Profile;
  private cb: HomeCallbacks;
  private tab: HomeTab = 'play';
  private mode: ModeId;
  private kind: ItemKind = 'racket';
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
    this.root.innerHTML = '<header class="home-top"></header><main class="home-body"></main><nav class="home-nav" aria-label="Sections"></nav>';
    parent.appendChild(this.root);
    this.top = this.root.querySelector('.home-top')!;
    this.body = this.root.querySelector('.home-body')!;
    this.nav = this.root.querySelector('.home-nav')!;
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
      this.render();
      this.cb.onLoadout(this.profile.equipped);
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
    this.top.innerHTML = `
      <button class="player-chip" data-tab="profile" aria-label="Profil">
        <span class="lvl"><b>${lv.level}</b></span>
        <span class="pc-text">
          <span class="pc-name">${esc(p.name)}</span>
          <span class="xp"><i style="width:${Math.round((lv.into / lv.span) * 100)}%"></i></span>
        </span>
      </button>
      <div class="brand">PADEL <span>3D</span></div>
      <div class="wallet" title="Pièces gagnées en jouant">${ICONS.coin}<b>${fmt(p.coins)}</b></div>`;
    this.nav.innerHTML = TABS.map(
      ([id, label, icon]) => `<button data-tab="${id}" class="${this.tab === id ? 'on' : ''}" ${this.tab === id ? 'aria-current="page"' : ''}>${icon}<span>${label}</span></button>`,
    ).join('');
    let html = '';
    if (this.tab === 'play') html = this.renderPlay();
    else if (this.tab === 'online') html = this.renderOnline();
    else if (this.tab === 'shop') html = this.renderItems(false);
    else if (this.tab === 'locker') html = this.renderItems(true);
    else if (this.tab === 'profile') html = this.renderProfile();
    else html = this.renderSettings();
    this.body.innerHTML = `<section class="pane pane-${this.tab}">${html}</section>`;
  }

  private renderPlay(): string {
    const p = this.profile;
    const mode = modeById(this.mode);
    const cards = MODES.filter((m) => !m.hidden).map((m) => {
      let badge = '';
      if (m.id === 'tournament') badge = `<em class="badge">${p.tournamentRound + 1}/3</em>`;
      if (m.id === 'daily') badge = p.dailyDone === today() ? `<em class="badge done">${ICONS.check}</em>` : '<em class="badge hot">+300</em>';
      return `<button class="mode-card ${m.id === this.mode ? 'on' : ''}" data-mode="${m.id}">
        <span class="mc-name">${m.name}</span><span class="mc-tag">${m.tagline}</span>${badge}</button>`;
    }).join('');

    let extra = '';
    let difficulty: string;
    if (mode.id === 'tournament') {
      extra = `<div class="rounds">${TOURNAMENT_ROUNDS.map((x, i) => `<span class="${i < p.tournamentRound ? 'won' : i === p.tournamentRound ? 'cur' : ''}">${x.name.replace(' de finale', '')}</span>`).join('')}</div>`;
      difficulty = '';
    } else if (mode.difficulty) {
      difficulty = `<div class="fixed-diff">Difficulté : <b>${DIFFS.find((d) => d[0] === mode.difficulty)![1]}</b></div>`;
    } else {
      difficulty = `<div class="seg" role="group" aria-label="Difficulté">${DIFFS.map(
        ([d, label]) => `<button data-diff="${d}" class="${this.settings.difficulty === d ? 'on' : ''}">${label}</button>`,
      ).join('')}</div>`;
    }
    const dailyDone = mode.id === 'daily' && p.dailyDone === today();
    const reward = dailyDone ? 'Bonus du jour déjà obtenu' : `Victoire ${ICONS.coin}<b>+${mode.winCoins}</b>`;
    return `
      <div class="kicker">Modes de jeu</div>
      <div class="mode-grid">${cards}</div>
      <p class="mode-desc">${mode.detail}</p>
      <div class="detail-row">
        <div class="seg format" role="group" aria-label="Format">
          <button data-format="double" class="${p.format === 'double' ? 'on' : ''}">Double 2v2</button>
          <button data-format="single" class="${p.format === 'single' ? 'on' : ''}">Simple 1v1</button>
        </div>
        ${extra || difficulty}
      </div>
      <div class="play-row">
        <button class="play-btn" data-act="play"><span>Jouer</span>${ICONS.play}</button>
        <div class="reward">${reward}</div>
      </div>`;
  }

  private renderOnline(): string {
    const st = this.lobby;
    const o = this.online;
    const ratings = o ? `<small>Classement · 1v1 <b>${o.r1}</b> · 2v2 <b>${o.r2}</b></small>` : '<small>Affrontez d’autres joueurs en direct</small>';
    const head = `<div class="kicker">En ligne${ratings}</div>`;
    const labels: Record<QueueMode, string> = { c2: 'Classique 2v2', r2: 'Classé 2v2', c1: 'Classique 1v1', r1: 'Classé 1v1' };
    if (st.kind === 'searching') {
      return `${head}
        <div class="lobby-wait">
          <div class="pulse" aria-hidden="true"></div>
          <h2>Recherche d’un adversaire</h2>
          <p>${labels[st.mode]} · <span class="search-time">${this.elapsed(st.since)}</span></p>
          <p class="hint">Le match démarre dès qu’un autre joueur cherche le même mode. Peu de monde en ligne ? Invitez un ami avec un code.</p>
          <button class="ghost-btn" data-act="cancel-online">Annuler</button>
        </div>`;
    }
    if (st.kind === 'hosting') {
      return `${head}
        <div class="lobby-wait">
          <h2>Code de la partie</h2>
          <div class="room-code" aria-label="Code">${st.code.split('').map((c) => `<span>${c}</span>`).join('')}</div>
          <p>${st.mode === 'i1' ? 'Un contre un' : 'Double : chacun joue avec un partenaire IA'} · en attente de votre ami…</p>
          <div class="settings-actions">
            <button class="act-btn primary" data-act="share" data-code="${st.code}">Envoyer l’invitation</button>
            <button class="ghost-btn" data-act="cancel-online">Annuler</button>
          </div>
        </div>`;
    }
    if (st.kind === 'joining' || st.kind === 'connecting') {
      const who = st.kind === 'connecting' && st.opponent ? `Connexion à ${esc(st.opponent)}…` : 'Connexion…';
      return `${head}
        <div class="lobby-wait">
          <div class="pulse" aria-hidden="true"></div>
          <h2>${who}</h2>
          <p class="hint">Mise en relation directe de vos deux appareils.</p>
          <button class="ghost-btn" data-act="cancel-online">Annuler</button>
        </div>`;
    }
    if (st.kind === 'error') {
      return `${head}
        <div class="lobby-wait">
          <h2>Connexion impossible</h2>
          <p>${esc(st.message)}</p>
          <button class="act-btn primary" data-act="cancel-online">OK</button>
        </div>`;
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
      return `${head}
        <div class="chips">
          <button data-board="2" class="${b.kind === '2' ? 'on' : ''}">Classement 2v2</button>
          <button data-board="1" class="${b.kind === '1' ? 'on' : ''}">Classement 1v1</button>
          <button data-act="close-board">Retour</button>
        </div>
        <div class="board-wrap">${rows}</div>`;
    }
    const card = (mode: QueueMode, sub: string, ranked: boolean) =>
      `<button class="mode-card online-card ${ranked ? 'ranked' : ''}" data-queue="${mode}"><span class="mc-name">${labels[mode]}</span><span class="mc-tag">${sub}</span></button>`;
    return `${head}
      <div class="mode-grid two">
        ${card('c2', 'Vous + un partenaire IA', false)}
        ${card('r2', 'Compte pour le classement', true)}
        ${card('c1', 'Seul contre seul', false)}
        ${card('r1', 'Compte pour le classement', true)}
      </div>
      <div class="invite">
        <div class="invite-col">
          <span class="label">Jouer avec un ami</span>
          <div class="settings-actions">
            <button class="ghost-btn" data-invite="1">Inviter en 1v1</button>
            <button class="ghost-btn" data-invite="2">Inviter en 2v2</button>
          </div>
        </div>
        <form class="invite-col join" data-join>
          <label class="label" for="join-code">Rejoindre avec un code</label>
          <div class="settings-actions">
            <input id="join-code" type="text" inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck="false" maxlength="5" placeholder="CODE" />
            <button class="act-btn primary" type="submit">Rejoindre</button>
          </div>
        </form>
      </div>
      <div class="settings-actions"><button class="ghost-btn" data-act="board">${ICONS.trophy} Classement</button></div>`;
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

  private renderItems(ownedOnly: boolean): string {
    const p = this.profile;
    const items = CATALOG.filter((i) => i.kind === this.kind && (!ownedOnly || p.owned.includes(i.id)));
    const current = this.selected && items.some((i) => i.id === this.selected) ? this.selected : p.equipped[this.kind];
    const sel = itemById(current);
    const chips = KINDS.map(([k, label]) => `<button data-kind="${k}" class="${this.kind === k ? 'on' : ''}">${label}</button>`).join('');
    const cards = items
      .map((i) => {
        const owned = p.owned.includes(i.id);
        const equipped = p.equipped[i.kind] === i.id;
        const state = equipped ? `<span class="state eq">${ICONS.check}Équipé</span>` : owned ? '<span class="state">Possédé</span>' : `<span class="state price">${ICONS.coin}${fmt(i.price)}</span>`;
        return `<button class="item-card r-${i.rarity} ${i.id === current ? 'on' : ''}" data-item="${i.id}">
          <span class="swatch k-${i.kind}" style="--c:${hex(i.color)};--c2:${hex(i.color2 ?? i.color)}"></span>
          <span class="ic-name">${i.name}</span>${state}</button>`;
      })
      .join('');
    const owned = p.owned.includes(sel.id);
    const equipped = p.equipped[sel.kind] === sel.id;
    let action: string;
    if (equipped) action = `<button class="act-btn" disabled>${ICONS.check}Équipé</button>`;
    else if (owned) action = `<button class="act-btn primary" data-act="equip" data-id="${sel.id}">Équiper</button>`;
    else if (p.coins >= sel.price) action = `<button class="act-btn primary" data-act="buy" data-id="${sel.id}">Acheter ${ICONS.coin}${fmt(sel.price)}</button>`;
    else action = `<button class="act-btn" disabled>Il manque ${ICONS.coin}${fmt(sel.price - p.coins)}</button>`;
    return `
      <div class="kicker">${ownedOnly ? 'Vestiaire' : 'Boutique'}<small>${ownedOnly ? 'Vos objets : touchez pour équiper' : 'Les pièces se gagnent en jouant — aucun achat réel'}</small></div>
      <div class="chips">${chips}</div>
      <div class="item-row">${cards}</div>
      <div class="item-action">
        <div class="ia-text"><b>${sel.name}</b><em class="rarity r-${sel.rarity}">${sel.rarity}</em><small>${sel.note}</small></div>
        ${action}
      </div>`;
  }

  private renderProfile(): string {
    const p = this.profile;
    const s = p.stats;
    const lv = levelOf(p.xp);
    const rate = s.matches ? Math.round((s.wins / s.matches) * 100) : 0;
    const cell = (label: string, value: string) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
    return `
      <div class="kicker">Profil</div>
      <div class="profile-head">
        <span class="lvl big"><b>${lv.level}</b></span>
        <div class="ph-text">
          <label class="name-field"><span class="sr">Nom du joueur</span><input type="text" maxlength="14" value="${esc(p.name)}" data-name autocomplete="off" spellcheck="false" /></label>
          <div class="xp wide"><i style="width:${Math.round((lv.into / lv.span) * 100)}%"></i></div>
          <small>Niveau ${lv.level} · ${fmt(lv.into)} / ${fmt(lv.span)} XP</small>
        </div>
        <div class="trophies">${ICONS.trophy}<b>${s.trophies}</b></div>
      </div>
      <div class="stats">
        ${cell('Matchs', fmt(s.matches))}${cell('Victoires', fmt(s.wins))}${cell('Réussite', `${rate} %`)}${cell('Série record', fmt(s.bestStreak))}
        ${cell('Points gagnés', fmt(s.pointsWon))}${cell('Aces', fmt(s.aces))}${cell('Coups gagnants', fmt(s.winners))}${cell('Plus long échange', fmt(s.longestRally))}
      </div>`;
  }

  private renderSettings(): string {
    const s = this.settings;
    const check = (key: keyof Settings, label: string) =>
      `<label class="toggle"><input type="checkbox" data-set="${key}" ${s[key] ? 'checked' : ''} /><span class="track"></span><span>${label}</span></label>`;
    return `
      <div class="kicker">Réglages</div>
      <div class="settings-grid">
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
      <div class="settings-actions">
        <button class="ghost-btn" data-act="help">Comment jouer</button>
        ${isStandalone() ? '' : '<button class="ghost-btn" data-act="install">Installer le jeu</button>'}
      </div>`;
  }

  // ---------------------------------------------------------------------------------------------
  // Events

  private click(e: Event): void {
    const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    // The join form's own button submits the form; every other button is handled here.
    if (!t || t.disabled || t.closest('form')) return;
    const d = t.dataset;
    if (d.tab) return this.setTab(d.tab as HomeTab);
    if (d.mode) {
      this.mode = d.mode as ModeId;
      this.profile.lastMode = this.mode;
      saveProfile(this.profile);
      return this.render();
    }
    if (d.format) {
      this.profile.format = d.format === 'single' ? 'single' : 'double';
      saveProfile(this.profile);
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
        const btn = this.body.querySelector('[data-act=share]');
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
