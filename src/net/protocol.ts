/**
 * Messages exchanged during an online match. The host runs the real simulation and is the only
 * authority; the guest sends its controls and draws what the host reports.
 */
import type { ShotIntent, ShotType, SimEvent, SimPhase, StrokeKind } from '../core/types';
import type { PlayerId, Team } from '../rules/court';
import type { ScoreSnapshot } from '../rules/scoring';

export const SNAPSHOT_RATE = 30;
export const STROKES: StrokeKind[] = ['forehand', 'backhand', 'volley_fh', 'volley_bh', 'smash', 'bandeja', 'serve'];
export const MOODS = ['play', 'celebrate', 'dejected'] as const;

export interface Snapshot {
  k: 's';
  /** Host simulation time. */
  t: number;
  ph: SimPhase;
  rh: number;
  /** Ball: position, velocity, spin. */
  b: number[];
  /** Per player: x, z, vx, vz, mood index, holding ball (0/1), prepared stroke index (-1 none), prepared contact time. */
  p: number[][];
}

export interface EventMsg {
  k: 'e';
  t: number;
  ev: SimEvent;
  /** Score and service state after the event, when it changed. */
  sc?: ScoreSnapshot & { serveNumber: 1 | 2 };
}

export interface HelloMsg {
  k: 'hello';
  name: string;
  /** Shirt, shorts and racket colours, so each side sees the other's look. */
  look: { shirt: number; shorts: number; racket: number; frame: number };
  assist?: number;
}

export type HostMsg = Snapshot | EventMsg | HelloMsg | { k: 'start'; singles: boolean; sc: ScoreSnapshot & { serveNumber: 1 | 2 } } | { k: 'bye' };
/**
 * From the guest: `m` is the stick (it moves the player and aims the shot), `p` a shot button
 * going down, `r` its release, `shot` a complete press with a set power (scripts).
 */
export type GuestMsg =
  | { k: 'm'; x: number; z: number }
  | { k: 'p'; t: ShotType }
  | { k: 'r' }
  | { k: 'shot'; i: ShotIntent }
  | HelloMsg
  | { k: 'bye' };
export type NetMsg = HostMsg | GuestMsg;

/** Two-way connection to the other player. `fast` messages may be dropped or arrive out of order. */
export interface Link {
  send(msg: NetMsg, fast?: boolean): void;
  onMessage: (msg: NetMsg) => void;
  onClose: () => void;
  close(): void;
  readonly open: boolean;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export const round = r3;

/** The guest sees the court turned half a turn, so that it too plays from the near side. */
export const mirrorId = (id: PlayerId): PlayerId => (id ^ 2) as PlayerId;
export const mirrorTeam = (t: Team): Team => (1 - t) as Team;

export function mirrorScore<T extends ScoreSnapshot>(s: T): T {
  return {
    ...s,
    points: [s.points[1], s.points[0]],
    games: [s.games[1], s.games[0]],
    sets: [s.sets[1], s.sets[0]],
    completedSets: s.completedSets.map((x) => [x[1], x[0]] as [number, number]),
    server: mirrorId(s.server),
    matchWinner: s.matchWinner === null ? null : mirrorTeam(s.matchWinner),
  };
}

export function mirrorEvent(e: SimEvent): SimEvent {
  switch (e.kind) {
    case 'swing':
      return {
        ...e,
        player: mirrorId(e.player),
        swing: { ...e.swing, contact: { x: -e.swing.contact.x, y: e.swing.contact.y, z: -e.swing.contact.z } },
      };
    case 'hit':
      return { ...e, player: mirrorId(e.player), x: -e.x, z: -e.z };
    case 'bounce':
      return { ...e, x: -e.x, z: -e.z };
    case 'point':
      return { ...e, winner: mirrorTeam(e.winner) };
    case 'serve_ready':
      return { ...e, server: mirrorId(e.server) };
    default:
      return e;
  }
}
