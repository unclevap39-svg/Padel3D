import * as THREE from 'three';
import { Sound } from '../audio/sound';
import { BallView } from '../entities/ball';
import { CharacterView, type Outfit } from '../entities/character';
import { type PlayerModel, SkinnedBody, loadCharacterModel, loadPlayerModel } from '../entities/skinned';
import { type Intercept, bestIntercept } from '../ai/intercept';
import { TouchControls, vibrate } from '../input/touch';
import { GuestSim } from '../net/guest';
import { HostSession } from '../net/host';
import { Lobby, type MatchInfo } from '../net/lobby';
import { type GuestMsg, type HelloMsg, type HostMsg, type Link, type NetMsg, PROTOCOL } from '../net/protocol';
import { type Prediction, predict } from '../physics/ballistics';
import { TICK_DT } from '../physics/world';
import { inServiceBox, serviceBoxXSign, teamOf } from '../rules/court';
import { AdaptiveQuality } from '../render/adaptive';
import { CameraRig } from '../render/camera';
import { CourtMarkers } from '../render/markers';
import { type QualityTier, Stage } from '../render/stage';
import { Home, type HomeTab } from '../ui/home';
import { Hud } from '../ui/hud';
import { Menu, isMobile } from '../ui/menu';
import {
  CATALOG,
  type ItemKind,
  type MatchSummary,
  type ModeId,
  type Profile,
  TOURNAMENT_ROUNDS,
  applyMatch,
  itemById,
  levelOf,
  loadProfile,
  modeById,
} from './profile';
import { type Settings, saveSettings } from './settings';
import { type ShotClass, OVER_START, aimTarget, classify, humanSigma, overOf } from './shots';
import { Simulation } from './sim';
import type { Difficulty, ShotType, SimEvent } from './types';

/** How a ball was lost: said of the side that made the mistake. */
const ERRORS: Record<string, string> = {
  double_fault: 'double faute',
  net: 'dans le filet',
  wall_direct: 'dans la vitre avant le rebond',
  fence_direct: 'dans le grillage avant le rebond',
  out: 'dehors',
  volley_on_serve: 'volée interdite sur le service',
  double_hit: 'double touche',
};

/** Sub-title of a point: what happened, and who did it. */
function pointReason(reason: string, mine: boolean, lastHitBy: number, overhit: boolean): string {
  if (reason === 'ace') return mine ? 'Ace !' : 'Ace adverse';
  if (reason === 'second_bounce' || reason === 'out_after_bounce') {
    if (!mine) return 'Balle non renvoyée';
    return lastHitBy === 1 ? 'Coup gagnant de votre partenaire' : 'Coup gagnant !';
  }
  const how = ERRORS[reason] ?? '';
  if (mine) return `Faute adverse : ${how}`;
  if (reason === 'double_fault') return 'Double faute';
  if (lastHitBy === 1) return `Faute de votre partenaire : ${how}`;
  return overhit ? `Trop fort : ${how}` : `Votre balle : ${how}`;
}

const FAULTS: Record<string, string> = {
  serve_net: 'Dans le filet',
  serve_out_of_box: 'Hors du carré de service',
  serve_wall: 'Vitre ou grillage direct',
  serve_fence_after_bounce: 'Grillage après le rebond',
  serve_out: 'Dehors',
};

const OUTFITS: Outfit[] = [
  { shirt: 0xf3f5f7, shorts: 0x1b2740, skin: 0xd9a57e, hair: 0x2a1d14, shoes: 0xf2f2f2 },
  { shirt: 0xf3f5f7, shorts: 0x1b2740, skin: 0xb9825c, hair: 0x15110e, shoes: 0xf2f2f2, darkSkin: true },
  { shirt: 0xd8362f, shorts: 0x15171c, skin: 0xe0b08c, hair: 0x4a3420, shoes: 0x202428 },
  { shirt: 0xd8362f, shorts: 0x15171c, skin: 0x8f5f3f, hair: 0x100c0a, shoes: 0x202428, darkSkin: true },
];

export interface GameOptions {
  canvas: HTMLCanvasElement;
  ui: HTMLElement;
  settings: Settings;
  /** Forced quality (URL parameter), bypassing the adaptive controller. */
  forceTier?: QualityTier;
  canInstallNatively: () => boolean;
  promptInstall: () => Promise<boolean>;
}

