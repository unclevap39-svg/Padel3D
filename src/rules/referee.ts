import {
  type PlayerId,
  type ServeSide,
  type Team,
  inServiceBox,
  otherTeam,
  serviceBoxXSign,
  sideOfZ,
  teamOf,
} from './court';

/** What the ball touched. 'floor' means the playing surface inside the enclosure. */
export type Surface = 'floor' | 'glass' | 'fence' | 'net';

export type PointReason =
  | 'double_fault'
  | 'second_bounce' // the receiving team let the ball bounce twice: a winner
  | 'ace'
  | 'net' // ball died on the hitter's own side (usually in the net)
  | 'wall_direct' // hit the opponents' glass without bouncing first
  | 'fence_direct' // hit any wire mesh without bouncing first
  | 'out' // left the enclosure without bouncing
  | 'out_after_bounce' // bounced in, then left the enclosure: a winner
  | 'volley_on_serve'
  | 'double_hit';

export type FaultReason = 'serve_net' | 'serve_out_of_box' | 'serve_wall' | 'serve_fence_after_bounce' | 'serve_out';

export type Decision =
  | { kind: 'none' }
  | { kind: 'let' }
  | { kind: 'fault'; reason: FaultReason; serveNumber: 1 | 2 }
  | { kind: 'point'; winner: Team; reason: PointReason };

const NONE: Decision = { kind: 'none' };

type Phase = 'awaiting_serve' | 'serve_flight' | 'rally' | 'over';

/**
 * Referee for a single point. Feed it what happens to the ball (serve struck, surface contacts,
 * player hits, ball leaving the enclosure) and it says when the point, a fault or a let occurs.
 *
 * Rules covered:
 * - the serve must land in the diagonal service box; two attempts; a net-cord serve that lands
 *   in the box is replayed; after its bounce a serve may hit the glass but not the wire mesh;
 * - the receiver must let the serve bounce;
 * - in a rally the ball must bounce on the opponents' floor before touching their walls;
 *   it may be played off the hitter's own glass, never off the wire mesh;
 * - only one bounce is allowed; a ball that bounces and then leaves the enclosure is a winner.
 */
export class Referee {
  phase: Phase = 'awaiting_serve';
  serveNumber: 1 | 2 = 1;
  readonly server: PlayerId;
  readonly servingTeam: Team;
  readonly serveSide: ServeSide;
  /** Team that struck the ball last. */
  lastHitTeam: Team;
  /** Floor bounces since the last strike. */
  floorBounces = 0;
  /** Strikes in this point, serve included. */
  hits = 0;
  private netTouched = false;

  constructor(server: PlayerId, serveSide: ServeSide) {
    this.server = server;
    this.servingTeam = teamOf(server);
    this.serveSide = serveSide;
    this.lastHitTeam = this.servingTeam;
  }

  get receivingTeam(): Team {
    return otherTeam(this.lastHitTeam);
  }

  /** True while the ball in flight is a serve nobody has returned yet. */
  get isServeInFlight(): boolean {
    return this.phase === 'serve_flight';
  }

  /** May the receiving team strike the ball now? (Not before the serve has bounced.) */
  get canReceiverHit(): boolean {
    if (this.phase === 'serve_flight') return this.floorBounces === 1;
    return this.phase === 'rally';
  }

  serveStruck(): Decision {
    if (this.phase !== 'awaiting_serve') return NONE;
    this.phase = 'serve_flight';
    this.lastHitTeam = this.servingTeam;
    this.floorBounces = 0;
    this.netTouched = false;
    this.hits = 1;
    return NONE;
  }

  /** A player struck the ball during play. */
  hit(player: PlayerId): Decision {
    if (this.phase !== 'serve_flight' && this.phase !== 'rally') return NONE;
    const team = teamOf(player);
    if (team === this.lastHitTeam) {
      return this.point(otherTeam(team), 'double_hit');
    }
    if (this.phase === 'serve_flight' && this.floorBounces === 0) {
      return this.point(this.servingTeam, 'volley_on_serve');
    }
    this.phase = 'rally';
    this.lastHitTeam = team;
    this.floorBounces = 0;
    this.netTouched = false;
    this.hits++;
    return NONE;
  }

  /** The ball touched a surface at court position (x, z). */
  bounce(surface: Surface, x: number, z: number): Decision {
    if (this.phase === 'serve_flight') return this.serveBounce(surface, x, z);
    if (this.phase === 'rally') return this.rallyBounce(surface, z);
    return NONE;
  }

  /** The ball left the enclosure (over the walls) or came to rest. */
  out(): Decision {
    if (this.phase === 'serve_flight') {
      if (this.floorBounces === 0) return this.fault('serve_out');
      return this.point(this.servingTeam, 'ace');
    }
    if (this.phase === 'rally') {
      if (this.floorBounces === 0) return this.point(this.receivingTeam, 'out');
      return this.point(this.lastHitTeam, 'out_after_bounce');
    }
    return NONE;
  }

  private serveBounce(surface: Surface, x: number, z: number): Decision {
    const receiving = otherTeam(this.servingTeam);
    if (this.floorBounces === 0) {
      switch (surface) {
        case 'net':
          this.netTouched = true;
          return NONE;
        case 'glass':
          return this.fault('serve_wall');
        case 'fence':
          return this.fault('serve_wall');
        case 'floor': {
          const boxSign = serviceBoxXSign(this.servingTeam, this.serveSide);
          if (!inServiceBox(x, z, receiving, boxSign)) {
            return this.fault(sideOfZ(z) === this.servingTeam ? 'serve_net' : 'serve_out_of_box');
          }
          if (this.netTouched) {
            this.phase = 'awaiting_serve';
            return { kind: 'let' };
          }
          this.floorBounces = 1;
          return NONE;
        }
      }
    }
    // After a good bounce in the box.
    switch (surface) {
      case 'fence':
        return this.fault('serve_fence_after_bounce');
      case 'floor':
        return this.point(this.servingTeam, 'ace');
      default:
        return NONE;
    }
  }

  private rallyBounce(surface: Surface, z: number): Decision {
    const hitter = this.lastHitTeam;
    const receiving = otherTeam(hitter);
    const side = sideOfZ(z);
    if (this.floorBounces === 0) {
      switch (surface) {
        case 'net':
          this.netTouched = true;
          return NONE;
        case 'glass':
          // Playing the ball off your own glass is legal; the opponents' glass is not.
          return side === hitter ? NONE : this.point(receiving, 'wall_direct');
        case 'fence':
          return this.point(receiving, 'fence_direct');
        case 'floor':
          if (side === hitter) return this.point(receiving, 'net');
          this.floorBounces = 1;
          return NONE;
      }
    }
    if (surface === 'floor') return this.point(hitter, 'second_bounce');
    return NONE;
  }

  private fault(reason: FaultReason): Decision {
    if (this.serveNumber === 1) {
      this.serveNumber = 2;
      this.phase = 'awaiting_serve';
      return { kind: 'fault', reason, serveNumber: 1 };
    }
    this.phase = 'over';
    return { kind: 'point', winner: otherTeam(this.servingTeam), reason: 'double_fault' };
  }

  private point(winner: Team, reason: PointReason): Decision {
    this.phase = 'over';
    return { kind: 'point', winner, reason };
  }
}
