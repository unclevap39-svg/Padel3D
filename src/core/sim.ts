import { Ai } from '../ai/brain';
import { type Intercept, MAX_HIT_HEIGHT, MIN_HIT_HEIGHT, REACH, bestIntercept, swingContact } from '../ai/intercept';
import { Player } from '../entities/player';
import { BALL_RADIUS, type BallState, type Prediction, type ShotSpec, predict, solveShot } from '../physics/ballistics';
import { MAX_SPIN, PhysicsWorld, TICK_DT } from '../physics/world';
import { COURT, type PlayerId, type Team, otherTeam, serverXSign, serviceBoxXSign, teamOf } from '../rules/court';
import { Match, type MatchEvent } from '../rules/match';
import type { MatchConfig } from '../rules/scoring';
import { MAX_HOLD, aimTarget, classify, gaugeAt, humanSigma, overError, shotPace } from './shots';
import {
  AI_LEVELS,
  type AiLevel,
  type Difficulty,
  type ShotIntent,
  type ShotType,
  type SimEvent,
  type SimPhase,
  type StrokeKind,
  type Swing,
} from './types';

export interface SimConfig {
  difficulty: Difficulty;
  /** 0..1 aim and positioning help for the human player. */
  assist: number;
  /** False runs player 0 on AI as well (demo and tests). */
  humanControlled: boolean;
  /** Players driven by people; overrides `humanControlled` (online: one per team). */
  humans?: PlayerId[];
  /** Assist level of each human player, when it differs from `assist`. */
  assistBy?: Partial<Record<PlayerId, number>>;
  /** One against one: players 1 and 3 stay off the court. */
  singles?: boolean;
  match?: Partial<MatchConfig>;
  seed?: number;
}

const HUMAN_SPEED = 6.0;
/** Time from the start of a swing to contact. */
export const SWING_LEAD = 0.26;
const SWING_RECOVERY = 0.42;
/** A swing at thin air is over quickly, so the next press is not lost. */
const MISS_RECOVERY = 0.15;
/** A press is remembered this long while no ball can be struck yet. */
const PRESS_BUFFER = 1.0;
/** Sim seconds between the end of a point and the players walking back, then the next point. */
const POINT_WALK_AT = 1.3;
const POINT_OVER_TIME = 2.4;
/** Pause after a fault or a let before everyone goes back to their serve position. */
const FAULT_PAUSE = 0.9;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A shot button being held, or just released: the shot waits for the ball to come within reach. */
interface Charge {
  type: ShotType;
  /** Time the button went down. */
  t0: number;
  /** Gauge level fixed when the button was released; null while it is held. */
  power: number | null;
  releasedT: number;
  /** Aim fixed with the press (scripted taps); otherwise read from the stick at contact. */
  aim?: number;
  /** The swing has started. */
  swinging: boolean;
  /** Where the player stands for the swing in progress. */
  stance: { x: number; z: number } | null;
}
/** Serve: ball dropped at this time before the racket meets it after its bounce. */
const SERVE_DROP_TIME = 0.63;
/** Where the server holds and drops the ball, relative to the body: racket side, in front. */
const SERVE_DROP_X = 0.36;
const SERVE_DROP_Z = 0.42;

function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The whole game without any rendering: four players, the ball, the match rules and the flow of
 * a point (positioning, serve, rally, pause). Deterministic for a given seed and inputs, so it
 * can be fast-forwarded in tests.
 */
export class Simulation {
  readonly world = new PhysicsWorld();
  readonly players: Player[] = [new Player(0), new Player(1), new Player(2), new Player(3)];
  readonly config: SimConfig;
  readonly random: () => number;
  readonly ai: Ai;
  match: Match;
  phase: SimPhase = 'idle';
  /** Simulation clock, seconds. */
  now = 0;
  /** Events since the last drain, for the view, audio and HUD. */
  events: SimEvent[] = [];
  prediction: Prediction | null = null;
  predT0 = 0;
  /** Planned contact for each player of the team that must play next. */
  plans: Array<Intercept | null> = [null, null, null, null];
  hitterId: PlayerId | null = null;
  /** Ball held in the server's hand (not simulated). */
  ballHeld = true;
  lastHitT = 0;
  lastHitBy: PlayerId | null = null;
  /** Per-team: will this pair move up to the net during this point? */
  aggressive: [boolean, boolean] = [true, true];
  /** Receiving team decided not to play a ball that is going out. */
  leaveBall = false;
  /** The ball in flight will not land in: it should be left alone. Cleared at its first bounce. */
  ballGoingOut = false;
  rallyHits = 0;
  /** The shot struck last: where it was aimed and how (for tests and tuning). */
  lastShot: ShotSpec | null = null;

