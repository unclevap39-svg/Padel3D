import { describe, expect, it } from 'vitest';
import { inServiceBox, serviceBoxXSign, serverXSign } from '../src/rules/court';
import { Match } from '../src/rules/match';
import { Referee } from '../src/rules/referee';
import { Scoring } from '../src/rules/scoring';

const winPoints = (s: Scoring, team: 0 | 1, n: number) => {
  for (let i = 0; i < n; i++) s.pointWon(team);
};
const winGames = (s: Scoring, team: 0 | 1, n: number) => {
  for (let i = 0; i < n; i++) winPoints(s, team, 4);
};

describe('scoring: points', () => {
  it('counts 15, 30, 40, game', () => {
    const s = new Scoring();
    expect(s.pointLabel(0)).toBe('0');
    s.pointWon(0);
    expect(s.pointLabel(0)).toBe('15');
    s.pointWon(0);
    expect(s.pointLabel(0)).toBe('30');
    s.pointWon(0);
    expect(s.pointLabel(0)).toBe('40');
    const ev = s.pointWon(0);
    expect(ev.map((e) => e.kind)).toEqual(['point', 'game']);
    expect(s.games).toEqual([1, 0]);
    expect(s.points).toEqual([0, 0]);
  });

  it('handles deuce and advantage', () => {
    const s = new Scoring();
    winPoints(s, 0, 3);
    winPoints(s, 1, 3);
    expect(s.pointLabel(0)).toBe('40');
    expect(s.pointLabel(1)).toBe('40');
    expect(s.announcement()).toBe('Égalité');
    s.pointWon(1);
    expect(s.pointLabel(1)).toBe('Av');
    expect(s.pointLabel(0)).toBe('');
    expect(s.games).toEqual([0, 0]);
    s.pointWon(0); // back to deuce
    expect(s.pointLabel(0)).toBe('40');
    expect(s.pointLabel(1)).toBe('40');
    s.pointWon(0);
    s.pointWon(0);
    expect(s.games).toEqual([1, 0]);
  });

  it('golden point ends the game at 40-40', () => {
    const s = new Scoring({ goldenPoint: true });
    winPoints(s, 0, 3);
    winPoints(s, 1, 3);
    s.pointWon(1);
    expect(s.games).toEqual([0, 1]);
  });

  it('announces the score from the server side', () => {
    const s = new Scoring({}, 0);
    s.pointWon(0);
    expect(s.announcement()).toBe('quinze zéro');
    s.pointWon(1);
    expect(s.announcement()).toBe('quinze partout');
    s.pointWon(1);
    expect(s.announcement()).toBe('quinze trente');
  });
});

describe('scoring: service', () => {
  it('alternates the serving side each point', () => {
    const s = new Scoring();
    expect(s.serveSide).toBe('right');
    s.pointWon(0);
    expect(s.serveSide).toBe('left');
    s.pointWon(1);
    expect(s.serveSide).toBe('right');
  });

  it('rotates the server A1, B1, A2, B2 every game', () => {
    const s = new Scoring({}, 0);
    const servers: number[] = [];
    for (let i = 0; i < 5; i++) {
      servers.push(s.server);
      winPoints(s, 0, 4);
    }
    expect(servers).toEqual([0, 2, 1, 3, 0]);
  });

  it('serves diagonally', () => {
    // Team 0 (z > 0, facing -z): its right is +x, so the target box is x < 0.
    expect(serverXSign(0, 'right')).toBe(1);
    expect(serviceBoxXSign(0, 'right')).toBe(-1);
    expect(serverXSign(1, 'right')).toBe(-1);
    expect(serviceBoxXSign(1, 'right')).toBe(1);
    expect(serviceBoxXSign(0, 'left')).toBe(1);
  });

  it('knows the service box limits', () => {
    expect(inServiceBox(-2, -3, 1, -1)).toBe(true);
    expect(inServiceBox(2, -3, 1, -1)).toBe(false); // wrong half
    expect(inServiceBox(-2, -7.5, 1, -1)).toBe(false); // behind the service line
    expect(inServiceBox(-2, -6.95, 1, -1)).toBe(true); // on the line
    expect(inServiceBox(0, -3, 1, -1)).toBe(true); // on the centre line
    expect(inServiceBox(-2, 3, 1, -1)).toBe(false); // server's own side
  });
});