/** Ties the simulation to rendering, input, audio and the interface. */
export class Game {
  readonly stage: Stage;
  readonly sound = new Sound();
  readonly hud: Hud;
  readonly menu: Menu;
  readonly home: Home;
  readonly profile: Profile;
  readonly controls: TouchControls;
  sim: Simulation | GuestSim;
  readonly lobby = new Lobby();
  /** The online match in progress, if any. */
  private net: { info: MatchInfo; link: Link; host: HostSession | null; ended: boolean } | null = null;
  private settings: Settings;
  private ball = new BallView();
  private markers = new CourtMarkers();
  /**
   * What the view works out for itself about the ball in play (the online guest has no access
   * to the host's plans): who struck it last, where it will bounce, where the player would
   * meet it and whether it can be smashed.
   */
  private view = {
    lastHitTeam: -1,
    lastHitBy: -1,
    lastPower: 0,
    bounces: 0,
    serveFlight: false,
    recalcAt: 0,
    pred: null as Prediction | null,
    ic: null as Intercept | null,
    smashReady: false,
    goingOut: false,
    leaveTold: false,
    landing: null as { x: number; z: number; t: number } | null,
    lastGauge: 0,
    lastType: 'drive' as ShotType,
  };
  private characters: CharacterView[] = [];
  private camera = new CameraRig();
  private adaptive: AdaptiveQuality;
  private acc = 0;
  private last = 0;
  private timeScale = 1;
  private slowUntil = 0;
  private paused = false;
  private playing = false;
  private clock = 0; // real seconds since start
  private pendingAnnounce: { at: number; text: string } | null = null;
  private opts: GameOptions;
  private ballPos = { x: 0, y: 1, z: 0 };
  /** Character bodies: the base model, the roster files already asked for, who is in each place. */
  private baseModel: PlayerModel | null = null;
  private models = new Map<string, Promise<PlayerModel>>();
  private cast: string[] = ['', '', '', ''];
  /** Lobby: is the partner on stage (doubles)? */
  private lobbyPartner = true;
  private tmp = new THREE.Vector3();
  private mode: ModeId = 'quick';
  /** Assist level imposed by the current mode, if any. */
  private modeAssist: number | null = null;
  private summary: MatchSummary = { mode: 'quick', won: false, pointsWon: 0, pointsLost: 0, aces: 0, winners: 0, longestRally: 0 };
  /** Items currently shown on the character and the court (equipped, or tried on in the shop). */
  private shown: Partial<Record<ItemKind, string>> = {};
  /** Development aid: fixed camera for close-up checks. */
  /** Development aid: stop the simulation clock while still drawing the characters. */
  freeze = false;
  /** Development aid: slows the simulation down to inspect movement frame by frame. */
  debugTimeScale = 1;
  debugCam: { pos: [number, number, number]; look: [number, number, number]; fov?: number } | null = null;