  private phaseT = 0;
  private charges: Array<Charge | null> = [null, null, null, null];
  /** Stick of each human player, -1..1 towards their right: where their next shot is aimed. */
  private aimInput = [0, 0, 0, 0];
  private designatedSince = 0;
  /** Players are already walking back to their serve positions (end of a point). */
  private walking = false;
  private serveFreezeUntil = 0;
  /** Players on court: all four in doubles, one per side in singles. */
  active: Player[] = [];
  readonly singles: boolean;
  private matchConfig: Partial<MatchConfig>;
  private pendingServe: ShotIntent | null = null;
  private serveContactT = 0;
  private aiServeAt = 0;
  private groundedT = 0;
  private lastEventT = 0;
  private replanAt = 0;
  private stillT = 0;

  constructor(config: SimConfig) {
    this.config = config;
    this.random = mulberry(config.seed ?? (Math.random() * 2 ** 32) >>> 0);
    this.world.random = this.random;
    this.singles = !!config.singles;
    this.matchConfig = { ...config.match, singles: this.singles };
    this.match = new Match(this.matchConfig, 0);
    this.ai = new Ai(this);
    const humans = config.humans ?? (config.humanControlled ? [0 as PlayerId] : []);
    for (const id of humans) this.players[id].isHuman = true;
    this.active = this.singles ? [this.players[0], this.players[2]] : [...this.players];
    for (const q of this.players) q.active = this.active.includes(q);
    this.applyLevels();
    this.layoutIdle();
  }

  // ---------------------------------------------------------------------------------------------
  // Setup

  levelOf(p: Player): AiLevel {
    return this.teamLevel(p.team);
  }

  /** Your partner plays at the opponents' level, but never below a steady club level. */
  private teamLevel(team: Team): AiLevel {
    if (team === 0 && this.config.difficulty === 'easy') return AI_LEVELS.medium;
    return AI_LEVELS[this.config.difficulty];
  }

  private applyLevels(): void {
    for (const p of this.active) p.maxSpeed = p.isHuman ? HUMAN_SPEED : this.levelOf(p).maxSpeed;
  }

  private layoutIdle(): void {
    for (const p of this.players) p.place(p.homeSign * 2.5, p.sideSign * 6.5);
    this.holdBallAt(this.players[0]);
  }

  startMatch(firstServer?: PlayerId): void {
    const server = firstServer ?? ((this.random() < 0.5 ? 0 : 2) as PlayerId);
    this.match = new Match(this.matchConfig, server);
    this.now = 0;
    this.events.length = 0;
    this.charges = [null, null, null, null];
    this.applyLevels();
    this.beginPoint();
  }

  get server(): Player {
    return this.players[this.match.referee.server];
  }

  teamPlayers(team: Team): Player[] {
    return this.active.filter((p) => p.team === team);
  }

  private setPhase(phase: SimPhase): void {
    this.phase = phase;
    this.phaseT = 0;
    this.events.push({ kind: 'phase', phase });
  }

  /** Where everyone stands for the next serve. */
  private servePositions(): Array<{ x: number; z: number }> {
    const ref = this.match.referee;
    const server = this.players[ref.server];
    const sx = serverXSign(server.team, ref.serveSide);
    const out: Array<{ x: number; z: number }> = [];
    if (this.singles) {
      // One player per side: the server in the serving half, the receiver in the diagonal box.
      for (const p of this.active) {
        p.zone = p.homeSign;
        out[p.id] = p === server ? { x: sx * 2.1, z: p.sideSign * 7.75 } : { x: -sx * 2.5, z: p.sideSign * 8.5 };
      }
      return out;
    }
    for (const p of this.active) {
      if (p.team === server.team) {
        if (p === server) {
          p.zone = sx;
          out[p.id] = { x: sx * 2.1, z: p.sideSign * 7.75 };
        } else {
          p.zone = -sx as 1 | -1;
          out[p.id] = { x: -sx * 2.6, z: p.sideSign * 3.0 };
        }
      } else {
        p.zone = p.homeSign;
        const box = -sx; // diagonal box
        const receiver = p.homeSign === box;
        out[p.id] = receiver ? { x: box * 2.7, z: p.sideSign * 8.7 } : { x: -box * 2.6, z: p.sideSign * 7.1 };
      }
    }
    return out;
  }

  private beginPoint(): void {
    const spots = this.servePositions();
    for (const p of this.active) {
      p.moveTo = spots[p.id];
      p.swing = null;
      p.mood = 'play';
    }
    for (const t of [0, 1] as const) this.aggressive[t] = this.random() < this.teamLevel(t).netRush;
    this.rallyHits = 0;
    this.leaveBall = false;
    this.ballGoingOut = false;
    this.walking = false;
    this.hitterId = null;
    this.plans = [null, null, null, null];
    this.prediction = null;
    this.pendingServe = null;
    this.ballHeld = true;
    this.setPhase('positioning');
  }

  // ---------------------------------------------------------------------------------------------
  // Input from the human player