describe('scoring: sets, tie-break, match', () => {
  it('wins a set 6-4', () => {
    const s = new Scoring();
    winGames(s, 0, 5);
    winGames(s, 1, 4);
    expect(s.sets).toEqual([0, 0]);
    winGames(s, 0, 1);
    expect(s.sets).toEqual([1, 0]);
    expect(s.completedSets).toEqual([[6, 4]]);
    expect(s.games).toEqual([0, 0]);
  });

  it('needs two games of margin: 7-5', () => {
    const s = new Scoring();
    winGames(s, 0, 5);
    winGames(s, 1, 5);
    winGames(s, 0, 1);
    expect(s.sets).toEqual([0, 0]);
    expect(s.tiebreak).toBe(false);
    winGames(s, 0, 1);
    expect(s.completedSets).toEqual([[7, 5]]);
  });

  it('plays a tie-break at 6-6, first to 7 with two points of margin', () => {
    const s = new Scoring();
    winGames(s, 0, 5);
    winGames(s, 1, 5);
    winGames(s, 0, 1);
    winGames(s, 1, 1);
    expect(s.tiebreak).toBe(true);
    winPoints(s, 0, 6);
    winPoints(s, 1, 6);
    expect(s.pointLabel(0)).toBe('6');
    s.pointWon(0); // 7-6: not enough
    expect(s.sets).toEqual([0, 0]);
    s.pointWon(0); // 8-6
    expect(s.sets).toEqual([1, 0]);
    expect(s.completedSets).toEqual([[7, 6]]);
    expect(s.tiebreak).toBe(false);
  });

  it('changes server after the first tie-break point, then every two points', () => {
    const s = new Scoring({}, 0);
    winGames(s, 0, 5);
    winGames(s, 1, 5);
    winGames(s, 0, 1);
    winGames(s, 1, 1);
    // 12 games played: the order wraps back to player 0.
    const servers: number[] = [];
    const sides: string[] = [];
    for (let i = 0; i < 7; i++) {
      servers.push(s.server);
      sides.push(s.serveSide);
      s.pointWon(i % 2 === 0 ? 0 : 1);
    }
    expect(servers).toEqual([0, 2, 2, 1, 1, 3, 3]);
    expect(sides).toEqual(['right', 'left', 'right', 'left', 'right', 'left', 'right']);
  });

  it('the player after the tie-break opener serves first in the next set', () => {
    const s = new Scoring({}, 0);
    winGames(s, 0, 5);
    winGames(s, 1, 5);
    winGames(s, 0, 1);
    winGames(s, 1, 1);
    const opener = s.server;
    winPoints(s, 0, 7);
    expect(opener).toBe(0);
    expect(s.server).toBe(2);
  });

  it('wins the match in two sets and then ignores further points', () => {
    const s = new Scoring();
    winGames(s, 1, 6);
    const ev = (() => {
      winGames(s, 1, 5);
      winPoints(s, 1, 3);
      return s.pointWon(1);
    })();
    expect(ev.map((e) => e.kind)).toEqual(['point', 'game', 'set', 'match']);
    expect(s.matchWinner).toBe(1);
    expect(s.pointWon(0)).toEqual([]);
    expect(s.announcement()).toBe('Jeu, set et match');
  });
});

/** Player 0 (team 0, z > 0) serving from the right: the box is x < 0, z < 0. */
const newRef = () => new Referee(0, 'right');

