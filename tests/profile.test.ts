import { describe, expect, it } from 'vitest';
import { CATALOG, MODES, applyMatch, buyItem, defaultProfile, equipItem, levelOf, xpForLevel } from '../src/core/profile';
import { Scoring } from '../src/rules/scoring';

const summary = (over: Partial<Parameters<typeof applyMatch>[1]> = {}) => ({
  mode: 'quick' as const,
  won: true,
  pointsWon: 24,
  pointsLost: 10,
  aces: 2,
  winners: 5,
  longestRally: 9,
  ...over,
});

describe('tie-break only matches', () => {
  it('starts in a tie-break and ends the match when it is won', () => {
    const s = new Scoring({ setsToWin: 1, tiebreakAt: 0 });
    expect(s.tiebreak).toBe(true);
    for (let i = 0; i < 6; i++) s.pointWon(0);
    expect(s.matchWinner).toBeNull();
    const ev = s.pointWon(0);
    expect(ev.map((e) => e.kind)).toEqual(['point', 'game', 'set', 'match']);
    expect(s.matchWinner).toBe(0);
  });

  it('still needs two points of margin', () => {
    const s = new Scoring({ setsToWin: 1, tiebreakAt: 0 });
    for (let i = 0; i < 6; i++) {
      s.pointWon(0);
      s.pointWon(1);
    }
    s.pointWon(1);
    expect(s.matchWinner).toBeNull();
    s.pointWon(1);
    expect(s.matchWinner).toBe(1);
  });
});

describe('profile', () => {
  it('starts with the free item of each kind owned and equipped', () => {
    const p = defaultProfile();
    for (const kind of ['racket', 'outfit', 'court', 'ball'] as const) {
      const free = CATALOG.filter((i) => i.kind === kind && i.price === 0);
      expect(free).toHaveLength(1);
      expect(p.owned).toContain(free[0].id);
      expect(p.equipped[kind]).toBe(free[0].id);
    }
  });

  it('levels up on a growing experience curve', () => {
    expect(levelOf(0).level).toBe(1);
    expect(levelOf(xpForLevel(2) - 1).level).toBe(1);
    expect(levelOf(xpForLevel(2)).level).toBe(2);
    expect(xpForLevel(4) - xpForLevel(3)).toBeGreaterThan(xpForLevel(3) - xpForLevel(2));
  });

  it('buys only what the player can afford, once, and equips it', () => {
    const p = defaultProfile();
    p.coins = 300;
    expect(buyItem(p, 'racket.aurum')).toBe(false); // too expensive
    expect(buyItem(p, 'racket.blaze')).toBe(true);
    expect(p.coins).toBe(0);
    expect(p.equipped.racket).toBe('racket.blaze');
    expect(buyItem(p, 'racket.blaze')).toBe(false); // already owned
    expect(equipItem(p, 'racket.volt')).toBe(true);
    expect(equipItem(p, 'racket.ruby')).toBe(false); // not owned
    expect(p.equipped.racket).toBe('racket.volt');
  });

  it('pays coins and experience for a match and records the statistics', () => {
    const p = defaultProfile();
    const before = p.coins;
    const r = applyMatch(p, summary());
    const quick = MODES.find((m) => m.id === 'quick')!;
    expect(r.coins).toBeGreaterThanOrEqual(quick.winCoins);
    expect(p.coins).toBe(before + r.coins);
    expect(p.stats).toMatchObject({ matches: 1, wins: 1, pointsWon: 24, aces: 2, winners: 5, streak: 1, bestStreak: 1, longestRally: 9 });
    applyMatch(p, summary({ won: false }));
    expect(p.stats.streak).toBe(0);
    expect(p.stats.bestStreak).toBe(1);
    expect(p.stats.matches).toBe(2);
  });

  it('advances through the tournament and awards the trophy for winning the final', () => {
    const p = defaultProfile();
    applyMatch(p, summary({ mode: 'tournament' }));
    expect(p.tournamentRound).toBe(1);
    applyMatch(p, summary({ mode: 'tournament' }));
    expect(p.tournamentRound).toBe(2);
    const final = applyMatch(p, summary({ mode: 'tournament' }));
    expect(p.tournamentRound).toBe(0);
    expect(p.stats.trophies).toBe(1);
    expect(final.notes.join(' ')).toContain('trophée');
  });

  it('sends a losing team back to the first round', () => {
    const p = defaultProfile();
    applyMatch(p, summary({ mode: 'tournament' }));
    applyMatch(p, summary({ mode: 'tournament', won: false }));
    expect(p.tournamentRound).toBe(0);
    expect(p.stats.trophies).toBe(0);
  });

  it('pays the daily bonus once a day', () => {
    const p = defaultProfile();
    const first = applyMatch(p, summary({ mode: 'daily' }));
    const second = applyMatch(p, summary({ mode: 'daily' }));
    expect(first.coins).toBeGreaterThan(second.coins + 200);
  });
});