  /** Movement request for a human player, in world axes. */
  setMove(id: PlayerId, x: number, z: number): void {
    const p = this.players[id];
    if (!p.isHuman) return;
    p.wishX = x;
    p.wishZ = z;
  }

  /** A human player put a thumb on a shot button: the gauge starts to fill. */
  press(id: PlayerId, type: ShotType): void {
    if (!this.players[id].isHuman) return;
    if (this.charges[id]?.swinging) return; // committed to the swing in progress
    this.charges[id] = { type, t0: this.now, power: null, releasedT: 0, swinging: false, stance: null };
  }

  /** The button was released: the gauge stops there. The ball is struck when it comes within reach. */
  release(id: PlayerId): void {
    const c = this.charges[id];
    if (!c || c.power !== null) return;
    c.power = gaugeAt(this.now - c.t0);
    c.releasedT = this.now;
  }

  /** The press is called off (menu opened, page hidden): nothing is played, unless the swing has started. */
  cancel(id: PlayerId): void {
    if (this.charges[id] && !this.charges[id]!.swinging) this.charges[id] = null;
  }

  /** Where a human player's stick points, -1..1 towards their right: read when the ball is struck. */
  setAim(id: PlayerId, aim: number): void {
    this.aimInput[id] = clamp(aim, -1, 1);
  }

  /** A complete press and release at once, with a set power and aim (scripts and tests). */
  shot(id: PlayerId, intent: ShotIntent): void {
    if (!this.players[id].isHuman) return;
    if (this.charges[id]?.swinging) return;
    this.charges[id] = {
      type: intent.type,
      t0: this.now,
      power: clamp(intent.power, 0, 1),
      releasedT: this.now,
      aim: intent.aim,
      swinging: false,
      stance: null,
    };
  }

  setHumanMove(x: number, z: number): void {
    this.setMove(0, x, z);
    this.setAim(0, x);
  }

  humanPress(type: ShotType): void {
    this.press(0, type);
  }

  humanRelease(): void {
    this.release(0);
  }

  humanCancel(): void {
    this.cancel(0);
  }

  humanShot(intent: ShotIntent): void {
    this.shot(0, intent);
  }

  /** Shot a human player is preparing, for the gauge display. */
  chargeOf(id: PlayerId): { type: ShotType; gauge: number; held: boolean } | null {
    const c = this.charges[id];
    if (!c) return null;
    return { type: c.type, gauge: c.power ?? gaugeAt(this.now - c.t0), held: c.power === null };
  }

  humanCharge(): { type: ShotType; gauge: number; held: boolean } | null {
    return this.chargeOf(0);
  }

  /** Ball state to predict from, and the time it was taken at (same shape as the online guest's). */
  viewBall(): { ball: BallState; t: number; stale: boolean } {
    return { ball: this.world.ball, t: this.now, stale: false };
  }

  /** Aim and placement help for a human player. */
  assistOf(p: Player): number {
    return this.config.assistBy?.[p.id] ?? this.config.assist;
  }

  // ---------------------------------------------------------------------------------------------
  // Main tick

  tick(): void {
    this.now += TICK_DT;
    this.phaseT += TICK_DT;
    const dt = TICK_DT;
    this.updateCharges();

    switch (this.phase) {
      case 'idle':
        return;
      case 'positioning': {
        this.holdBallAt(this.server);
        const settled = this.active.every((p) => !p.moveTo || p.distanceTo(p.moveTo.x, p.moveTo.z) < 0.15);
        if ((settled && this.phaseT > 0.3) || this.phaseT > 3.5) {
          for (const p of this.active) {
            if (p.moveTo && this.phaseT > 3.5) p.place(p.moveTo.x, p.moveTo.z);
          }
          this.enterServeReady();
        }
        break;
      }
      case 'serve_ready': {
        this.holdBallAt(this.server);
        const server = this.server;
        if (server.isHuman) {
          // The serve leaves when the button is released, at the power reached on the gauge.
          const c = this.charges[server.id];
          if (c && c.power !== null) {
            this.charges[server.id] = null;
            this.startServe({ type: 'drive', power: c.power, aim: c.aim });
          }
        } else if (this.now >= this.aiServeAt) {
          this.startServe(this.ai.serveIntent(server));
        }
        break;
      }
      case 'serve_motion': {
        this.world.tick();
        for (const c of this.world.contacts) this.events.push({ kind: 'bounce', ...c });
        if (this.now >= this.serveContactT) this.strikeServe();
        break;
      }
      case 'rally': {
        this.updateRally();
        break;
      }
      case 'pause': {
        this.world.tick();
        this.emitBounces();
        // Fault or let: everyone walks back to their serve position before the next ball.
        if (this.phaseT > FAULT_PAUSE) this.beginPoint();
        break;
      }
      case 'point_over': {
        this.world.tick();
        this.emitBounces();
        if (!this.walking && !this.match.over && this.phaseT > POINT_WALK_AT) {
          // Start walking back while the score is still on screen: less waiting between points.
          this.walking = true;
          const spots = this.servePositions();
          for (const p of this.active) {
            p.moveTo = spots[p.id];
            p.mood = 'play';
          }
        }
        if (this.phaseT > POINT_OVER_TIME) {
          if (this.match.over) this.setPhase('match_over');
          else this.beginPoint();
        }
        break;
      }
      case 'match_over':
        this.world.tick();
        break;
    }

    this.updateHumanAssist();
    for (const p of this.active) p.update(dt, this.now);
    this.separatePartners();
    this.finishSwings();
  }

