import type { PlayerId, Team } from '../rules/court';

export type StrokeKind = 'forehand' | 'backhand' | 'volley_fh' | 'volley_bh' | 'smash' | 'bandeja' | 'serve';

export type ShotType = 'drive' | 'lob' | 'smash';

/** What a player wants to do with the ball. */
export interface ShotIntent {
  type: ShotType;
  /** 0..1 */
  power: number;
  /** Aim angle from straight ahead, radians, positive towards screen right (+x for team 0). */
  angle?: number;
  /** Explicit landing point (used by the AI); overrides `angle`. */
  target?: { x: number; z: number };
}

export interface Swing {
  stroke: StrokeKind;
  intent: ShotIntent;
  startT: number;
  /** Time at which the racket meets the ball. */
  contactT: number;
  endT: number;
  /** Where the ball is expected at contact. */
  contact: { x: number; y: number; z: number };
  /** False for a swing at thin air. */
  willHit: boolean;
  resolved: boolean;
}

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface AiLevel {
  maxSpeed: number;
  /** Seconds before reacting to an opponent's shot. */
  reaction: number;
  /** Standard deviation of the landing point error, metres. */
  aimError: number;
  /** 0..1 scale on shot pace. */
  power: number;
  /** Probability of choosing a lob from the back when opponents hold the net. */
  lobRate: number;
  /** Probability of attacking an overhead with a smash instead of a bandeja. */
  smashRate: number;
  /** 0..1: how readily the pair moves up to the net. */
  netRush: number;
  /** 0..1: how well targets are chosen away from opponents. */
  placement: number;
}

export const AI_LEVELS: Record<Difficulty, AiLevel> = {
  easy: { maxSpeed: 4.4, reaction: 0.42, aimError: 1.25, power: 0.45, lobRate: 0.2, smashRate: 0.25, netRush: 0.35, placement: 0.2 },
  medium: { maxSpeed: 5.4, reaction: 0.28, aimError: 0.8, power: 0.65, lobRate: 0.4, smashRate: 0.55, netRush: 0.7, placement: 0.6 },
  hard: { maxSpeed: 6.2, reaction: 0.16, aimError: 0.45, power: 0.85, lobRate: 0.55, smashRate: 0.8, netRush: 1, placement: 0.95 },
};

export type SimPhase = 'idle' | 'positioning' | 'serve_ready' | 'serve_motion' | 'rally' | 'pause' | 'point_over' | 'match_over';

export type SimEvent =
  | { kind: 'phase'; phase: SimPhase }
  | { kind: 'swing'; player: PlayerId; swing: Swing }
  | { kind: 'hit'; player: PlayerId; stroke: StrokeKind; speedKmh: number; x: number; y: number; z: number }
  | { kind: 'bounce'; surface: 'floor' | 'glass' | 'fence' | 'net' | 'ground'; x: number; y: number; z: number; speed: number }
  | { kind: 'fault'; serveNumber: 1 | 2; reason: string }
  | { kind: 'let' }
  | { kind: 'point'; winner: Team; reason: string; winnerShot: boolean; game: boolean; set: boolean; match: boolean }
  | { kind: 'serve_ready'; server: PlayerId; serveNumber: 1 | 2 };
