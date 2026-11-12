import { type PlayerId, type ServeSide, type Team, otherTeam, teamOf } from './court';

export interface MatchConfig {
  /** Sets needed to win the match (2 = best of three). */
  setsToWin: number;
  /** Games at which a tie-break is played (6 = at 6-6). */
  tiebreakAt: number;
  /** Points needed to win the tie-break (with a two-point margin). */
  tiebreakPoints: number;
  /** "Punto de oro": at 40-40 the next point wins the game. */
  goldenPoint: boolean;
  /** One against one: the two players serve alternate games. */
  singles?: boolean;
}

export const DEFAULT_CONFIG: MatchConfig = {
  setsToWin: 2,
  tiebreakAt: 6,
  tiebreakPoints: 7,
  goldenPoint: false,
};

/** Serving order across games: A1, B1, A2, B2. */
export const SERVE_ORDER: readonly PlayerId[] = [0, 2, 1, 3];
const SINGLES_ORDER: readonly PlayerId[] = [0, 2, 0, 2];

export interface ScoreSnapshot {
  points: [number, number];
  games: [number, number];
  sets: [number, number];
  completedSets: Array<[number, number]>;
  tiebreak: boolean;
  server: PlayerId;
  serveSide: ServeSide;
  matchWinner: Team | null;
}

export type ScoreEvent =
  | { kind: 'point'; winner: Team }
  | { kind: 'game'; winner: Team }
  | { kind: 'set'; winner: Team; score: [number, number] }
  | { kind: 'match'; winner: Team };

const POINT_LABELS = ['0', '15', '30', '40'];

export class Scoring {
  readonly config: MatchConfig;
  points: [number, number] = [0, 0];
  games: [number, number] = [0, 0];
  sets: [number, number] = [0, 0];
  completedSets: Array<[number, number]> = [];
  tiebreak = false;
  matchWinner: Team | null = null;
  /** Index into SERVE_ORDER of the player serving the current game (or who started the tie-break). */
  private serveIndex = 0;
  /** Server dictated by the host when this score mirrors a remote match. */
  private remoteServer: PlayerId | null = null;
  private order: readonly PlayerId[] = SERVE_ORDER;

  constructor(config: Partial<MatchConfig> = {}, firstServer: PlayerId = 0) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.order = this.config.singles ? SINGLES_ORDER : SERVE_ORDER;
    this.serveIndex = Math.max(0, this.order.indexOf(firstServer));
    // A match configured with a tie-break at 0-0 is a single tie-break.
    if (this.config.tiebreakAt === 0) this.tiebreak = true;
  }

  /** Overwrites the score with a snapshot received from the host of an online match. */
  restore(s: ScoreSnapshot): void {
    this.points = [...s.points];
    this.games = [...s.games];
    this.sets = [...s.sets];
    this.completedSets = s.completedSets.map((x) => [...x] as [number, number]);
    this.tiebreak = s.tiebreak;
    this.matchWinner = s.matchWinner;
    this.remoteServer = s.server;
  }

  get server(): PlayerId {
    if (this.remoteServer !== null) return this.remoteServer;
    if (!this.tiebreak) return this.order[this.serveIndex % 4];
    // Tie-break: the first player serves one point, then each player serves two.
    const n = this.points[0] + this.points[1];
    return this.order[(this.serveIndex + Math.floor((n + 1) / 2)) % 4];
  }

  get servingTeam(): Team {
    return teamOf(this.server);
  }

  /** Right-hand side on even points, left-hand side on odd points. */
  get serveSide(): ServeSide {
    return (this.points[0] + this.points[1]) % 2 === 0 ? 'right' : 'left';
  }

  snapshot(): ScoreSnapshot {
    return {
      points: [...this.points],
      games: [...this.games],
      sets: [...this.sets],
      completedSets: this.completedSets.map((s) => [...s] as [number, number]),
      tiebreak: this.tiebreak,
      server: this.server,
      serveSide: this.serveSide,
      matchWinner: this.matchWinner,
    };
  }

  /** Text for one team's points in the current game: "0", "15", "30", "40", "Av" or the tie-break count. */
  pointLabel(team: Team): string {
    const mine = this.points[team];
    const theirs = this.points[otherTeam(team)];
    if (this.tiebreak) return String(mine);
    if (mine >= 3 && theirs >= 3) {
      if (mine === theirs) return '40';
      return mine > theirs ? 'Av' : '';
    }
    return POINT_LABELS[Math.min(mine, 3)];
  }

  /** Spoken score from the server's point of view, in French. */
  announcement(): string {
    if (this.matchWinner !== null) return 'Jeu, set et match';
    const s = this.servingTeam;
    const r = otherTeam(s);
    const ps = this.points[s];
    const pr = this.points[r];
    if (ps === 0 && pr === 0) return '';
    if (this.tiebreak) {
      return ps === pr ? `${ps} partout` : `${ps} ${pr}`;
    }
    const words = ['zéro', 'quinze', 'trente', 'quarante'];
    if (ps >= 3 && pr >= 3) {
      if (ps === pr) return 'Égalité';
      return ps > pr ? 'Avantage service' : 'Avantage retour';
    }
    if (ps === pr) return `${words[ps]} partout`;
    return `${words[ps]} ${words[pr]}`;
  }

  /** Awards a point and returns everything it triggered, in order. */
  pointWon(winner: Team): ScoreEvent[] {
    if (this.matchWinner !== null) return [];
    const events: ScoreEvent[] = [{ kind: 'point', winner }];
    const loser = otherTeam(winner);
    this.points[winner]++;
    const mine = this.points[winner];
    const theirs = this.points[loser];

    let gameWon = false;
    if (this.tiebreak) {
      gameWon = mine >= this.config.tiebreakPoints && mine - theirs >= 2;
    } else if (this.config.goldenPoint) {
      gameWon = mine >= 4;
    } else {
      gameWon = mine >= 4 && mine - theirs >= 2;
    }
    if (!gameWon) return events;

    const wasTiebreak = this.tiebreak;
    this.points = [0, 0];
    this.games[winner]++;
    this.tiebreak = false;
    // The next game is served by the next player in the order. After a tie-break this is
    // the player following whoever served its first point.
    this.serveIndex = (this.serveIndex + 1) % 4;
    events.push({ kind: 'game', winner });

    const g = this.games[winner];
    const og = this.games[loser];
    const setWon = wasTiebreak || (g >= 6 && g - og >= 2);
    if (setWon) {
      const score: [number, number] = [this.games[0], this.games[1]];
      this.completedSets.push(score);
      this.sets[winner]++;
      this.games = [0, 0];
      events.push({ kind: 'set', winner, score });
      if (this.sets[winner] >= this.config.setsToWin) {
        this.matchWinner = winner;
        events.push({ kind: 'match', winner });
      }
    } else if (g === this.config.tiebreakAt && og === this.config.tiebreakAt) {
      this.tiebreak = true;
    }
    return events;
  }
}
