import { beforeAll, describe, expect, it } from 'vitest';
import { Simulation } from '../src/core/sim';
import { GuestSim } from '../src/net/guest';
import { HostSession } from '../src/net/host';
import { createLoopback } from '../src/net/loopback';
import type { GuestMsg, HostMsg } from '../src/net/protocol';
import { mirrorEvent, mirrorScore } from '../src/net/protocol';
import { initPhysics, TICK_DT } from '../src/physics/world';

beforeAll(async () => {
  await initPhysics();
});

function onlineMatch(singles: boolean, dropFast: number) {
  let seed = 12345;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const [hostLink, guestLink] = createLoopback({ dropFast, random }) as ReturnType<typeof createLoopback> & Array<{ pump(): void }>;
  const sim = new Simulation({ difficulty: 'medium', assist: 1, humanControlled: false, humans: [0, 2], singles, seed: 2024, match: { setsToWin: 1, tiebreakAt: 0 } });
  const host = new HostSession(sim, hostLink);
  const guest = new GuestSim(guestLink);
  hostLink.onMessage = (m) => host.receive(m as GuestMsg);
  guestLink.onMessage = (m) => guest.receive(m as HostMsg);
  sim.startMatch(0);
  host.sendStart();

  const dt = TICK_DT * 2; // one rendered frame = two ticks
  const hits = [0, 0, 0, 0];
  const guestKinds = new Set<string>();
  let maxErr = 0;
  let lastGuestSwing = -1;
  for (let frame = 0; frame < 400000 && !(sim.phase === 'match_over' && guest.phase === 'match_over'); frame++) {
    // Host player: serves and swings using the simulation's own plan.
    const p0 = sim.players[0];
    if (sim.phase === 'serve_ready' && sim.server === p0) sim.shot(0, { type: 'drive', power: 0.5, aim: 0 });
    const plan = sim.plans[0];
    if (sim.phase === 'rally' && sim.hitterId === 0 && plan && plan.t - sim.now < 0.3 && !p0.swing) sim.shot(0, { type: 'drive', power: 0.5, aim: 0 });
    sim.tick();
    sim.tick();
    const events = sim.drainEvents();
    for (const e of events) if (e.kind === 'hit') hits[e.player]++;
    host.afterFrame(events, dt);
    (guestLink as unknown as { pump(): void }).pump();

    // Guest player: only sees its mirrored replay. Serves, runs at the ball, swings when it is close.
    guest.sync(dt);
    const me = guest.players[0];
    const b = guest.world.ball;
    if (guest.phase === 'serve_ready' && guest.match.referee.server === 0) guest.humanShot({ type: 'drive', power: 0.5, aim: 0 });
    if (guest.phase === 'rally' && b.pz > 0.5) {
      const dx = b.px - me.x - 0.5;
      const dz = b.pz - me.z + 0.3;
      const d = Math.hypot(dx, dz);
      guest.setHumanMove(d > 0.3 ? dx / d : 0, d > 0.3 ? dz / d : 0);
      if (Math.hypot(b.px - me.x, b.pz - me.z) < 1.6 && b.py < 2.2 && guest.now - lastGuestSwing > 0.5) {
        guest.humanShot({ type: 'drive', power: 0.5, aim: 0 });
        lastGuestSwing = guest.now;
      }
    } else guest.setHumanMove(0, 0);
    for (const e of guest.drainEvents()) guestKinds.add(e.kind);
    (hostLink as unknown as { pump(): void }).pump();

    // The guest's own player is the host's player 2, half a turn round and a tenth of a second late.
    if (guest.ready && frame % 30 === 0 && sim.phase === 'rally') {
      maxErr = Math.max(maxErr, Math.hypot(me.x + sim.players[2].x, me.z + sim.players[2].z));
    }
  }
  return { sim, guest, hits, guestKinds, maxErr };
}