  private emitBounces(): void {
    for (const c of this.world.contacts) this.events.push({ kind: 'bounce', ...c });
  }

  /** Forgets presses that can no longer lead to a shot, and releases a button held too long. */
  private updateCharges(): void {
    for (const p of this.active) {
      const c = this.charges[p.id];
      if (!c || c.swinging) continue;
      if (c.power === null) {
        if (this.now - c.t0 > MAX_HOLD) {
          c.power = 1;
          c.releasedT = this.now;
        }
        continue;
      }
      // During a rally (or a serve on its way) the press waits for the ball: see updateHumanSwings.
      if (this.phase === 'rally' || this.phase === 'serve_motion') continue;
      if (this.phase === 'serve_ready' && p === this.server) continue;
      if (this.now - c.releasedT > 0.4) this.charges[p.id] = null;
    }
  }

  private enterServeReady(): void {
    const server = this.server;
    // Server and receivers stand still for the serve; a human receiver may still adjust.
    for (const p of this.active) {
      p.moveTo = null;
      if (!p.isHuman) {
        p.wishX = 0;
        p.wishZ = 0;
      }
    }
    this.ballHeld = true;
    // A button already held by the server starts charging now, not while walking to the spot;
    // a press already released while walking is forgotten: the serve is never dosed blind.
    for (const p of this.active) {
      const c = this.charges[p.id];
      if (!c) continue;
      if (c.power !== null) this.charges[p.id] = null;
      else if (p === server) c.t0 = this.now;
    }
    this.aiServeAt = this.now + 0.9 + this.random() * 0.5;
    this.setPhase('serve_ready');
    this.events.push({ kind: 'serve_ready', server: server.id, serveNumber: this.match.referee.serveNumber });
  }

  /** Hand in which the server holds the ball before dropping it. */
  private holdBallAt(p: Player): void {
    this.ballHeld = true;
    for (const q of this.active) q.holdingBall = q === p;
    this.world.setBall({
      px: p.x + p.rightX * SERVE_DROP_X,
      py: 1.02,
      pz: p.z + p.dir * SERVE_DROP_Z,
      vx: 0,
      vy: 0,
      vz: 0,
      wx: 0,
      wy: 0,
      wz: 0,
    });
  }

  private startServe(intent: ShotIntent): void {
    const p = this.server;
    this.pendingServe = intent;
    this.ballHeld = false;
    // Drop the ball in front of the racket side; it bounces once and is struck below the waist.
    p.holdingBall = false;
    this.world.setBall({
      px: p.x + p.rightX * SERVE_DROP_X,
      py: 1.0,
      pz: p.z + p.dir * SERVE_DROP_Z,
      vx: 0,
      vy: -1.0,
      vz: 0,
      wx: 0,
      wy: 0,
      wz: 0,
    });
    this.serveContactT = this.now + SERVE_DROP_TIME;
    const swing: Swing = {
      stroke: 'serve',
      intent,
      startT: this.now,
      contactT: this.serveContactT,
      endT: this.serveContactT + SWING_RECOVERY,
      contact: { x: p.x + p.rightX * SERVE_DROP_X, y: 0.55, z: p.z + p.dir * SERVE_DROP_Z },
      willHit: true,
      resolved: false,
    };
    p.swing = swing;
    p.moveTo = null;
    p.wishX = 0;
    p.wishZ = 0;
    // The server's feet stay put through the motion: the stick only aims the serve.
    this.serveFreezeUntil = this.serveContactT + 0.15;
    this.events.push({ kind: 'swing', player: p.id, swing });
    this.setPhase('serve_motion');
  }

  private strikeServe(): void {
    const p = this.server;
    const swing = p.swing;
    if (!swing || !this.pendingServe) return;
    swing.resolved = true;
    this.setPhase('rally');
    this.lastEventT = this.now;
    this.groundedT = 0;
    this.stillT = 0;
    this.match.serveStruck();
    this.strike(p, swing, true);
  }

  // ---------------------------------------------------------------------------------------------
  // Rally

