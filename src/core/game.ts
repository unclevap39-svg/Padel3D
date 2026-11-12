import * as THREE from 'three';
import { Sound } from '../audio/sound';
import { BallView } from '../entities/ball';
import { CharacterView, type Outfit } from '../entities/character';
import { SkinnedBody, loadPlayerModel } from '../entities/skinned';
import { TouchControls, vibrate } from '../input/touch';
import { TICK_DT } from '../physics/world';
import { AdaptiveQuality } from '../render/adaptive';
import { CameraRig } from '../render/camera';
import { type QualityTier, Stage } from '../render/stage';
import { Home, type HomeTab } from '../ui/home';
import { Hud } from '../ui/hud';
import { Menu, isMobile } from '../ui/menu';
import {
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
import { Simulation } from './sim';
import type { Difficulty, SimEvent } from './types';

const REASONS: Record<string, string> = {
  double_fault: 'Double faute',
  second_bounce: 'Point gagnant',
  ace: 'Ace',
  net: 'Dans le filet',
  wall_direct: 'Vitre directe',
  fence_direct: 'Grillage direct',
  out: 'Dehors',
  out_after_bounce: 'Balle sortie du terrain',
  volley_on_serve: 'Volée interdite sur le service',
  double_hit: 'Double touche',
};

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
  sim: Simulation;
  private settings: Settings;
  private ball = new BallView();
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
      onHelp: () => {
        this.home.show(false);
        this.menu.show('help', { inMatch: false });
      },
      onInstall: () => {
        this.home.show(false);
        this.menu.show('install', { inMatch: false });
      },
    });
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
    this.controls.onShot = (intent) => {
      this.sound.unlock();
      this.sim.humanShot(intent);
    };

    // Home screen: the four players stand on court, the camera frames your character.
    this.sim = this.makeSim(false);
    this.camera.hero = { zoom: 1 };
    this.camera.setBaseFov(this.stage.camera.fov);
    this.applyLoadout(this.profile.equipped);
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
      this.characters.forEach((c, i) => {
        c.setBody(new SkinnedBody(model, c.outfit, !!OUTFITS[i].darkSkin), model.proportions);
      });
      return true;
    } catch (err) {
      console.warn('Modèle de joueur indisponible, mannequins conservés', err);
      return false;
    }
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
    return new Simulation({ difficulty, assist, humanControlled: human, match: m?.match });
  }

  /** Puts shop items on your pair, your racket, the ball and the court. */
  applyLoadout(loadout: Record<ItemKind, string>): void {
    if (this.shown.outfit !== loadout.outfit) {
      const o = itemById(loadout.outfit);
      for (const i of [0, 1]) {
        this.characters[i].setOutfit({ ...OUTFITS[i], shirt: o.color, shorts: o.color2 ?? OUTFITS[i].shorts });
      }
    }
    if (this.shown.racket !== loadout.racket) {
      const r = itemById(loadout.racket);
      this.characters[0].setRacket(r.color, r.color2 ?? 0x14161a);
    }
    if (this.shown.court !== loadout.court) this.stage.court.turfMaterial.color.setHex(itemById(loadout.court).color);
    if (this.shown.ball !== loadout.ball) this.ball.setColor(itemById(loadout.ball).color);
    this.shown = { ...loadout };
  }

  /** Home camera: closer in the shop and the locker room, wider elsewhere. */
  private frameHero(tab: HomeTab): void {
    const zoom = tab === 'shop' || tab === 'locker' ? 0.86 : tab === 'play' ? 1 : 1.12;
    if (this.camera.hero) this.camera.hero.zoom = zoom;
  }

  showHome(): void {
    this.menu.show(null, { inMatch: false });
    this.home.show(true);
  }

  private applySettings(): void {
    const s = this.settings;
    this.sound.setEnabled(s.sound);
    this.sound.voice = s.voice;
    if (this.sim && this.modeAssist === null) this.sim.config.assist = s.assist;
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
    this.sound.unlock();
    this.sound.startCrowd();
    this.mode = mode;
    this.summary = { mode, won: false, pointsWon: 0, pointsLost: 0, aces: 0, winners: 0, longestRally: 0 };
    this.applyLoadout(this.profile.equipped);
    this.home.show(false);
    this.sim = this.makeSim(true, mode);
    this.sim.startMatch(firstServer);
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
    this.paused = true;
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
    this.playing = false;
    this.paused = false;
    this.controls.setEnabled(false);
    this.hud.show(false);
    this.hud.setPrompt(null);
    this.sim = this.makeSim(false);
    this.camera.orbit = false;
    this.camera.hero = { zoom: 1 };
    this.camera.focus = 0;
    this.timeScale = 1;
    this.camera.snap(this.stage.camera, this.sim.players[0]);
    this.showHome();
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
      const target = this.clock < this.slowUntil ? 0.28 : 1;
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
      this.handleEvents(this.sim.drainEvents());

      const b = this.sim.world.ball;
      this.ballPos.x = b.px;
      this.ballPos.y = b.py;
      this.ballPos.z = b.pz;
      const live = this.sim.phase === 'rally' || this.sim.phase === 'serve_motion';
      for (let i = 0; i < 4; i++) {
        this.characters[i].update(simDt, this.sim.players[i], this.sim.now, this.ballPos, live);
      }
      this.ball.update(b, this.sim.world.ballRotation(), this.stage.camera);
      this.camera.update(this.stage.camera, dt, this.sim.players[0], this.ballPos);
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

  private handleEvents(events: SimEvent[]): void {
    const live = this.playing;
    for (const e of events) {
      switch (e.kind) {
        case 'hit':
          this.sound.hit(Math.min(1, e.speedKmh / 120));
          if (live) {
            this.hud.setSpeed(e.speedKmh);
            if (e.player === 0 && this.settings.haptics) vibrate(e.stroke === 'smash' ? 35 : 18);
          }
          break;
        case 'bounce':
          this.sound.bounce(e.surface, e.speed);
          break;
        case 'serve_ready':
          if (!live) break;
          this.hud.updateScore(this.sim.match.scoring, e.server);
          if (e.server === 0) {
            this.hud.setPrompt(e.serveNumber === 2 ? 'Second service — glissez pour servir en diagonale' : 'Glissez pour servir en diagonale');
          } else this.hud.setPrompt(null);
          break;
        case 'phase':
          if (e.phase === 'serve_motion' || e.phase === 'rally') this.hud.setPrompt(null);
          if (e.phase === 'match_over' && live) this.endMatch();
          break;
        case 'fault':
          if (!live) break;
          this.hud.flash('Faute', FAULTS[e.reason] ?? '', 1.4);
          this.sound.say('Faute');
          break;
        case 'let':
          if (!live) break;
          this.hud.flash('Let', 'Service à rejouer', 1.4);
          this.sound.say('Let');
          break;
        case 'point': {
          this.sound.applause(e.winnerShot ? 0.9 : 0.45);
          if (e.winnerShot) this.slowUntil = this.clock + 1.3;
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
          this.hud.flash(main, REASONS[e.reason] ?? '', 2.2);
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
      '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#f6c93a"/><circle cx="10" cy="10" r="6.2" fill="none" stroke="#b8860b" stroke-width="1.4"/></svg>';
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