  constructor(opts: GameOptions) {
    this.opts = opts;
    this.settings = opts.settings;
    const tier = opts.forceTier ?? this.initialTier();
    this.stage = new Stage(opts.canvas, tier);
    this.adaptive = new AdaptiveQuality(this.stage, tier);
    this.adaptive.enabled = !opts.forceTier && this.settings.quality === 'auto';
    this.stage.scene.add(this.ball.group);
    this.stage.scene.add(this.markers.group);
    OUTFITS.forEach((o, i) => {
      const c = new CharacterView(o, i === 0);
      this.characters.push(c);
      this.stage.scene.add(c.group);
    });

    this.hud = new Hud(opts.ui);
    this.controls = new TouchControls(opts.ui);
    this.profile = loadProfile();
    this.mode = this.profile.lastMode;
    this.home = new Home(opts.ui, this.settings, this.profile, {
      onPlay: (mode) => this.startMatch(mode),
      onSettingsChanged: () => this.applySettings(),
      onLoadout: (loadout) => this.applyLoadout(loadout),
      onTab: (tab) => this.frameHero(tab),
      onFormat: (format) => {
        this.lobbyPartner = format === 'double';
      },
      onHelp: () => {
        this.home.show(false);
        this.menu.show('help', { inMatch: false });
      },
      onInstall: () => {
        this.home.show(false);
        this.menu.show('install', { inMatch: false });
      },
      onQueue: (mode) => {
        this.sound.unlock();
        void this.lobby.search(mode);
      },
      onInvite: (kind) => {
        this.sound.unlock();
        void this.lobby.createRoom(kind);
      },
      onJoin: (code) => {
        this.sound.unlock();
        void this.lobby.joinRoom(code);
      },
      onCancelOnline: () => this.lobby.cancel(),
      onBoard: (kind) => this.lobby.leaderboard(kind),
    });
    this.lobby.onState = (state) => this.home.setLobby(state, this.lobby.profile);
    this.lobby.onMatch = (info, link) => this.startOnline(info, link);
    this.menu = new Menu(opts.ui, this.settings, {
      onPlay: () => this.startMatch(this.mode),
      onResume: () => this.resume(),
      onQuit: () => this.toMenu(),
      onHome: () => this.showHome(),
      onSettingsChanged: () => this.applySettings(),
      onInstall: opts.promptInstall,
      canInstallNatively: opts.canInstallNatively,
    });
    this.hud.onPause = () => this.pause();
    this.controls.onPress = (type) => {
      this.sound.unlock();
      this.sim.humanPress(type);
    };
    this.controls.onRelease = () => this.sim.humanRelease();
    this.controls.onCancel = () => this.sim.humanCancel();
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.repeat || !this.playing) return;
      if (this.menu.current === 'pause') this.resume();
      else if (this.menu.current === null) this.pause();
    });

    // Home screen: the four players stand on court, the camera frames your character.
    this.sim = this.makeSim(false);
    this.stageLobby();
    this.camera.hero = { zoom: 1.25, shift: 0 };
    this.camera.setBaseFov(this.stage.camera.fov);
    this.applyLoadout(this.profile.equipped);
    this.castOthers();
    this.applySettings();

    window.addEventListener('resize', () => {
      this.stage.resize();
      this.camera.setBaseFov(this.stage.baseFov);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.playing && !this.paused) this.pause();
    });
    window.addEventListener('pointerdown', () => this.sound.unlock(), { once: false, passive: true });
  }

  /**
   * Loads the realistic player model and puts it on the four characters. If it cannot be
   * loaded the jointed mannequins stay in place.
   */
  async loadCharacters(onProgress?: (fraction: number) => void): Promise<boolean> {
    try {
      const model = await loadPlayerModel(onProgress);
      this.baseModel = model;
      this.characters.forEach((c, i) => {
        c.setBody(new SkinnedBody(model, c.outfit, !!OUTFITS[i].darkSkin), model.proportions);
      });
      // Now that the shared textures are there, bring in the chosen characters.
      const want = this.cast.slice();
      this.cast = ['', '', '', ''];
      want.forEach((id, i) => id && this.setCharacter(i, id));
      return true;
    } catch (err) {
      console.warn('Modèle de joueur indisponible, mannequins conservés', err);
      return false;
    }
  }

  /**
   * Puts a character of the roster in one of the four places. The body is fetched the first
   * time it is needed; until then (or if it cannot be fetched) the place keeps its current body.
   */
  private setCharacter(slot: number, id: string): void {
    const item = itemById(id);
    if (item.kind !== 'character' || !item.model || this.cast[slot] === id) return;
    this.cast[slot] = id;
    const base = this.baseModel;
    if (!base) return; // applied once the base model has arrived
    let pending = this.models.get(item.model);
    if (!pending) {
      pending = loadCharacterModel(item.model, base);
      this.models.set(item.model, pending);
    }
    pending
      .then((model) => {
        if (this.cast[slot] !== id) return; // another character was chosen meanwhile
        const c = this.characters[slot];
        c.outfit = { ...c.outfit, hair: item.color, skin: item.color2 ?? c.outfit.skin };
        c.setBody(new SkinnedBody(model, c.outfit, false), model.proportions);
      })
      .catch((err) => {
        this.models.delete(item.model!);
        this.cast[slot] = '';
        console.warn(`Personnage ${item.name} indisponible`, err);
      });
  }

  /**
   * Chooses who stands in the three other places: different from you and from each other.
   * `opponent` forces the character of the player across the net (online).
   */
  private castOthers(opponent?: string): void {
    const mine = this.cast[0] || this.profile.equipped.character;
    const pool = CATALOG.filter((i) => i.kind === 'character' && i.id !== mine && i.id !== opponent).map((i) => i.id);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    this.setCharacter(1, pool[0]);
    this.setCharacter(2, opponent && itemById(opponent).kind === 'character' ? opponent : pool[1]);
    this.setCharacter(3, pool[2]);
  }

  private initialTier(): QualityTier {
    const q = this.settings.quality;
    if (q !== 'auto') return q;
    // Start in the middle on phones and let the controller move from there.
    return isMobile() ? 'medium' : 'high';
  }

  private makeSim(human: boolean, mode?: ModeId): Simulation {
    let difficulty: Difficulty = this.settings.difficulty;
    let assist = this.settings.assist;
    this.modeAssist = null;
    const m = mode ? modeById(mode) : null;
    if (m) {
      if (m.id === 'tournament') difficulty = TOURNAMENT_ROUNDS[this.profile.tournamentRound].difficulty;
      else if (m.difficulty) difficulty = m.difficulty;
      if (m.assist !== null) {
        assist = m.assist;
        this.modeAssist = m.assist;
      }
    }
    const singles = !!m && this.profile.format === 'single';
    return new Simulation({ difficulty, assist, humanControlled: human, match: m?.match, singles });
  }

  /** Puts shop items on your pair, your racket, the ball and the court. */
  applyLoadout(loadout: Record<ItemKind, string>): void {
    if (this.shown.outfit !== loadout.outfit) {
      const o = itemById(loadout.outfit);
      for (const i of [0, 1]) {
        this.characters[i].setOutfit({ ...OUTFITS[i], shirt: o.color, shorts: o.color2 ?? OUTFITS[i].shorts });
      }
    }
    if (this.shown.character !== loadout.character) {
      this.setCharacter(0, loadout.character);
      // Nobody else on court wears the same face as you.
      if (this.cast.indexOf(loadout.character, 1) > 0) this.castOthers(this.net ? this.cast[2] : undefined);
    }
    if (this.shown.racket !== loadout.racket) {
      const r = itemById(loadout.racket);
      this.characters[0].setRacket(r.color, r.color2 ?? 0x14161a, r.shape, r.finish);
    }
    if (this.shown.court !== loadout.court) {
      const c = itemById(loadout.court);
      this.stage.applyCourt(c.color, c.theme);
    }
    if (this.shown.ball !== loadout.ball) this.ball.setColor(itemById(loadout.ball).color);
    this.shown = { ...loadout };
  }

  /**
   * Home camera. In the lobby the team stands in the middle of the picture; the other screens
   * have a wall of glass on one side, so the player moves to the free side.
   */
  private frameHero(tab: HomeTab): void {
    if (!this.camera.hero) return;
    const frame = tab === 'play' ? { zoom: 1.25, shift: 0 } : tab === 'modes' ? { zoom: 0.95, shift: -0.42 } : { zoom: 1, shift: 0.5 };
    this.camera.hero.zoom = frame.zoom;
    this.camera.hero.shift = frame.shift;
  }

  /** Puts the team on stage for the lobby: the partner stands just behind the player. */
  private stageLobby(): void {
    const p = this.sim.players;
    p[1].place(p[0].x - 1.25, p[0].z + 0.55);
  }

  /** Name tags of the lobby follow the heads of the two players. */
  private updateLobbyTags(): void {
    if (!this.home.visible) return;
    const w = this.opts.canvas.clientWidth;
    const h = this.opts.canvas.clientHeight;
    const at = (i: number) => {
      const p = this.sim.players[i];
      const pt = this.tmp.set(p.x, 1.75, p.z).project(this.stage.camera);
      return { x: (pt.x * 0.5 + 0.5) * w, y: (-pt.y * 0.5 + 0.5) * h };
    };
    this.home.setAnchors([at(0), this.lobbyPartner ? at(1) : null]);
  }

  showHome(): void {
    this.menu.show(null, { inMatch: false });
    this.home.show(true);
    // Refresh the online profile (ratings) in the background; the lobby works without it.
    void this.lobby.hello(this.profile.name).then((p) => p && this.home.setLobby(this.lobby.state, p));
  }

  /** Opened from an invitation link: go straight to the online tab and join that room. */
  joinInvitation(code: string): void {
    this.showHome();
    this.home.open('online');
    void this.lobby.joinRoom(code);
  }

  // -------------------------------------------------------------------------------------------
  // Online matches

  private look(): HelloMsg {
    const e = this.profile.equipped;
    const outfit = itemById(e.outfit);
    const racket = itemById(e.racket);
    return {
      k: 'hello',
      name: this.profile.name,
      look: {
        shirt: outfit.color,
        shorts: outfit.color2 ?? 0x15171c,
        racket: racket.color,
        frame: racket.color2 ?? 0x14161a,
        char: e.character,
        racketId: e.racket,
      },
      assist: this.settings.assist,
      v: PROTOCOL,
    };
  }

  /** A direct link to the other player is open: start the match as host or as guest. */
  private startOnline(info: MatchInfo, link: Link): void {
    const singles = info.mode.endsWith('1');
    const ranked = info.mode[0] === 'r';
    this.mode = ranked ? 'ranked' : 'online';
    this.summary = { mode: this.mode, won: false, pointsWon: 0, pointsLost: 0, aces: 0, winners: 0, longestRally: 0 };
    this.modeAssist = null;
    this.applyLoadout(this.profile.equipped);
    this.castOthers();
    let host: HostSession | null = null;
    if (info.role === 'host') {
      const sim = new Simulation({
        difficulty: 'medium',
        assist: this.settings.assist,
        humanControlled: false,
        humans: [0, 2],
        assistBy: {},
        singles,
        match: { setsToWin: 1 },
      });
      sim.startMatch();
      this.sim = sim;
      host = new HostSession(sim, link);
    } else {
      this.sim = new GuestSim(link);
    }
    this.net = { info, link, host, ended: false };
    link.onMessage = (msg: NetMsg) => {
      if (msg.k === 'hello') return this.opponentHello(msg);
      if (msg.k === 'bye') return this.opponentLeft();
      if (host) host.receive(msg as GuestMsg);
      else (this.sim as GuestSim).receive(msg as HostMsg);
    };
    link.onClose = () => this.opponentLeft();
    link.send(this.look());
    host?.sendStart();

    this.home.show(false);
    this.menu.show(null, { inMatch: true });
    this.playing = true;
    this.paused = false;
    this.timeScale = 1;
    this.slowUntil = 0;
    this.acc = 0;
    this.camera.orbit = false;
    this.camera.hero = null;
    this.camera.focus = 0;
    this.camera.snap(this.stage.camera, this.sim.players[0]);
    this.hud.show(true);
    this.hud.setNames('VOUS', info.opponent.name);
    this.controls.setEnabled(true);
    this.hud.updateScore(this.sim.match.scoring, this.sim.match.referee.server);
    this.hud.flash(ranked ? 'Match classé' : 'Match en ligne', `Contre ${info.opponent.name}`, 2.6);
    this.ball.reset();
    this.sound.startCrowd();
    void this.requestLandscape();
  }

  /** The other player's name, colours and assist setting. */
  private opponentHello(msg: HelloMsg): void {
    if (this.sim instanceof GuestSim) this.sim.hostVersion = typeof msg.v === 'number' ? msg.v : 1;
    const look = msg.look ?? { shirt: 0xd8362f, shorts: 0x15171c, racket: 0xd8ef2f, frame: 0x14161a };
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && v >= 0 && v <= 0xffffff ? Math.floor(v) : fallback);
    // Two pairs in the same shirt would be impossible to tell apart: the opponents then keep the default red.
    const mine = itemById(this.profile.equipped.outfit).color;
    const theirs = num(look.shirt, OUTFITS[2].shirt);
    const dist = Math.hypot(((mine >> 16) & 255) - ((theirs >> 16) & 255), ((mine >> 8) & 255) - ((theirs >> 8) & 255), (mine & 255) - (theirs & 255));
    for (const i of [2, 3]) {
      const own = dist > 90;
      this.characters[i].setOutfit({ ...OUTFITS[i], shirt: own ? theirs : OUTFITS[i].shirt, shorts: own ? num(look.shorts, OUTFITS[i].shorts) : OUTFITS[i].shorts });
    }
    // Shape and finish come from the catalogue, never from the message itself.
    const theirRacket = typeof look.racketId === 'string' ? CATALOG.find((i) => i.id === look.racketId && i.kind === 'racket') : undefined;
    this.characters[2].setRacket(num(look.racket, 0xd8ef2f), num(look.frame, 0x14161a), theirRacket?.shape, theirRacket?.finish);
    const theirChar = typeof look.char === 'string' && CATALOG.some((i) => i.id === look.char && i.kind === 'character') ? look.char : undefined;
    if (theirChar) this.castOthers(theirChar);
    if (this.net?.host && this.sim instanceof Simulation && typeof msg.assist === 'number') {
      this.sim.config.assistBy = { 2: Math.max(0, Math.min(1, msg.assist)) };
    }
  }

  /** The link dropped or the opponent quit: the player who stayed wins. */
  private opponentLeft(): void {
    if (!this.net || this.net.ended || !this.playing) return;
    this.hud.flash('Adversaire déconnecté', 'Victoire par abandon', 2.5);
    this.finishOnline(true, true);
  }

  private finishOnline(won: boolean, forfeit: boolean): void {
    const net = this.net;
    if (!net || net.ended) return;
    net.ended = true;
    this.summary.won = won;
    const ranked = net.info.mode[0] === 'r';
    const s = this.sim.match.scoring;
    const score = forfeit ? 'abandon' : s.completedSets.map((x) => `${x[0]}-${x[1]}`).join('  ');
    const r = applyMatch(this.profile, this.summary);
    this.controls.setEnabled(false);
    this.playing = false;
    this.hud.setPrompt(null);
    const coin =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="#c9d0d8" stroke="#5e6977" stroke-width="1"/><circle cx="8" cy="8" r="5" fill="none" stroke="#7b8592" stroke-width=".8"/><path d="M3.4 5.2c2.6 1.2 2.6 4.4 0 5.6M12.600 5.200c-2.600 1.200-2.600 4.400 0 5.600" fill="none" stroke="#49525e" stroke-width="1.1" stroke-linecap="round"/></svg>';
    window.setTimeout(
      () => {
        this.hud.clearBanner();
        this.menu.show('end', {
          inMatch: false,
          online: true,
          endHtml: `
            <div class="result-kicker">${ranked ? 'Match classé' : 'Match en ligne'} · ${net.info.opponent.name}</div>
            <h2 class="result-title ${won ? '' : 'lost'}">${won ? 'Victoire' : 'Défaite'}</h2>
            <p class="final-score">Score : <b>${score}</b></p>
            <div class="gains">
              <div class="gain">${coin}<b>+${r.coins}</b> pièces</div>
              <div class="gain"><b>+${r.xp}</b> XP</div>
              ${ranked ? '<div class="gain" id="rating-gain">Classement…</div>' : ''}
            </div>`,
        });
      },
      forfeit ? 1800 : 0,
    );
    if (ranked) {
      const winnerRole = won ? net.info.role : net.info.role === 'host' ? 'guest' : 'host';
      void this.lobby.reportResult(net.info.matchId, winnerRole).then((res) => {
        const el = document.getElementById('rating-gain');
        if (!el) return;
        el.innerHTML = res ? `<b>${res.delta >= 0 ? '+' : ''}${res.delta}</b> classement · ${res.rating}` : 'Classement inchangé';
      });
    }
    // Keep the link open a moment so the last events reach the other side, then hang up.
    window.setTimeout(() => {
      net.link.send({ k: 'bye' });
      net.link.onClose = () => {};
      net.link.close();
    }, 1500);
  }

  /** Leaves an online match in progress (counts as a defeat). */
  private abandonOnline(): void {
    const net = this.net;
    if (!net) return;
    if (!net.ended && this.playing) {
      net.ended = true;
      this.summary.won = false;
      applyMatch(this.profile, this.summary);
      if (net.info.mode[0] === 'r') void this.lobby.reportResult(net.info.matchId, net.info.role === 'host' ? 'guest' : 'host');
      net.link.send({ k: 'bye' });
    }
    net.link.onClose = () => {};
    window.setTimeout(() => net.link.close(), 300);
    this.net = null;
  }

  private applySettings(): void {
    const s = this.settings;
    this.sound.setEnabled(s.sound);
    this.sound.voice = s.voice;
    if (this.sim && this.modeAssist === null && !this.net) this.sim.config.assist = s.assist;
    if (!this.opts.forceTier) {
      this.adaptive.enabled = s.quality === 'auto';
      if (s.quality !== 'auto' && this.stage.tier !== s.quality) {
        this.stage.resolutionScale = 1;
        this.stage.applyTier(s.quality);
      }
    }
    if (!s.showFps) this.hud.setFps(null);
  }

  showMenu(first: boolean): void {
    if (first) this.menu.show('install', { inMatch: false });
    else this.showHome();
  }

  startMatch(mode: ModeId = this.mode, firstServer?: 0 | 2): void {
    // "Play again" after an online match goes back to the lobby rather than starting a solo game.
    if (modeById(mode).hidden) return this.toMenu();
    this.net = null;
    this.hud.setNames('VOUS', 'ADVERSAIRES');
    this.sound.unlock();
    this.sound.startCrowd();
    this.mode = mode;
    this.summary = { mode, won: false, pointsWon: 0, pointsLost: 0, aces: 0, winners: 0, longestRally: 0 };
    this.applyLoadout(this.profile.equipped);
    this.home.show(false);
    this.castOthers();
    const sim = this.makeSim(true, mode);
    sim.startMatch(firstServer);
    this.sim = sim;
    for (const c of this.characters) c.animator.yaw = 0;
    this.playing = true;
    this.paused = false;
    this.timeScale = 1;
    this.slowUntil = 0;
    this.camera.orbit = false;
    this.camera.hero = null;
    this.camera.focus = 0;
    this.camera.snap(this.stage.camera, this.sim.players[0]);
    this.menu.show(null, { inMatch: true });
    this.hud.show(true);
    this.controls.setEnabled(true);
    this.hud.updateScore(this.sim.match.scoring, this.sim.match.referee.server);
    const m = modeById(mode);
    const title = m.id === 'tournament' ? TOURNAMENT_ROUNDS[this.profile.tournamentRound].name : m.name;
    this.hud.flash(title, this.sim.match.referee.server < 2 ? 'Vous servez en premier' : 'Les adversaires servent', 2.4);
    this.ball.reset();
    void this.requestLandscape();
  }

  /** Full screen and landscape lock where the browser allows it (Android; not iOS Safari). */
  private async requestLandscape(): Promise<void> {
    if (!isMobile()) return;
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      if (o?.lock) await o.lock('landscape');
    } catch {
      // Refused or unsupported: the rotate hint covers portrait.
    }
  }

  pause(): void {
    if (!this.playing || this.paused) return;
    // An online match cannot be paused: the menu opens over the live game.
    this.paused = !this.net;
    this.controls.setEnabled(false);
    this.menu.show('pause', { inMatch: true });
  }

  resume(): void {
    this.paused = false;
    this.controls.setEnabled(true);
    this.menu.show(null);
    this.last = performance.now();
  }

  toMenu(): void {
    const wasOnline = this.net !== null;
    this.abandonOnline();
    this.playing = false;
    this.paused = false;
    this.controls.setEnabled(false);
    this.hud.show(false);
    this.hud.setPrompt(null);
    this.sim = this.makeSim(false);
    this.stageLobby();
    this.camera.orbit = false;
    this.camera.hero = { zoom: 1.25, shift: 0 };
    this.camera.focus = 0;
    this.timeScale = 1;
    this.camera.snap(this.stage.camera, this.sim.players[0]);
    for (const c of this.characters) c.group.visible = true;
    this.applyLoadout(this.profile.equipped);
    this.showHome();
    if (wasOnline) this.home.open('online');
  }

  start(): void {
    this.last = performance.now();
    this.camera.snap(this.stage.camera);
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /** Advances the game by `dt` real seconds and renders. */
  frame(dt: number): void {
    this.clock += dt;
    if (!this.paused) {
      // Slow motion eases in and out.
      const target = this.clock < this.slowUntil && !this.net ? 0.28 : 1;
      this.timeScale += (target - this.timeScale) * Math.min(1, dt * 6);
      this.camera.focus += ((this.clock < this.slowUntil ? 1 : 0) - this.camera.focus) * Math.min(1, dt * 4);
      const simDt = dt * this.timeScale * this.debugTimeScale;
      this.sim.setHumanMove(this.controls.move.x, this.controls.move.z);
      this.acc += simDt;
      let steps = 0;
      if (this.freeze) this.acc = 0;
      while (this.acc >= TICK_DT && steps < 12) {
        this.sim.tick();
        this.acc -= TICK_DT;
        steps++;
      }
      if (steps === 12) this.acc = 0;
      if (this.sim instanceof GuestSim) this.sim.sync(dt);
      const events = this.sim.drainEvents();
      this.net?.host?.afterFrame(events, dt);
      this.handleEvents(events);
      this.updateAimView(dt);

      const b = this.sim.world.ball;
      this.ballPos.x = b.px;
      this.ballPos.y = b.py;
      this.ballPos.z = b.pz;
      const live = this.sim.phase === 'rally' || this.sim.phase === 'serve_motion';
      for (let i = 0; i < 4; i++) {
        const p = this.sim.players[i];
        // In the lobby only your team is on stage, and the partner only in doubles.
        const staged = this.playing || !this.home.visible || i === 0 || (i === 1 && this.lobbyPartner);
        this.characters[i].group.visible = p.active && staged;
        if (p.active) this.characters[i].update(simDt, p, this.sim.now, this.ballPos, live);
      }
      this.ball.update(b, this.sim.world.ballRotation(), this.stage.camera, this.opts.canvas.clientHeight);
      this.camera.update(this.stage.camera, dt, this.sim.players[0], this.ballPos);
      this.updateLobbyTags();
      if (this.debugCam) {
        const cam = this.stage.camera;
        cam.position.set(...this.debugCam.pos);
        cam.lookAt(...this.debugCam.look);
        if (this.debugCam.fov) {
          cam.fov = this.debugCam.fov;
          cam.updateProjectionMatrix();
        }
      }

      if (this.pendingAnnounce && this.clock >= this.pendingAnnounce.at) {
        this.sound.say(this.pendingAnnounce.text);
        this.pendingAnnounce = null;
      }
    }
    this.stage.render();
    this.adaptive.frame(dt);
    if (this.settings.showFps && this.playing) {
      this.hud.setFps(`${Math.round(this.adaptive.fps)} i/s · ${this.stage.tier} · ×${this.stage.pixelRatio.toFixed(2)}`);
    }
  }

  /**
   * Everything the player needs to see to aim and time a shot: the marker where the shot will
   * land, the marker where the incoming ball will bounce, the power gauge, the state of the
   * buttons. Worked out from the ball alone, so it is the same for the host and the guest.
   */
  private updateAimView(dt: number): void {
    const sim = this.sim;
    const v = this.view;
    const p0 = sim.players[0];
    const ref = sim.match.referee;
    const live = this.playing;
    const rally = live && sim.phase === 'rally';

    // Where is the opponents' ball going, and where would I meet it?
    const incoming = rally && v.lastHitTeam === 1 && v.bounces < 2;
    const charge = live ? sim.humanCharge() : null;
    if (!incoming) {
      v.pred = null;
      v.ic = null;
      v.smashReady = false;
      v.goingOut = false;
      v.landing = null;
    } else if (this.clock >= v.recalcAt) {
      const { ball, t, stale } = sim.viewBall();
      // Online, the newest state can be ahead of the events already shown (a bounce not yet
      // announced): predicting from it would call a good ball out. Try again next frame.
      if (!stale) v.recalcAt = this.clock + 0.1;
      const pred = stale && v.pred ? v.pred : predict(ball, 3, v.bounces);
      v.pred = pred;
      const o = { now: sim.now, predT0: t, mustBounce: v.serveFlight, reaction: 0, minLead: 0.04 };
      v.ic = bestIntercept(p0, pred, { ...o, wantOverhead: charge?.type === 'smash' });
      const high = charge?.type === 'smash' ? v.ic : bestIntercept(p0, pred, { ...o, wantOverhead: true });
      v.smashReady = !!high?.overhead;
      const fb = pred.firstBounce;
      let out = false;
      if (v.bounces === 0) {
        out = (pred.net && !fb) || pred.wallBeforeBounce || (pred.out && !fb);
        if (fb && fb.z < 0) out = true;
        if (fb && v.serveFlight && !inServiceBox(fb.x, fb.z, 0, serviceBoxXSign(1, ref.serveSide))) out = true;
      }
      v.goingOut = out;
      v.landing = v.bounces === 0 && fb && fb.z > 0 ? { x: fb.x, z: fb.z, t: t + fb.t } : null;
      if (out && !v.leaveTold) {
        v.leaveTold = true;
        this.hud.hint('Laissez-la : elle sort', 1.2);
      }
    }
    const land = v.landing && sim.now < v.landing.t + 0.1 ? v.landing : null;
    this.markers.setLanding(land, v.goingOut);

    // Where is my own shot aimed?
    const serving = live && ref.server === 0 && (sim.phase === 'serve_ready' || sim.phase === 'serve_motion');
    const swing = p0.swing && p0.swing.willHit && sim.now < p0.swing.contactT ? p0.swing : null;
    if (charge) {
      v.lastGauge = charge.gauge;
      v.lastType = charge.type;
    } else if (sim.phase === 'serve_ready') v.lastGauge = 0;
    let target: { x: number; z: number } | null = null;
    let gauge: number | null = null;
    const assist = sim instanceof Simulation ? sim.assistOf(p0) : this.settings.assist;
    if (serving || (rally && (charge || swing))) {
      const g = charge ? charge.gauge : v.lastGauge;
      gauge = charge || swing ? g : null;
      const type = charge?.type ?? v.lastType;
      let cls: ShotClass;
      let from = { x: p0.x + 0.5, z: p0.z };
      if (serving) cls = 'serve';
      else if (swing) {
        cls = classify(type, swing.stroke, swing.contact.y, false);
        from = swing.contact;
      } else if (v.ic) {
        const stroke = v.ic.overhead ? (type === 'smash' ? 'smash' : 'bandeja') : v.ic.volley ? 'volley_fh' : 'forehand';
        cls = classify(type, stroke, v.ic.ball.y, false);
        from = v.ic.ball;
      } else cls = type === 'lob' ? 'lob' : 'drive';
      target = aimTarget({
        cls,
        g,
        aim: this.controls.move.x,
        from,
        rightX: 1,
        fwd: -1,
        assist,
        sigma: humanSigma(assist, 1, serving),
        serveBox: serving ? serviceBoxXSign(0, ref.serveSide) : undefined,
      });
      this.markers.setAim(target, overOf(g));
    } else this.markers.setAim(null);
    this.markers.update(dt);

    // Gauge: around the button, and above the player where the thumb does not hide it.
    this.controls.setGauge(gauge !== null ? (charge?.type ?? v.lastType) : null, gauge ?? 0);
    if (gauge !== null) {
      const cam = this.stage.camera;
      const pt = this.tmp.set(p0.x, 2.15, p0.z).project(cam);
      const w = this.opts.canvas.clientWidth;
      const h = this.opts.canvas.clientHeight;
      this.hud.setGauge(gauge, (pt.x * 0.5 + 0.5) * w, (-pt.y * 0.5 + 0.5) * h);
    } else this.hud.setGauge(null);
    this.controls.setSmashReady(v.smashReady);
    this.controls.setIdle(!(sim.phase === 'rally' || sim.phase === 'serve_ready' || sim.phase === 'serve_motion'));
  }

  private handleEvents(events: SimEvent[]): void {
    const live = this.playing;
    const v = this.view;
    for (const e of events) {
      switch (e.kind) {
        case 'swing':
          // A swing at thin air: the ball was out of reach.
          if (live && e.player === 0 && !e.swing.willHit && e.swing.stroke !== 'serve') {
            this.sound.whoosh();
            this.hud.hint('Trop loin de la balle', 1.1);
          }
          break;
        case 'hit':
          v.lastHitTeam = teamOf(e.player);
          v.lastHitBy = e.player;
          v.lastPower = e.power ?? 0;
          v.bounces = 0;
          v.serveFlight = e.stroke === 'serve';
          v.recalcAt = 0;
          v.leaveTold = false;
          this.sound.hit(Math.min(1, e.speedKmh / 120));
          if (live) {
            this.hud.setSpeed(e.speedKmh);
            if (e.player === 0 && this.settings.haptics) vibrate(e.stroke === 'smash' ? 35 : 18);
          }
          break;
        case 'bounce':
          if (e.surface === 'floor') v.bounces++;
          v.recalcAt = 0;
          this.sound.bounce(e.surface, e.speed);
          break;
        case 'serve_ready':
          v.lastHitTeam = -1;
          if (!live) break;
          this.hud.updateScore(this.sim.match.scoring, e.server);
          if (e.server === 0) {
            this.hud.setPrompt(`${e.serveNumber === 2 ? 'Second service' : 'Service'} : maintenez FRAPPE pour doser, relâchez pour servir`);
          } else this.hud.setPrompt(null);
          break;
        case 'phase':
          if (e.phase === 'serve_motion' || e.phase === 'rally') this.hud.setPrompt(null);
          if (e.phase === 'match_over' && live) {
            if (this.net) this.finishOnline(this.sim.match.scoring.matchWinner === 0, false);
            else this.endMatch();
          }
          break;
        case 'fault':
          v.lastHitTeam = -1;
          if (!live) break;
          this.hud.flash('Faute', FAULTS[e.reason] ?? '', 1.4);
          this.sound.say('Faute');
          break;
        case 'let':
          v.lastHitTeam = -1;
          if (!live) break;
          this.hud.flash('Let', 'Service à rejouer', 1.4);
          this.sound.say('Let');
          break;
        case 'point': {
          const lastHitBy = v.lastHitBy;
          const overhit = v.lastPower > OVER_START;
          v.lastHitTeam = -1;
          // The crowd and the slow motion celebrate your pair's winners, not the opponents'.
          const ours = e.winner === 0 || !live;
          this.sound.applause(e.winnerShot && ours ? 0.9 : 0.4);
          if (e.winnerShot && ours) this.slowUntil = this.clock + 1.3;
          if (!live) break;
          if (e.winner === 0) {
            this.summary.pointsWon++;
            if (e.reason === 'ace') this.summary.aces++;
            if (e.winnerShot) this.summary.winners++;
          } else this.summary.pointsLost++;
          this.summary.longestRally = Math.max(this.summary.longestRally, this.sim.rallyHits);
          const s = this.sim.match.scoring;
          const mine = e.winner === 0;
          let main = mine ? 'Point pour vous' : 'Point adverse';
          if (e.match) main = mine ? 'Jeu, set et match !' : 'Match perdu';
          else if (e.set) main = mine ? 'Set gagné !' : 'Set perdu';
          else if (e.game) main = mine ? 'Jeu pour vous' : 'Jeu adverse';
          this.hud.flash(main, pointReason(e.reason, mine, lastHitBy, overhit), 2.2);
          this.hud.updateScore(s, this.sim.match.referee.server);
          if (mine && this.settings.haptics) vibrate(40);
          let text = s.announcement();
          if (e.match) text = 'Jeu, set et match';
          else if (e.set) text = 'Jeu et set';
          else if (e.game) text = 'Jeu';
          this.pendingAnnounce = { at: this.clock + 1.5, text };
          break;
        }
      }
    }
  }

  private endMatch(): void {
    const s = this.sim.match.scoring;
    const won = s.matchWinner === 0;
    this.summary.won = won;
    const mode = modeById(this.mode);
    // A lone tie-break is told by its points, a match by its sets.
    const score =
      mode.match.tiebreakAt === 0
        ? `${this.summary.pointsWon}-${this.summary.pointsLost}`
        : s.completedSets.map((x) => `${x[0]}-${x[1]}`).join('  ');
    const title = mode.id === 'tournament' ? TOURNAMENT_ROUNDS[this.profile.tournamentRound].name : mode.name;
    const r = applyMatch(this.profile, this.summary);
    const coin =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="#c9d0d8" stroke="#5e6977" stroke-width="1"/><circle cx="8" cy="8" r="5" fill="none" stroke="#7b8592" stroke-width=".8"/><path d="M3.4 5.2c2.6 1.2 2.6 4.4 0 5.6M12.600 5.200c-2.600 1.200-2.600 4.400 0 5.600" fill="none" stroke="#49525e" stroke-width="1.1" stroke-linecap="round"/></svg>';
    this.controls.setEnabled(false);
    this.playing = false;
    this.hud.clearBanner();
    this.hud.setPrompt(null);
    this.menu.show('end', {
      inMatch: false,
      endHtml: `
        <div class="result-kicker">${title}</div>
        <h2 class="result-title ${won ? '' : 'lost'}">${won ? 'Victoire' : 'Défaite'}</h2>
        <p class="final-score">Score : <b>${score}</b></p>
        <div class="gains">
          <div class="gain">${coin}<b>+${r.coins}</b> pièces</div>
          <div class="gain"><b>+${r.xp}</b> XP · niveau ${levelOf(this.profile.xp).level}</div>
        </div>
        ${r.notes.length ? `<ul class="result-notes">${r.notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}`,
    });
    saveSettings(this.settings);
  }

  /** Debug access for automated checks. */
  get debug() {
    return { game: this, three: THREE };
  }
}
