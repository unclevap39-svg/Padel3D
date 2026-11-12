import type { PlayerId, Team } from './court';
import { type Decision, Referee, type Surface } from './referee';
import { type MatchConfig, type ScoreEvent, Scoring } from './scoring';

export type MatchEvent =
  | { kind: 'let' }
  | { kind: 'fault'; serveNumber: 1 | 2; reason: string }
  | { kind: 'point'; winner: Team; reason: string; score: ScoreEvent[] };

/**
 * A whole match: the score plus a referee for the point in progress.
 * The game feeds ball events in; whatever comes back is what the HUD, audio and flow react to.
 */
export class Match {
  readonly scoring: Scoring;
  referee: Referee;

  constructor(config: Partial<MatchConfig> = {}, firstServer: PlayerId = 0) {
    this.scoring = new Scoring(config, firstServer);
    this.referee = new Referee(this.scoring.server, this.scoring.serveSide);
  }

  get over(): boolean {
    return this.scoring.matchWinner !== null;
  }

  serveStruck(): MatchEvent | null {
    return this.apply(this.referee.serveStruck());
  }

  hit(player: PlayerId): MatchEvent | null {
    return this.apply(this.referee.hit(player));
  }

  bounce(surface: Surface, x: number, z: number): MatchEvent | null {
    return this.apply(this.referee.bounce(surface, x, z));
  }

  out(): MatchEvent | null {
    return this.apply(this.referee.out());
  }

  private apply(d: Decision): MatchEvent | null {
    switch (d.kind) {
      case 'none':
        return null;
      case 'let':
        return { kind: 'let' };
      case 'fault':
        return { kind: 'fault', serveNumber: d.serveNumber, reason: d.reason };
      case 'point': {
        const score = this.scoring.pointWon(d.winner);
        if (!this.over) {
          this.referee = new Referee(this.scoring.server, this.scoring.serveSide);
        }
        return { kind: 'point', winner: d.winner, reason: d.reason, score };
      }
    }
  }
}