  private updateRally(): void {
    if (this.now >= this.replanAt) {
      this.assignHitter();
      this.replanAt = this.now + 0.12;
    }
    this.updateHumanSwings();
    this.ai.update();
    this.resolveSwings();
    if (this.phase !== 'rally') return;

    this.world.tick();
    let changed = false;
    for (const c of this.world.contacts) {
      this.events.push({ kind: 'bounce', ...c });
      this.lastEventT = this.now;
      changed = true;
      if (c.surface === 'floor') this.ballGoingOut = false;
      const ev = c.surface === 'ground' ? this.match.out() : this.match.bounce(c.surface, c.x, c.z);
      if (this.handleMatchEvent(ev)) return;
    }
    if (changed) this.onBallChanged();

    // A ball that rolls or dies never produces another contact: call it.
    const b = this.world.ball;
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    const inside = Math.abs(b.px) <= COURT.halfWidth && Math.abs(b.pz) <= COURT.halfLength;
    if (inside && b.py < BALL_RADIUS + 0.025 && Math.abs(b.vy) < 0.7) this.groundedT += TICK_DT;
    else this.groundedT = 0;
    this.stillT = speed < 0.35 ? this.stillT + TICK_DT : 0;
    let ev: MatchEvent | null = null;
    if (this.groundedT > 0.22) {
      ev = this.match.bounce('floor', b.px, b.pz);
      this.groundedT = 0;
    } else if (this.stillT > 0.8 || this.now - this.lastEventT > 7 || b.py < -1) {
      ev = inside && b.py < 0.5 ? this.match.bounce('floor', b.px, b.pz) : this.match.out();
      this.stillT = 0;
      this.lastEventT = this.now;
    }
    this.handleMatchEvent(ev);
  }

  /** Returns true when the rally stopped. */
  private handleMatchEvent(ev: MatchEvent | null): boolean {
    if (!ev) return false;
    if (ev.kind === 'let') {
      this.events.push({ kind: 'let' });
      this.endRally();
      this.setPhase('pause');
      return true;
    }
    if (ev.kind === 'fault') {
      this.events.push({ kind: 'fault', serveNumber: ev.serveNumber, reason: ev.reason });
      this.endRally();
      this.setPhase('pause');
      return true;
    }
    const winnerShot = ev.reason === 'second_bounce' || ev.reason === 'out_after_bounce' || ev.reason === 'ace';
    this.events.push({
      kind: 'point',
      winner: ev.winner,
      reason: ev.reason,
      winnerShot,
      game: ev.score.some((s) => s.kind === 'game'),
      set: ev.score.some((s) => s.kind === 'set'),
      match: ev.score.some((s) => s.kind === 'match'),
    });
    for (const p of this.active) p.mood = p.team === ev.winner ? 'celebrate' : 'dejected';
    this.endRally();
    this.setPhase('point_over');
    return true;
  }

  private endRally(): void {
    this.hitterId = null;
    this.plans = [null, null, null, null];
    // A thumb still on a button keeps it: the gauge simply starts again for the next ball.
    this.charges = this.charges.map((c) => (c && c.power === null && !c.swinging ? { ...c, t0: this.now, stance: null } : null));
    this.ballGoingOut = false;
    for (const p of this.active) {
      p.moveTo = null;
      p.runSpeed = null;
      p.prep = null;
      if (!p.isHuman) {
        p.wishX = 0;
        p.wishZ = 0;
      }
    }
  }

  private onBallChanged(): void {
    const ref = this.match.referee;
    this.prediction = predict(this.world.ball, 4, ref.floorBounces);
    this.predT0 = this.now;
    this.replanAt = 0;
  }