describe('guest controls', () => {
  it('sends the held button, its release and the stick to the host, which plays the shot', () => {
    const [hostLink, guestLink] = createLoopback({ dropFast: 0, random: () => 0.5 }) as ReturnType<typeof createLoopback> & Array<{ pump(): void }>;
    const sim = new Simulation({ difficulty: 'medium', assist: 0.5, humanControlled: false, humans: [0, 2], singles: true, seed: 5 });
    const host = new HostSession(sim, hostLink);
    const guest = new GuestSim(guestLink);
    hostLink.onMessage = (m) => host.receive(m as GuestMsg);
    guestLink.onMessage = (m) => guest.receive(m as HostMsg);
    sim.startMatch(2); // the guest serves
    host.sendStart();
    const dt = TICK_DT * 2;
    let pressedAt = -1;
    let released = false;
    let seen: number | null = null;
    let power: number | undefined;
    let landedX: number | null = null;
    for (let frame = 0; frame < 2000 && landedX === null; frame++) {
      sim.tick();
      sim.tick();
      const events = sim.drainEvents();
      for (const e of events) {
        if (e.kind === 'hit' && e.player === 2) power = e.power;
        if (e.kind === 'bounce' && power !== undefined && e.surface === 'floor') landedX = e.x;
      }
      host.afterFrame(events, dt);
      (guestLink as unknown as { pump(): void }).pump();
      guest.sync(dt);
      guest.drainEvents();
      if (guest.phase === 'serve_ready' && guest.match.referee.server === 0 && pressedAt < 0) {
        guest.humanPress('drive');
        pressedAt = frame;
      }
      // Stick fully to the guest's right while the button is held for half a second.
      if (pressedAt >= 0) guest.setHumanMove(1, 0);
      if (pressedAt >= 0 && !released && frame - pressedAt >= 30) {
        seen = sim.chargeOf(2)?.gauge ?? null;
        // The guest's own gauge shows the same level as the host's, within the link delay.
        expect(guest.humanCharge()?.gauge).toBeCloseTo(seen ?? 0, 0);
        guest.humanRelease();
        released = true;
      }
      (hostLink as unknown as { pump(): void }).pump();
    }
    expect(seen).toBeGreaterThan(0.35);
    expect(power).toBeGreaterThan(0.35);
    expect(power).toBeLessThan(0.7);
    // The guest plays from the far end: its right is the host's -x. Serving from the right-hand
    // side into the diagonal box (host +x), the stick to the right moves the ball towards the centre line.
    expect(landedX).not.toBeNull();
    expect(landedX!).toBeGreaterThan(0);
    expect(landedX!).toBeLessThan(2.2);
  });
});

describe('online match over a loopback link', () => {
  it('mirrors events and scores for the guest', () => {
    const e = mirrorEvent({ kind: 'hit', player: 2, stroke: 'forehand', speedKmh: 60, x: 1, y: 1, z: -8 });
    expect(e).toMatchObject({ player: 0, x: -1, z: 8 });
    expect(mirrorEvent({ kind: 'point', winner: 1, reason: 'ace', winnerShot: true, game: false, set: false, match: false })).toMatchObject({ winner: 0 });
    const s = mirrorScore({ points: [1, 3], games: [2, 0], sets: [0, 1], completedSets: [[4, 6]], tiebreak: false, server: 3, serveSide: 'left', matchWinner: 1 });
    expect(s).toMatchObject({ points: [3, 1], games: [0, 2], sets: [1, 0], completedSets: [[6, 4]], server: 1, matchWinner: 0 });
  });

  for (const singles of [false, true]) {
    it(`plays a whole ${singles ? '1v1' : '2v2'} tie-break with the guest following the host`, () => {
      const { sim, guest, hits, guestKinds, maxErr } = onlineMatch(singles, 0.1);
      expect(sim.phase).toBe('match_over');
      expect(guest.phase).toBe('match_over');
      // Same result on both sides, seen from opposite ends.
      const hostWinner = sim.match.scoring.matchWinner!;
      expect(guest.match.scoring.matchWinner).toBe(1 - hostWinner);
      expect(guest.match.scoring.completedSets).toEqual(sim.match.scoring.completedSets.map((x) => [x[1], x[0]]));
      // The guest's controls reached the host: its player struck the ball.
      expect(hits[2]).toBeGreaterThan(0);
      expect(hits[0]).toBeGreaterThan(0);
      if (singles) expect(hits[1] + hits[3]).toBe(0);
      // The guest heard about hits, bounces, points and swings.
      for (const k of ['hit', 'bounce', 'point', 'swing', 'serve_ready']) expect(guestKinds.has(k)).toBe(true);
      expect(maxErr).toBeLessThan(1.6);
    }, 120000);
  }
});
