import type { Simulation } from '../core/sim';
import type { ShotType, SimEvent } from '../core/types';
import type { PlayerId } from '../rules/court';
import { type GuestMsg, type Link, MOODS, SNAPSHOT_RATE, STROKES, type Snapshot, round } from './protocol';

const shotType = (t: unknown): ShotType => (t === 'lob' || t === 'smash' ? t : 'drive');

/**
 * Host side of an online match: feeds the guest's controls into the real simulation and sends
 * back what happens — a state snapshot thirty times a second and every game event.
 */
export class HostSession {
  private sim: Simulation;
  private link: Link;
  private guest: PlayerId;
  private sinceSnapshot = 0;

  constructor(sim: Simulation, link: Link, guest: PlayerId = 2) {
    this.sim = sim;
    this.link = link;
    this.guest = guest;
  }

  /** Controls received from the guest. Its view is turned half a turn, hence the sign flip. */
  receive(msg: GuestMsg): void {
    if (msg.k === 'm') {
      const x = Math.max(-1, Math.min(1, Number(msg.x) || 0));
      const z = Math.max(-1, Math.min(1, Number(msg.z) || 0));
      this.sim.setMove(this.guest, -x, -z);
      // The aim is relative to the player's own view, so it needs no mirroring.
      this.sim.setAim(this.guest, x);
    } else if (msg.k === 'p') {
      this.sim.press(this.guest, shotType(msg.t));
    } else if (msg.k === 'r') {
      this.sim.release(this.guest);
    } else if (msg.k === 'c') {
      this.sim.cancel(this.guest);
    } else if (msg.k === 'shot' && msg.i && typeof msg.i === 'object') {
      const i = msg.i as { type?: unknown; power?: unknown; aim?: unknown; angle?: unknown };
      const power = Math.max(0, Math.min(1, Number(i.power) || 0));
      // Older versions of the game sent an angle in radians instead of a stick position.
      const raw = typeof i.aim === 'number' ? i.aim : typeof i.angle === 'number' ? i.angle / 0.62 : undefined;
      const aim = raw === undefined || !Number.isFinite(raw) ? undefined : Math.max(-1, Math.min(1, raw));
      this.sim.shot(this.guest, { type: shotType(i.type), power, aim });
    }
  }

  private score() {
    return { ...this.sim.match.scoring.snapshot(), serveNumber: this.sim.match.referee.serveNumber };
  }

  sendStart(): void {
    this.link.send({ k: 'start', singles: this.sim.singles, sc: this.score() });
  }

  /** Call once per rendered frame with the events of that frame and the real time elapsed. */
  afterFrame(events: SimEvent[], dt: number): void {
    for (const ev of events) {
      const withScore = ev.kind === 'point' || ev.kind === 'serve_ready' || ev.kind === 'fault' || ev.kind === 'let';
      this.link.send({ k: 'e', t: this.sim.now, ev, sc: withScore ? this.score() : undefined });
    }
    this.sinceSnapshot += dt;
    if (this.sinceSnapshot >= 1 / SNAPSHOT_RATE) {
      this.sinceSnapshot = 0;
      this.link.send(this.snapshot(), true);
    }
  }

  snapshot(): Snapshot {
    const s = this.sim;
    const b = s.world.ball;
    return {
      k: 's',
      t: round(s.now),
      ph: s.phase,
      rh: s.rallyHits,
      b: [b.px, b.py, b.pz, b.vx, b.vy, b.vz, b.wx, b.wy, b.wz].map(round),
      p: s.players.map((p) => [
        round(p.x),
        round(p.z),
        round(p.vx),
        round(p.vz),
        MOODS.indexOf(p.mood),
        p.holdingBall ? 1 : 0,
        p.prep ? STROKES.indexOf(p.prep.stroke) : -1,
        p.prep ? round(p.prep.t) : 0,
      ]),
    };
  }
}