  /** Decide which player of the team that must play next takes the ball. */
  private assignHitter(): void {
    const ref = this.match.referee;
    const pred = this.prediction;
    if (!pred || (ref.phase !== 'rally' && ref.phase !== 'serve_flight')) {
      this.hitterId = null;
      return;
    }
    const receiving = otherTeam(ref.lastHitTeam);
    const before = this.hitterId;
    let bestP: Player | null = null;
    let bestScore = -Infinity;
    // A partner already swinging at this ball keeps it: the other one does not lurch towards it.
    let committed: Player | null = null;
    for (const p of this.active) {
      if (p.team !== receiving) {
        this.plans[p.id] = null;
        continue;
      }
      if (p.swing && !p.swing.resolved) {
        if (p.swing.willHit) committed = p;
        continue;
      }
      const charge = p.isHuman ? this.charges[p.id] : null;
      const reaction = p.isHuman ? 0 : Math.max(0, this.lastHitT + this.levelOf(p).reaction - this.now);
      const ic = bestIntercept(p, pred, {
        now: this.now,
        predT0: this.predT0,
        mustBounce: ref.isServeInFlight,
        reaction,
        minLead: p.isHuman ? 0.04 : 0.1,
        wantOverhead: charge?.type === 'smash',
        wallRead: p.isHuman ? 0.08 : 0.16 + 0.2 * (1 - this.levelOf(p).placement),
      });
      this.plans[p.id] = ic;
      if (!ic) continue;
      let score = ic.score;
      if (ic.ball.x * p.zone > 0.3) score += 1.6; // the ball is in my half
      if (this.hitterId === p.id) score += 0.5; // do not dither between partners
      if (charge) score += 2.5; // a player who pressed a shot button wants this ball
      if (score > bestScore) {
        bestScore = score;
        bestP = p;
      }
    }
    if (committed) bestP = committed;
    this.hitterId = bestP ? bestP.id : null;
    if (this.hitterId !== before) this.designatedSince = this.now;
    // The player about to hit takes the racket back early, as the ball approaches.
    for (const p of this.active) p.prep = null;
    const plan = bestP && bestP !== committed ? this.plans[bestP.id] : null;
    if (bestP && plan && (bestP.isHuman || !this.leaveBall)) {
      const stroke: StrokeKind = plan.overhead
        ? this.charges[bestP.id]?.type === 'smash'
          ? 'smash'
          : 'bandeja'
        : plan.volley
          ? plan.backhand
            ? 'volley_bh'
            : 'volley_fh'
          : plan.backhand
            ? 'backhand'
            : 'forehand';
      bestP.prep = { stroke, t: plan.t };
    }
  }

  /** True when the placement help runs this human player to the ball. */
  private autoMoves(p: Player): boolean {
    return this.assistOf(p) > 0.02;
  }

  /**
   * Human players' shots. A press is not a swing: it is remembered, the player gets to the
   * ball, and the swing starts by itself at the right moment. Holding the button only decides
   * how hard the ball is struck.
   */
  private updateHumanSwings(): void {
    const ref = this.match.referee;
    const live = !!this.prediction && (ref.phase === 'rally' || ref.phase === 'serve_flight');
    for (const p of this.active) {
      if (!p.isHuman) continue;
      const c = this.charges[p.id];
      if (!c || c.swinging) continue;
      if (p.swing && p.swing.willHit && this.now < p.swing.endT - 0.12) continue; // finishing the last stroke
      const incoming = live && ref.lastHitTeam !== p.team;
      if (!incoming) c.stance = null;
      // A ball that is going out is left alone, unless the button was pressed after it was struck.
      if (incoming && this.ballGoingOut && c.t0 < this.lastHitT) continue;
      let ic: Intercept | null = null;
      if (incoming) {
        ic = this.autoMoves(p)
          ? this.plans[p.id]
          : swingContact(p, this.prediction!, {
              now: this.now,
              predT0: this.predT0,
              mustBounce: ref.isServeInFlight,
              minLead: 0.04,
              window: 0.55,
              wantOverhead: c.type === 'smash',
            });
      }
      if (ic) {
        c.stance = ic.stance;
        if (ic.t - this.now <= SWING_LEAD + TICK_DT * 0.5) {
          if (this.requestSwing(p, { type: c.type, power: c.power ?? 0, aim: c.aim }, ic)) {
            c.swinging = true;
            c.stance = ic.stance;
          }
        }
        continue;
      }
      // Nothing to strike. A held button keeps waiting; a released one is dropped after a moment,
      // but not while the player is still running after a ball at the edge of reach.
      if (c.power === null || this.now - c.releasedT < PRESS_BUFFER) continue;
      if (incoming && c.stance && this.autoMoves(p) && p.distanceTo(c.stance.x, c.stance.z) > 0.3) continue;
      this.charges[p.id] = null;
      const b = this.world.ball;
      const near = Math.hypot(b.px - p.x, b.pz - p.z) < 4 && b.pz * p.sideSign > 0;
      // The ball went by out of reach: the swing at thin air shows it.
      if (incoming && near) this.requestSwing(p, { type: c.type, power: c.power, aim: c.aim }, null);
    }
  }

  /** Starts a swing. With an intercept the racket is timed to meet the ball; without, it is a miss. */
  requestSwing(p: Player, intent: ShotIntent, ic: Intercept | null): boolean {
    if (p.swing && p.swing.willHit && this.now < p.swing.endT - 0.12) return false;
    let stroke: StrokeKind;
    let contactT: number;
    let contact: { x: number; y: number; z: number };
    if (ic) {
      if (ic.overhead) stroke = intent.type === 'smash' ? 'smash' : 'bandeja';
      else if (ic.volley) stroke = ic.backhand ? 'volley_bh' : 'volley_fh';
      else stroke = ic.backhand ? 'backhand' : 'forehand';
      contactT = Math.max(ic.t, this.now + 0.08);
      contact = ic.ball;
    } else {
      stroke = intent.type === 'smash' ? 'smash' : 'forehand';
      contactT = this.now + 0.22;
      contact = { x: p.x + p.rightX * 0.6, y: intent.type === 'smash' ? 2.3 : 0.9, z: p.z + p.dir * 0.3 };
    }
    const swing: Swing = {
      stroke,
      intent,
      startT: this.now,
      contactT,
      endT: contactT + (ic ? SWING_RECOVERY : MISS_RECOVERY),
      contact,
      willHit: ic !== null,
      resolved: false,
    };
    p.swing = swing;
    this.events.push({ kind: 'swing', player: p.id, swing });
    return true;
  }

