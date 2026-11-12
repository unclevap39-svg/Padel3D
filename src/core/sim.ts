import { Ai } from '../ai/brain';
import { type Intercept, MAX_HIT_HEIGHT, MIN_HIT_HEIGHT, REACH, bestIntercept, swingContact } from '../ai/intercept';
import { Player } from '../entities/player';
import { BALL_RADIUS, type BallState, type Prediction, type ShotSpec, predict, solveShot } from '../physics/ballistics';
import { MAX_SPIN, PhysicsWorld, TICK_DT } from '../physics/world';
import { COURT, type PlayerId, type Team, otherTeam, serverXSign, teamOf } from '../rules/court';
import { Match, type MatchEvent } from '../rules/match';
import type { MatchConfig } from '../rules/scoring';
import { AI_LEVELS, type AiLevel, type Difficulty, type ShotIntent, type SimEvent, type SimPhase, type StrokeKind, type Swing } from './types';

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
  rallyHits = 0;

  private phaseT = 0;
  private pendingShots: Array<ShotIntent | null> = [null, null, null, null];
  /** Players on court: all four in doubles, one per side in singles. */
  active: Player[] = [];
  readonly singles: boolean;
  private matchConfig: Partial<MatchConfig>;
  private pendingServe: ShotIntent | null = null;
  private serveContactT = 0;
  private aiServeAt = 0;
  private nextPhaseAfterPause: SimPhase = 'serve_ready';
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
    // The human's partner always plays at a steady club level.
    return p.team === 0 ? AI_LEVELS.medium : AI_LEVELS[this.config.difficulty];
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
    for (const t of [0, 1] as const) {
      const lvl = t === 0 ? AI_LEVELS.medium : AI_LEVELS[this.config.difficulty];
      this.aggressive[t] = this.random() < lvl.netRush;
    }
    this.rallyHits = 0;
    this.leaveBall = false;
    this.hitterId = null;
    this.plans = [null, null, null, null];
    this.prediction = null;
    this.pendingShots = [null, null, null, null];
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

  /** A human player asked for a shot (swipe or button). */
  shot(id: PlayerId, intent: ShotIntent): void {
    if (!this.players[id].isHuman) return;
    this.pendingShots[id] = intent;
  }

  setHumanMove(x: number, z: number): void {
    this.setMove(0, x, z);
  }

  humanShot(intent: ShotIntent): void {
    this.shot(0, intent);
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

    switch (this.phase) {
      case 'idle':
        return;
      case 'positioning': {
        this.holdBallAt(this.server);
        const settled = this.active.every((p) => !p.moveTo || p.distanceTo(p.moveTo.x, p.moveTo.z) < 0.15);
        if ((settled && this.phaseT > 0.5) || this.phaseT > 3.5) {
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
          // The server stands still: before a serve the stick only aims.
          server.wishX = 0;
          server.wishZ = 0;
          const asked = this.pendingShots[server.id];
          if (asked) {
            this.startServe(asked);
            this.pendingShots[server.id] = null;
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
        if (this.phaseT > 1.5) {
          if (this.nextPhaseAfterPause === 'serve_ready') this.enterServeReady();
        }
        break;
      }
      case 'point_over': {
        this.world.tick();
        this.emitBounces();
        if (this.phaseT > 3.0) {
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

  private enterServeReady(): void {
    const server = this.server;
    // Server and receivers stand still for the serve; a human receiver may still adjust.
    for (const p of this.active) {
      if (!p.isHuman || p === server) p.moveTo = null;
      else p.moveTo = null;
      p.wishX = p.isHuman ? p.wishX : 0;
      p.wishZ = p.isHuman ? p.wishZ : 0;
    }
    this.ballHeld = true;
    this.pendingShots = [null, null, null, null];
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
    // Human swing request.
    for (const p of this.active) {
      const asked = this.pendingShots[p.id];
      if (asked) {
        this.tryHumanSwing(p, asked);
        this.pendingShots[p.id] = null;
      }
    }
    if (this.now >= this.replanAt) {
      this.assignHitter();
      this.replanAt = this.now + 0.12;
    }
    this.ai.update();
    this.resolveSwings();
    if (this.phase !== 'rally') return;

    this.world.tick();
    let changed = false;
    for (const c of this.world.contacts) {
      this.events.push({ kind: 'bounce', ...c });
      this.lastEventT = this.now;
      changed = true;
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
      this.nextPhaseAfterPause = 'serve_ready';
      this.endRally();
      this.setPhase('pause');
      return true;
    }
    if (ev.kind === 'fault') {
      this.events.push({ kind: 'fault', serveNumber: ev.serveNumber, reason: ev.reason });
      this.nextPhaseAfterPause = 'serve_ready';
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
    for (const p of this.active) {
      p.moveTo = null;
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
    let bestP: Player | null = null;
    let bestScore = -Infinity;
    for (const p of this.active) {
      if (p.team !== receiving) {
        this.plans[p.id] = null;
        continue;
      }
      if (p.swing && !p.swing.resolved) continue; // committed
      const reaction = p.isHuman ? 0 : Math.max(0, this.lastHitT + this.levelOf(p).reaction - this.now);
      const ic = bestIntercept(p, pred, {
        now: this.now,
        predT0: this.predT0,
        mustBounce: ref.isServeInFlight,
        reaction,
        minLead: 0.1,
      });
      this.plans[p.id] = ic;
      if (!ic) continue;
      let score = ic.score;
      if (ic.ball.x * p.zone > 0.3) score += 1.6; // the ball is in my half
      if (this.hitterId === p.id) score += 0.5; // do not dither between partners
      if (score > bestScore) {
        bestScore = score;
        bestP = p;
      }
    }
    this.hitterId = bestP ? bestP.id : null;
    // The player about to hit takes the racket back early, as the ball approaches.
    for (const p of this.active) p.prep = null;
    const plan = bestP ? this.plans[bestP.id] : null;
    if (bestP && plan && (bestP.isHuman || !this.leaveBall)) {
      const stroke: StrokeKind = plan.overhead
        ? 'bandeja'
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

  private tryHumanSwing(p: Player, intent: ShotIntent): void {
    if (p.swing && this.now < p.swing.endT - 0.12) return;
    const ref = this.match.referee;
    let ic: Intercept | null = null;
    if (this.prediction && ref.lastHitTeam !== p.team && (ref.phase === 'rally' || ref.phase === 'serve_flight')) {
      ic = swingContact(p, this.prediction, {
        now: this.now,
        predT0: this.predT0,
        mustBounce: ref.isServeInFlight,
        minLead: 0.09,
        window: 0.55,
      });
    }
    this.requestSwing(p, intent, ic);
  }

  /** Starts a swing. With an intercept the racket is timed to meet the ball; without, it is a miss. */
  requestSwing(p: Player, intent: ShotIntent, ic: Intercept | null): boolean {
    if (p.swing && this.now < p.swing.endT - 0.12) return false;
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
      endT: contactT + SWING_RECOVERY,
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
    const from = { x: b.px, y: Math.max(b.py, 0.15), z: b.pz };
    const spec = this.buildShot(p, swing, from, isServe);
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
    });
    this.onBallChanged();
    this.ai.onShot(p.team);
    this.assignHitter();
  }

  /** Translates an intent into a physical shot: landing point, pace and spin. */
  private buildShot(p: Player, swing: Swing, from: { x: number; y: number; z: number }, isServe: boolean): ShotSpec {
    const intent = swing.intent;
    const pw = Math.max(0, Math.min(1, intent.power));
    // The AI's targets are already chosen inside the court; its misses come from its own aim error.
    const assist = p.isHuman ? this.assistOf(p) : 0;
    const fwd = p.dir; // z direction of the opponents' half
    let depth: number; // landing distance beyond the net
    let speed: number;
    let spin: ShotSpec['spin'] = 'flat';
    let spinRate = 0;
    let lob = false;
    let lobAngle: number | undefined;
    let clearance = 0.22;

    const stroke = swing.stroke;
    if (isServe) {
      depth = 3.6 + 2.8 * pw;
      speed = 12 + 8 * pw;
      spin = 'slice';
      spinRate = 50;
      clearance = 0.2;
    } else if (intent.type === 'lob') {
      depth = 7.9 + 1.1 * pw;
      speed = 12;
      lob = true;
      lobAngle = 0.92 + 0.14 * pw;
      spin = 'top';
      spinRate = 40;
    } else if (stroke === 'smash' && from.y > 1.85) {
      depth = 5.6 + 2.4 * pw;
      speed = 23 + 15 * pw;
      spin = 'top';
      spinRate = 30;
      clearance = 0.1;
    } else if (stroke === 'bandeja') {
      depth = 7.2 + 1.6 * pw;
      speed = 13 + 7 * pw;
      spin = 'slice';
      spinRate = 110;
      clearance = 0.25;
    } else if (stroke === 'volley_fh' || stroke === 'volley_bh') {
      depth = 4.5 + 4.2 * pw;
      speed = 10 + 10 * pw;
      spin = 'slice';
      spinRate = 70;
      clearance = 0.18;
    } else {
      depth = 4.8 + 4.2 * pw;
      speed = (intent.type === 'smash' ? 17 : 12) + 12 * pw;
      spin = 'top';
      spinRate = 50 + 70 * pw;
      clearance = 0.25;
    }

    let tx: number;
    let tz: number;
    if (intent.target) {
      tx = intent.target.x;
      tz = intent.target.z;
    } else {
      const angle = Math.max(-0.95, Math.min(0.95, intent.angle ?? 0));
      tz = fwd * depth;
      // Screen right is +x for team 0, who plays towards -z.
      tx = from.x + Math.tan(angle) * Math.abs(tz - from.z) * -fwd;
    }

    // Aim help: keep the landing point inside the lines by a margin that grows with the setting.
    if (isServe) {
      const box = -serverXSign(p.team, this.match.referee.serveSide);
      const m = -0.45 + 0.95 * assist;
      const lo = m;
      const hi = COURT.halfWidth - m;
      const bx = Math.max(lo, Math.min(hi, tx * box));
      tx = bx * box;
      const bz = Math.max(1.2, Math.min(COURT.serviceLineZ - m, Math.abs(tz)));
      tz = fwd * bz;
    } else {
      const mx = -0.9 + 1.55 * assist;
      const mz = -0.8 + 1.6 * assist;
      const maxX = COURT.halfWidth - mx;
      tx = Math.max(-maxX, Math.min(maxX, tx));
      tz = fwd * Math.max(1.5, Math.min(COURT.halfLength - mz, Math.abs(tz)));
    }

    // Human execution error: smaller with assist, larger when the ball is met badly.
    if (p.isHuman) {
      const d = Math.hypot(from.x - p.x, from.z - p.z);
      const quality = 1 - Math.max(0, Math.min(1, (Math.abs(d - 0.62) - 0.3) / 0.9));
      const sigma = (0.75 - 0.5 * assist) * (1 + (1 - quality) * 1.4) * (isServe ? 0.5 : 1);
      tx += this.gauss() * sigma;
      tz += this.gauss() * sigma * 1.2;
    }

    // Height error: now and then a shot is hit too low and catches the net.
    const heightError = p.isHuman ? (0.75 - 0.5 * assist) * 0.16 : this.levelOf(p).aimError * 0.2;
    clearance += this.gauss() * heightError;

    return {
      from,
      target: { x: tx, z: tz },
      speed,
      spin,
      spinRate: Math.min(spinRate, MAX_SPIN),
      lob,
      lobAngle,
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

  /** Light placement help: with the stick released, the human drifts towards the ball. */
  private updateHumanAssist(): void {
    if (this.phase === 'positioning') return; // walking to the serve position
    for (const p of this.active) {
      if (!p.isHuman) continue;
      const stick = Math.hypot(p.wishX, p.wishZ);
      const plan = this.plans[p.id];
      const a = this.assistOf(p);
      if (this.phase === 'rally' && stick < 0.15 && a > 0.02 && plan && this.hitterId === p.id && !(p.swing && !p.swing.resolved)) {
        p.moveTo = plan.stance;
        p.maxSpeed = HUMAN_SPEED * (0.2 + 0.75 * a);
      } else {
        p.moveTo = null;
        p.maxSpeed = HUMAN_SPEED;
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