describe('referee: service', () => {
  it('accepts a serve in the diagonal box and lets the rally start', () => {
    const r = newRef();
    r.serveStruck();
    expect(r.canReceiverHit).toBe(false);
    expect(r.bounce('floor', -2, -4)).toEqual({ kind: 'none' });
    expect(r.canReceiverHit).toBe(true);
    expect(r.hit(2)).toEqual({ kind: 'none' });
    expect(r.phase).toBe('rally');
  });

  it('calls a fault for the wrong box, then a double fault', () => {
    const r = newRef();
    r.serveStruck();
    expect(r.bounce('floor', 2, -4)).toEqual({ kind: 'fault', reason: 'serve_out_of_box', serveNumber: 1 });
    expect(r.serveNumber).toBe(2);
    r.serveStruck();
    expect(r.bounce('floor', -2, -8)).toEqual({ kind: 'point', winner: 1, reason: 'double_fault' });
  });

  it('calls a fault when the serve dies in the net', () => {
    const r = newRef();
    r.serveStruck();
    expect(r.bounce('net', 0, 0.01)).toEqual({ kind: 'none' });
    expect(r.bounce('floor', 0, 0.5)).toEqual({ kind: 'fault', reason: 'serve_net', serveNumber: 1 });
  });

  it('replays a net-cord serve that lands in the box, keeping the serve number', () => {
    const r = newRef();
    r.serveStruck();
    r.bounce('floor', 3, -3); // first serve: fault
    r.serveStruck();
    r.bounce('net', 0, 0);
    expect(r.bounce('floor', -1, -2)).toEqual({ kind: 'let' });
    expect(r.serveNumber).toBe(2);
    expect(r.phase).toBe('awaiting_serve');
  });

  it('calls a fault when the serve hits a wall before bouncing', () => {
    const r = newRef();
    r.serveStruck();
    expect(r.bounce('glass', -3, -10).kind).toBe('fault');
  });

  it('allows glass after the bounce but not the wire mesh', () => {
    const a = newRef();
    a.serveStruck();
    a.bounce('floor', -2, -6);
    expect(a.bounce('glass', -2, -10)).toEqual({ kind: 'none' });
    expect(a.hit(3)).toEqual({ kind: 'none' });

    const b = newRef();
    b.serveStruck();
    b.bounce('floor', -4.5, -5);
    expect(b.bounce('fence', -5, -5.5)).toEqual({ kind: 'fault', reason: 'serve_fence_after_bounce', serveNumber: 1 });
  });

  it('awards an ace on the second bounce', () => {
    const r = newRef();
    r.serveStruck();
    r.bounce('floor', -2, -6);
    expect(r.bounce('floor', -2, -9)).toEqual({ kind: 'point', winner: 0, reason: 'ace' });
  });

  it('punishes volleying the serve', () => {
    const r = newRef();
    r.serveStruck();
    expect(r.hit(2)).toEqual({ kind: 'point', winner: 0, reason: 'volley_on_serve' });
  });
});

