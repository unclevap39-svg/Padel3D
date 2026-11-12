import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../src/core/sim';
import type { Difficulty } from '../src/core/types';
import { initPhysics, TICK_DT } from '../src/physics/world';

beforeAll(async () => {
  await initPhysics();
});

interface Stats {
  points: number;
  hits: number;
  faults: number;
  lets: number;
  reasons: Record<string, number>;
  simSeconds: number;
  sets: Array<[number, number]>;
  winner: number | null;
  maxRally: number;
}

function playMatch(difficulty: Difficulty, seed: number, maxSimSeconds = 3 * 3600): Stats {
  const sim = new Simulation({ difficulty, assist: 0.5, humanControlled: false, seed });
  sim.startMatch(0);
  const st: Stats = { points: 0, hits: 0, faults: 0, lets: 0, reasons: {}, simSeconds: 0, sets: [], winner: null, maxRally: 0 };
  const maxTicks = maxSimSeconds / TICK_DT;
  let rally = 0;
  for (let i = 0; i < maxTicks && sim.phase !== 'match_over'; i++) {
    sim.tick();
    for (const e of sim.drainEvents()) {
      if (e.kind === 'hit') {
        st.hits++;
        rally++;
      } else if (e.kind === 'fault') st.faults++;
      else if (e.kind === 'let') st.lets++;
      else if (e.kind === 'point') {
        st.points++;
        st.reasons[e.reason] = (st.reasons[e.reason] ?? 0) + 1;
        st.maxRally = Math.max(st.maxRally, rally);
        rally = 0;
      }
    }
  }
  st.simSeconds = sim.now;
  st.sets = sim.match.scoring.completedSets;
  st.winner = sim.match.scoring.matchWinner;
  return st;
}

describe('full matches, AI on all four players', () => {
  for (const difficulty of ['easy', 'medium', 'hard'] as const) {
    it(`completes a match at ${difficulty} without stalling`, () => {
      const st = playMatch(difficulty, 12345);
      console.log(difficulty, JSON.stringify(st));
      expect(st.winner).not.toBeNull();
      expect(st.sets.length).toBeGreaterThanOrEqual(2);
      // Rallies happen: several strikes per point on average, serve included.
      expect(st.hits / st.points).toBeGreaterThan(2.5);
      // Serves mostly go in.
      expect(st.faults / st.points).toBeLessThan(0.6);
    }, 120000);
  }
});
