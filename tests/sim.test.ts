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

function playMatch(difficulty: Difficulty, seed: number, maxSimSeconds = 3 * 3600, singles = false): Stats {
  const sim = new Simulation({ difficulty, assist: 0.5, humanControlled: false, seed, singles, match: singles ? { setsToWin: 1 } : undefined });
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

describe('one against one', () => {
  it('completes a singles match with only two players on court', () => {
    const st = playMatch('medium', 4242, 3 * 3600, true);
    console.log('singles', JSON.stringify(st));
    expect(st.winner).not.toBeNull();
    expect(st.hits / st.points).toBeGreaterThan(2);
  }, 120000);

  it('alternates the serve between the two players and keeps the others off court', () => {
    const sim = new Simulation({ difficulty: 'medium', assist: 0.5, humanControlled: false, seed: 7, singles: true });
    sim.startMatch(0);
    expect(sim.active.map((p) => p.id)).toEqual([0, 2]);
    expect(sim.players[1].active).toBe(false);
    const servers = new Set<number>();
    for (let i = 0; i < 400000 && sim.match.scoring.games[0] + sim.match.scoring.games[1] < 4; i++) {
      sim.tick();
      servers.add(sim.match.referee.server);
      sim.drainEvents();
    }
    expect([...servers].sort()).toEqual([0, 2]);
  }, 120000);
});

describe('two human players', () => {
  it('lets a human on each side serve and rally', () => {
    const sim = new Simulation({ difficulty: 'medium', assist: 1, humanControlled: false, humans: [0, 2], seed: 99, match: { setsToWin: 1, tiebreakAt: 0 } });
    sim.startMatch(0);
    const hitsBy = [0, 0, 0, 0];
    for (let i = 0; i < 2e6 && sim.phase !== 'match_over'; i++) {
      // Each "human" serves when it is their turn and swings when the ball is theirs.
      for (const id of [0, 2] as const) {
        const p = sim.players[id];
        if (sim.phase === 'serve_ready' && sim.server === p) sim.shot(id, { type: 'drive', power: 0.5, angle: sim.match.referee.serveSide === 'right' ? -0.4 : 0.4 });
        const plan = sim.plans[id];
        if (sim.phase === 'rally' && sim.hitterId === id && plan && plan.t - sim.now < 0.3 && !p.swing) sim.shot(id, { type: 'drive', power: 0.5, angle: 0 });
      }
      sim.tick();
      for (const e of sim.drainEvents()) if (e.kind === 'hit') hitsBy[e.player]++;
    }
    expect(sim.phase).toBe('match_over');
    expect(hitsBy[0]).toBeGreaterThan(0);
    expect(hitsBy[2]).toBeGreaterThan(0);
  }, 120000);
});