describe('referee: rally', () => {
  /** Good serve by team 0, returned by team 1: team 0 must now play. */
  const rally = () => {
    const r = newRef();
    r.serveStruck();
    r.bounce('floor', -2, -4);
    r.hit(2);
    return r;
  };

  it('gives the point on a second bounce', () => {
    const r = rally();
    expect(r.bounce('floor', 1, 5)).toEqual({ kind: 'none' });
    expect(r.bounce('floor', 1, 8)).toEqual({ kind: 'point', winner: 1, reason: 'second_bounce' });
  });

  it('lets the ball come off the glass after the bounce', () => {
    const r = rally();
    r.bounce('floor', 1, 8);
    expect(r.bounce('glass', 1, 10)).toEqual({ kind: 'none' });
    expect(r.bounce('fence', 5, 4)).toEqual({ kind: 'none' });
    expect(r.hit(0)).toEqual({ kind: 'none' });
    expect(r.lastHitTeam).toBe(0);
  });

  it('allows a volley', () => {
    const r = rally();
    expect(r.hit(1)).toEqual({ kind: 'none' });
  });

  it('loses the point when the ball hits the opponents glass directly', () => {
    const r = rally();
    expect(r.bounce('glass', 0, 10)).toEqual({ kind: 'point', winner: 0, reason: 'wall_direct' });
  });

  it('loses the point when the ball hits the wire mesh directly', () => {
    const r = rally();
    expect(r.bounce('fence', 5, 3)).toEqual({ kind: 'point', winner: 0, reason: 'fence_direct' });
  });

  it('allows playing off your own glass, but not your own mesh', () => {
    const a = rally();
    // Team 1 hit last; its side is z < 0.
    expect(a.bounce('glass', 0, -10)).toEqual({ kind: 'none' });
    expect(a.bounce('floor', 0, 4)).toEqual({ kind: 'none' });
    expect(a.hit(0)).toEqual({ kind: 'none' });

    const b = rally();
    expect(b.bounce('fence', -5, -3)).toEqual({ kind: 'point', winner: 0, reason: 'fence_direct' });
  });

  it('loses the point when the ball lands on the hitter side', () => {
    const r = rally();
    r.bounce('net', 0, -0.01);
    expect(r.bounce('floor', 0, -0.4)).toEqual({ kind: 'point', winner: 0, reason: 'net' });
  });

  it('keeps a net cord in play', () => {
    const r = rally();
    r.bounce('net', 0, 0);
    expect(r.bounce('floor', 0, 0.6)).toEqual({ kind: 'none' });
  });

  it('judges balls that leave the enclosure', () => {
    const a = rally();
    expect(a.out()).toEqual({ kind: 'point', winner: 0, reason: 'out' });
    const b = rally();
    b.bounce('floor', 2, 7);
    expect(b.out()).toEqual({ kind: 'point', winner: 1, reason: 'out_after_bounce' });
  });

  it('forbids the same team hitting twice', () => {
    const r = rally();
    expect(r.hit(3)).toEqual({ kind: 'point', winner: 0, reason: 'double_hit' });
  });

  it('ignores events once the point is over', () => {
    const r = rally();
    r.bounce('floor', 1, 5);
    r.bounce('floor', 1, 8);
    expect(r.bounce('floor', 1, 9)).toEqual({ kind: 'none' });
    expect(r.hit(0)).toEqual({ kind: 'none' });
    expect(r.out()).toEqual({ kind: 'none' });
  });
});

describe('match', () => {
  it('turns referee decisions into score and a fresh referee', () => {
    const m = new Match({}, 0);
    expect(m.referee.server).toBe(0);
    m.serveStruck();
    m.bounce('floor', -2, -4);
    const ev = m.bounce('floor', -2, -8);
    expect(ev?.kind).toBe('point');
    expect(m.scoring.points).toEqual([1, 0]);
    expect(m.referee.serveSide).toBe('left');
    expect(m.referee.phase).toBe('awaiting_serve');
  });

  it('keeps the same referee on a first-serve fault', () => {
    const m = new Match({}, 0);
    m.serveStruck();
    expect(m.bounce('floor', 2, -4)).toEqual({ kind: 'fault', serveNumber: 1, reason: 'serve_out_of_box' });
    expect(m.referee.serveNumber).toBe(2);
    expect(m.scoring.points).toEqual([0, 0]);
  });

  it('plays a whole game on aces and hands the serve over', () => {
    const m = new Match({}, 0);
    for (let i = 0; i < 4; i++) {
      const side = m.referee.serveSide;
      const boxX = side === 'right' ? -2 : 2;
      m.serveStruck();
      m.bounce('floor', boxX, -4);
      m.bounce('floor', boxX, -8);
    }
    expect(m.scoring.games).toEqual([1, 0]);
    expect(m.referee.server).toBe(2);
  });
});