  private resolveSwings(): void {
    for (const p of this.active) {
      const s = p.swing;
      if (!s || s.resolved || this.now < s.contactT) continue;
      s.resolved = true;
      if (!s.willHit) continue;
      // Whatever happens to this swing, the press that asked for it is used up.
      const charge = this.charges[p.id];
      if (charge?.swinging) this.charges[p.id] = null;
      const ref = this.match.referee;
      const b = this.world.ball;
      const d = Math.hypot(b.px - p.x, b.pz - p.z);
      const legal =
        (ref.phase === 'rally' || ref.phase === 'serve_flight') &&
        ref.lastHitTeam !== p.team &&
        b.pz * p.sideSign > -0.1 &&
        d <= REACH + 0.45 &&
        b.py >= MIN_HIT_HEIGHT - 0.08 &&
        b.py <= MAX_HIT_HEIGHT + 0.15;
      if (!legal) continue;
      const ev = this.match.hit(p.id);
      this.lastEventT = this.now;
      if (this.handleMatchEvent(ev)) return;
      if (p.isHuman && charge && !s.intent.target) {
        // Power: the gauge where it was released, or where it stands now if still held.
        // Aim: where the stick points as the ball is struck.
        s.intent = { type: charge.type, power: charge.power ?? gaugeAt(this.now - charge.t0), aim: charge.aim ?? this.aimInput[p.id] };
      }
      this.strike(p, s, false);
    }
  }

  private finishSwings(): void {
    for (const p of this.active) {
      if (p.swing && this.now >= p.swing.endT) p.swing = null;
    }
  }

  /** Sends the ball on its way from the racket. */
  private strike(p: Player, swing: Swing, isServe: boolean): void {
    const b = this.world.ball;
    // A ball struck right against a wall leaves from just inside it: otherwise the physics
    // would count the wall as touched again and the shot would be lost on the spot.
    const gapX = COURT.halfWidth - BALL_RADIUS - 0.08;
    const gapZ = COURT.halfLength - BALL_RADIUS - 0.08;
    const from = { x: clamp(b.px, -gapX, gapX), y: Math.max(b.py, 0.15), z: clamp(b.pz, -gapZ, gapZ) };
    if (isServe && p.isHuman && !swing.intent.target && swing.intent.aim === undefined) {
      swing.intent = { ...swing.intent, aim: this.aimInput[p.id] };
    }
    const spec = this.buildShot(p, swing, from, isServe);
    this.lastShot = spec;
    const sol = solveShot(spec);
    const state: BallState = {
      px: from.x,
      py: from.y,
      pz: from.z,
      vx: sol.vx,
      vy: sol.vy,
      vz: sol.vz,
      wx: sol.wx,
      wy: sol.wy,
      wz: sol.wz,
    };
    this.world.setBall(state);
    this.lastHitT = this.now;
    this.lastHitBy = p.id;
    this.lastEventT = this.now;
    this.groundedT = 0;
    this.stillT = 0;
    this.rallyHits++;
    this.leaveBall = false;
    for (const q of this.active) {
      q.prep = null;
      if (q.team !== p.team) q.splitT = this.now;
    }
    this.events.push({
      kind: 'hit',
      player: p.id,
      stroke: swing.stroke,
      speedKmh: Math.hypot(sol.vx, sol.vy, sol.vz) * 3.6,
      x: from.x,
      y: from.y,
      z: from.z,
      power: p.isHuman ? swing.intent.power : undefined,
    });
    this.onBallChanged();
    this.ai.onShot(p.team);
    this.assignHitter();
  }

