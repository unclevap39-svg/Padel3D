import { MAX_HOLD, gaugeAt } from '../core/shots';
import type { ShotIntent, ShotType, SimEvent, SimPhase } from '../core/types';
import { Player } from '../entities/player';
import type { BallState } from '../physics/ballistics';
import type { PlayerId, ServeSide } from '../rules/court';
import { Scoring } from '../rules/scoring';
import { type HostMsg, type Link, MOODS, SNAPSHOT_RATE, STROKES, type Snapshot, mirrorEvent, mirrorId, mirrorScore } from './protocol';

/** How far behind the host's clock the guest draws, to always have two snapshots to blend. */
const DELAY = 0.1;

/**
 * Guest side of an online match. It exposes the same surface as the real simulation (players,
 * ball, phase, score, events) but only replays what the host sends, blended between snapshots.
 * Everything is turned half a turn so the guest also plays from the near side as "player 0".
 */
export class GuestSim {
  readonly players: Player[] = [new Player(0), new Player(1), new Player(2), new Player(3)];
  active: Player[] = this.players;
  singles = false;
  phase: SimPhase = 'positioning';
  now = 0;
  rallyHits = 0;
  readonly config = { assist: 0.5 };
  readonly match: { scoring: Scoring; referee: { server: PlayerId; serveNumber: 1 | 2; serveSide: ServeSide }; over: boolean };
  readonly world: { ball: BallState; ballRotation(): { x: number; y: number; z: number; w: number } };
  /** True once the host's first snapshot has arrived. */
  ready = false;
  private link: Link;
  private snaps: Snapshot[] = [];
  private pending: Array<{ t: number; ev: SimEvent; sc?: ReturnType<typeof mirrorScore> & { serveNumber: 1 | 2 } }> = [];
  private released: SimEvent[] = [];
  private move = { x: 0, z: 0 };
  private sinceMove = 0;
  private rot = { x: 0, y: 0, z: 0, w: 1 };
  private ball: BallState = { px: 0, py: 1, pz: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
  /** Latest state received, position and velocity taken at the same instant (for predictions). */
  private latest: { ball: BallState; t: number } = { ball: { ...this.ball }, t: 0 };
  /** Local clock, for the gauge of the shot being prepared. */
  private clock = 0;
  /** Shot button held or just released on this side; the host keeps the real one. */
  private charge: { type: ShotType; t0: number; power: number | null; releasedT: number; hostT: number } | null = null;
  /** Side that struck the ball last, as far as the replay has got: 1 = the opponents. */
  private lastHitTeam = -1;
  /** Controls protocol of the host; an older build only understands complete shots. */
  hostVersion = 2;

  constructor(link: Link) {
    this.link = link;
    const scoring = new Scoring();
    this.match = { scoring, referee: { server: 0, serveNumber: 1, serveSide: 'right' }, over: false };
    this.world = { ball: this.ball, ballRotation: () => this.rot };
    this.players[0].isHuman = true;
    for (const p of this.players) p.place(p.homeSign * 2.5, p.sideSign * 6.5);
  }

  get server(): Player {
    return this.players[this.match.referee.server];
  }

  /** Message from the host. */
  receive(msg: HostMsg): void {
    if (msg.k === 's') {
      // Drop late or duplicated snapshots.
      const last = this.snaps[this.snaps.length - 1];
      if (last && msg.t <= last.t) return;
      this.snaps.push(msg);
      if (this.snaps.length > 30) this.snaps.shift();
      if (!this.ready) {
        this.ready = true;
        this.now = msg.t - DELAY;
      }
    } else if (msg.k === 'e') {
      this.pending.push({ t: msg.t, ev: mirrorEvent(msg.ev), sc: msg.sc ? mirrorScore(msg.sc) : undefined });
    } else if (msg.k === 'start') {
      this.singles = msg.singles;
      this.active = msg.singles ? [this.players[0], this.players[2]] : this.players;
      for (const p of this.players) p.active = this.active.includes(p);
      this.applyScore(mirrorScore(msg.sc));
    }
  }

  private applyScore(sc: ReturnType<typeof mirrorScore> & { serveNumber?: 1 | 2 }): void {
    this.match.scoring.restore(sc);
    this.match.referee.server = sc.server;
    this.match.referee.serveSide = sc.serveSide;
    if (sc.serveNumber) this.match.referee.serveNumber = sc.serveNumber;
    this.match.over = sc.matchWinner !== null;
  }

  // --- Same controls as the local simulation -------------------------------------------------------

  setHumanMove(x: number, z: number): void {
    this.move.x = x;
    this.move.z = z;
  }

  humanShot(intent: ShotIntent): void {
    this.link.send({ k: 'shot', i: intent });
  }

  humanPress(type: ShotType): void {
    if (this.hostVersion >= 2) this.link.send({ k: 'p', t: type });
    const newest = this.snaps[this.snaps.length - 1];
    this.charge = { type, t0: this.clock, power: null, releasedT: 0, hostT: newest ? newest.t : 0 };
  }

  humanRelease(): void {
    const c = this.charge;
    // Always tell the host: its copy of the press may still be held when ours is already gone.
    if (this.hostVersion >= 2) this.link.send({ k: 'r' });
    if (!c || c.power !== null) return;
    c.power = gaugeAt(this.clock - c.t0);
    c.releasedT = this.clock;
    if (this.hostVersion < 2) {
      // Older host: it plays complete shots, with the aim as an angle.
      const i = { type: c.type, power: c.power, aim: this.move.x, angle: this.move.x * 0.62 };
      this.link.send({ k: 'shot', i });
    }
  }

  /** The press is called off (menu opened, page hidden). */
  humanCancel(): void {
    if (this.hostVersion >= 2) this.link.send({ k: 'c' });
    this.charge = null;
  }

  /** The shot being prepared, as shown on the gauge. The host applies the same rule to the real one. */
  humanCharge(): { type: ShotType; gauge: number; held: boolean } | null {
    const c = this.charge;
    if (!c) return null;
    return { type: c.type, gauge: c.power ?? gaugeAt(this.clock - c.t0), held: c.power === null };
  }

  /** Ball state to predict from: position and velocity of the same instant, and that instant. */
  viewBall(): { ball: BallState; t: number; stale: boolean } {
    // The newest state may already contain a strike or a bounce that the replay has not
    // announced yet: a prediction made from it would not match what the view knows.
    const next = this.pending[0];
    const ahead = !!next && next.t <= this.latest.t + 0.001 && (next.ev.kind === 'hit' || next.ev.kind === 'bounce');
    return { ball: this.latest.ball, t: this.latest.t, stale: ahead };
  }

  /** The game loop ticks the simulation; here time is driven by `sync` instead. */
  tick(): void {}

  /** Advances the replay by `dt` real seconds: follows the host's clock, blends snapshots, releases events. */
  sync(dt: number): void {
    this.clock += dt;
    const c = this.charge;
    if (c) {
      if (c.power === null && this.clock - c.t0 > MAX_HOLD) {
        c.power = 1;
        c.releasedT = this.clock;
      }
      // A released press that led to nothing is forgotten, as on the host — but not while the
      // ball is on its way: the host keeps the shot armed until it is played.
      const swinging = this.players[0].swing !== null;
      const incoming = this.phase === 'rally' && this.lastHitTeam === 1;
      if (c.power !== null && !swinging && !incoming && this.clock - c.releasedT > 1.4) this.charge = null;
    }
    this.sinceMove += dt;
    if (this.sinceMove >= 1 / SNAPSHOT_RATE) {
      this.sinceMove = 0;
      this.link.send({ k: 'm', x: Math.round(this.move.x * 100) / 100, z: Math.round(this.move.z * 100) / 100 }, true);
    }
    const n = this.snaps.length;
    if (n === 0) return;
    // Stay a constant delay behind the newest snapshot, speeding up or slowing down gently.
    const target = this.snaps[n - 1].t - DELAY;
    const err = target - this.now;
    if (Math.abs(err) > 0.6) this.now = target;
    else this.now += dt * Math.max(0.5, Math.min(1.5, 1 + err * 2.5));

    // Snapshots on either side of the render time.
    let i = n - 1;
    while (i > 0 && this.snaps[i - 1].t > this.now) i--;
    const b = this.snaps[i];
    const a = this.snaps[Math.max(0, i - 1)];
    const span = b.t - a.t;
    const f = span > 1e-6 ? Math.max(0, Math.min(1.25, (this.now - a.t) / span)) : 1;
    const mix = (x: number, y: number) => x + (y - x) * f;

    this.phase = b.ph;
    this.rallyHits = b.rh;
    // Mirrored: positions and velocities change sign on x and z.
    const B = this.ball;
    B.px = -mix(a.b[0], b.b[0]);
    B.py = mix(a.b[1], b.b[1]);
    B.pz = -mix(a.b[2], b.b[2]);
    B.vx = -b.b[3];
    B.vy = b.b[4];
    B.vz = -b.b[5];
    B.wx = -b.b[6];
    B.wy = b.b[7];
    B.wz = -b.b[8];
    this.spinBall(dt);
    const L = this.latest.ball;
    L.px = -b.b[0];
    L.py = b.b[1];
    L.pz = -b.b[2];
    L.vx = B.vx;
    L.vy = B.vy;
    L.vz = B.vz;
    L.wx = B.wx;
    L.wy = B.wy;
    L.wz = B.wz;
    this.latest.t = b.t;

    for (let id = 0; id < 4; id++) {
      const p = this.players[id];
      const src = mirrorId(id as PlayerId);
      const pa = a.p[src];
      const pb = b.p[src];
      p.x = -mix(pa[0], pb[0]);
      p.z = -mix(pa[1], pb[1]);
      p.vx = -pb[2];
      p.vz = -pb[3];
      p.mood = MOODS[pb[4]] ?? 'play';
      p.holdingBall = pb[5] === 1;
      p.prep = pb[6] >= 0 ? { stroke: STROKES[pb[6]], t: pb[7] } : null;
      if (p.swing && this.now >= p.swing.endT) p.swing = null;
    }

    // Events are released when the replay reaches the moment they happened.
    while (this.pending.length && this.pending[0].t <= this.now) {
      const { ev, sc, t } = this.pending.shift()!;
      if (sc) this.applyScore(sc);
      if (ev.kind === 'swing') this.players[ev.player].swing = ev.swing;
      if (ev.kind === 'hit') for (const p of this.players) if (p.team !== this.players[ev.player].team) p.splitT = this.now;
      if (ev.kind === 'hit') this.lastHitTeam = this.players[ev.player].team;
      const stopped = ev.kind === 'point' || ev.kind === 'fault' || ev.kind === 'let';
      if (stopped || ev.kind === 'serve_ready') this.lastHitTeam = -1;
      const ch = this.charge;
      if (ch) {
        // An event older than the press belongs to the previous shot: it must not erase this one.
        const fresh = t >= ch.hostT;
        // My press is used up once my shot has left; a serve uses it as its motion starts.
        const mine = (ev.kind === 'hit' && ev.player === 0) || (ev.kind === 'swing' && ev.player === 0 && !ev.swing.willHit);
        const served = ev.kind === 'phase' && ev.phase === 'serve_motion' && this.match.referee.server === 0;
        if (fresh && (mine || served)) this.charge = null;
        else if (stopped) {
          // As on the host: a thumb still down keeps the button, the gauge starts again.
          if (ch.power === null) ch.t0 = this.clock;
          else this.charge = null;
        } else if (ev.kind === 'serve_ready') {
          if (ch.power !== null) this.charge = null;
          else if (ev.server === 0) ch.t0 = this.clock;
        }
      }
      this.released.push(ev);
    }
  }

  private spinBall(dt: number): void {
    const B = this.ball;
    const w = Math.hypot(B.wx, B.wy, B.wz);
    if (w < 1e-3) return;
    const half = (w * dt) / 2;
    const s = Math.sin(half) / w;
    const dq = { x: B.wx * s, y: B.wy * s, z: B.wz * s, w: Math.cos(half) };
    const q = this.rot;
    const x = dq.w * q.x + dq.x * q.w + dq.y * q.z - dq.z * q.y;
    const y = dq.w * q.y - dq.x * q.z + dq.y * q.w + dq.z * q.x;
    const z = dq.w * q.z + dq.x * q.y - dq.y * q.x + dq.z * q.w;
    const ww = dq.w * q.w - dq.x * q.x - dq.y * q.y - dq.z * q.z;
    const l = Math.hypot(x, y, z, ww) || 1;
    q.x = x / l;
    q.y = y / l;
    q.z = z / l;
    q.w = ww / l;
  }

  drainEvents(): SimEvent[] {
    const out = this.released;
    this.released = [];
    return out;
  }
}