  /** Translates an intent into a physical shot: landing point, pace and spin. */
  private buildShot(p: Player, swing: Swing, from: { x: number; y: number; z: number }, isServe: boolean): ShotSpec {
    const intent = swing.intent;
    const g = clamp(intent.power, 0, 1);
    const cls = classify(intent.type, swing.stroke, from.y, isServe);
    const pace = shotPace(cls, g);
    const fwd = p.dir; // z direction of the opponents' half
    const box = serviceBoxXSign(p.team, this.match.referee.serveSide);
    let tx: number;
    let tz: number;
    let clearance = pace.clearance;

    if (intent.target) {
      // The AI's targets are already chosen with its own aim error; only absurd values are cut.
      tx = intent.target.x;
      tz = intent.target.z;
      if (isServe) {
        tx = clamp(tx * box, -0.45, COURT.halfWidth + 0.45) * box;
        tz = fwd * clamp(Math.abs(tz), 1.2, COURT.serviceLineZ + 0.45);
      } else {
        tx = clamp(tx, -COURT.halfWidth - 0.9, COURT.halfWidth + 0.9);
        tz = fwd * clamp(Math.abs(tz), 1.5, COURT.halfLength + 0.8);
      }
      // Height error: now and then a shot is hit too low and catches the net.
      clearance += this.gauss() * this.levelOf(p).aimError * 0.2;
    } else {
      // Human: the stick chooses the landing point inside the court, the gauge the pace. The
      // ball then lands around that point: closer with the aim help, further when it is met
      // badly or overhit.
      const assist = this.assistOf(p);
      const d = Math.hypot(from.x - p.x, from.z - p.z);
      const quality = 1 - clamp((Math.abs(d - 0.62) - 0.3) / 0.9, 0, 1);
      const sigma = humanSigma(assist, quality, isServe);
      const t = aimTarget({ cls, g, aim: intent.aim ?? 0, from, rightX: p.rightX, fwd, assist, sigma, serveBox: isServe ? box : undefined });
      // The error is bounded: a shot that is neither overhit nor badly met stays inside the
      // margin kept by the aim, instead of flying out once in a while by sheer bad luck.
      const spread = sigma * overError(g);
      tx = t.x + clamp(this.gauss(), -2.2, 2.2) * spread;
      tz = t.z + clamp(this.gauss(), -2.2, 2.2) * spread * 1.2;
      clearance += this.gauss() * (0.6 - 0.42 * assist) * 0.18;
    }

    return {
      from,
      target: { x: tx, z: tz },
      speed: pace.speed,
      spin: pace.spin,
      spinRate: Math.min(pace.spinRate, MAX_SPIN),
      lob: pace.lob,
      lobAngle: pace.lobAngle,
      netClearance: clearance,
    };
  }

  gauss(): number {
    const u = Math.max(1e-9, this.random());
    const v = this.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers

  /**
   * Placement help for human players. With a shot button pressed the player runs to the ball
   * and the stick only aims; with the stick released the player drifts towards a ball that is
   * theirs. Otherwise the stick moves the player.
   */
  private updateHumanAssist(): void {
    for (const p of this.active) {
      if (!p.isHuman) continue;
      p.runSpeed = null;
      // Serving: feet planted from the moment the ball is in hand until just after the strike.
      const serving = p === this.server && (this.phase === 'serve_ready' || this.phase === 'serve_motion' || this.now < this.serveFreezeUntil);
      if (serving) {
        p.wishX = 0;
        p.wishZ = 0;
        p.moveTo = null;
        continue;
      }
      if (this.phase !== 'rally') continue; // walking to a serve position, or free between points
      p.moveTo = null;
      if (!this.autoMoves(p)) continue;
      const a = this.assistOf(p);
      const c = this.charges[p.id];
      const plan = this.plans[p.id];
      const leave = this.ballGoingOut && !!c && c.t0 < this.lastHitT;
      // The last planned stance is kept while the plan flickers: a ball at the very edge of
      // reach must not stop the run halfway.
      const goal = c && !leave ? (c.swinging ? c.stance : (plan?.stance ?? c.stance)) : null;
      if (c && goal) {
        // Committed to a shot: go to the ball flat out; the stick is the aim, not the legs.
        p.moveTo = goal;
        p.runSpeed = HUMAN_SPEED;
        p.wishX = 0;
        p.wishZ = 0;
        continue;
      }
      if (p.swing && !p.swing.resolved) continue;
      const stick = Math.hypot(p.wishX, p.wishZ);
      // In doubles, wait to be sure the ball is yours before setting off towards it.
      const settled = this.singles || this.now - this.designatedSince >= 0.2;
      if (stick < 0.15 && plan && this.hitterId === p.id && settled && !this.ballGoingOut) {
        p.moveTo = plan.stance;
        const lead = Math.max(0.05, plan.t - this.now - 0.15);
        const needed = p.distanceTo(plan.stance.x, plan.stance.z) / lead;
        p.runSpeed = clamp(needed, HUMAN_SPEED * (0.45 + 0.55 * a), HUMAN_SPEED);
      }
    }
  }

  private separatePartners(): void {
    if (this.singles) return;
    for (const t of [0, 1] as const) {
      const [a, b] = this.teamPlayers(t);
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      const min = 0.9;
      if (d < min && d > 1e-4) {
        const push = (min - d) / 2;
        a.x -= (dx / d) * push;
        a.z -= (dz / d) * push;
        b.x += (dx / d) * push;
        b.z += (dz / d) * push;
      }
    }
  }

  /** Team of a player id; convenience for views. */
  static teamOf(id: PlayerId): Team {
    return teamOf(id);
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }
}
