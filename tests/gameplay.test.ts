import { beforeAll, describe, expect, it } from 'vitest';
import { CHARGE_TIME, OVER_START, aimTarget, gaugeAt, humanSigma, type ShotClass } from '../src/core/shots';
import { Simulation, type SimConfig } from '../src/core/sim';
import type { ShotType, SimEvent } from '../src/core/types';
import { initPhysics, TICK_DT } from '../src/physics/world';
import { COURT } from '../src/rules/court';

beforeAll(async () => {
  await initPhysics();
});

/** Measurements are printed when GAMEPLAY_LOG is set (tuning aid): run vitest with --silent=false. */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const log = (...a: unknown[]) => {
  if (env.GAMEPLAY_LOG) console.log(a.join(' '));
};

const TICKS = (seconds: number) => Math.round(seconds / TICK_DT);

/** Outcome of the human's shots: where each one first touched down. */
interface Tally {
  shots: number;
  in: number;
  wall: number;
  net: number;
  long: number;
  swings: number;
  misses: number;
  depth: number[];
}

/**
 * A scripted player 0: serves, then presses `type` when the planned contact is `lead` seconds
 * away, with the stick held at `aim`, and releases after `hold` seconds (0 = a tap).
 */
function play(
  cfg: Partial<SimConfig>,
  o: { type: ShotType; hold: number; aim: number; lead: number; seconds: number; stickWhileRunning?: number },
): Tally {
  const sim = new Simulation({ difficulty: 'medium', assist: 0.5, humanControlled: true, seed: 11, match: { setsToWin: 40 }, ...cfg });
  sim.startMatch(0);
  const t: Tally = { shots: 0, in: 0, wall: 0, net: 0, long: 0, swings: 0, misses: 0, depth: [] };
  let waiting = false;
  let releaseAt = -1;
  for (let i = 0; i < TICKS(o.seconds) && sim.phase !== 'match_over'; i++) {
    const charge = sim.chargeOf(0);
    if (sim.phase === 'serve_ready' && sim.server.id === 0 && !charge) sim.shot(0, { type: 'drive', power: 0.4, aim: 0 });
    const plan = sim.plans[0];
    const mine = sim.phase === 'rally' && sim.match.referee.lastHitTeam === 1;
    if (mine && plan && !charge && !sim.players[0].swing && plan.t - sim.now < o.lead) {
      sim.press(0, o.type);
      releaseAt = sim.now + o.hold;
    }
    if (charge && charge.held && sim.now >= releaseAt) sim.release(0);
    // The stick: aim while a shot is being prepared, otherwise the direction the player was running in.
    const aiming = !!sim.chargeOf(0);
    sim.setMove(0, aiming ? o.aim : (o.stickWhileRunning ?? 0), 0);
    sim.setAim(0, aiming ? o.aim : (o.stickWhileRunning ?? 0));
    sim.tick();
    for (const e of sim.drainEvents()) {
      if (e.kind === 'swing' && e.player === 0 && e.swing.stroke !== 'serve') {
        t.swings++;
        if (!e.swing.willHit) t.misses++;
      }
      if (e.kind === 'hit') waiting = e.player === 0 && e.stroke !== 'serve';
      else if (e.kind === 'bounce' && waiting) {
        waiting = false;
        t.shots++;
        if (e.surface === 'floor' && e.z < 0) {
          t.in++;
          t.depth.push(-e.z);
        } else if (e.surface === 'net' || (e.surface === 'floor' && e.z >= 0)) t.net++;
        else if (Math.abs(e.z) > COURT.halfLength - 0.2) t.long++;
        else t.wall++;
      }
    }
  }
  return t;
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

describe('aim', () => {
  it('always targets a point inside the lines, whatever the stick, the power and the help', () => {
    const classes: ShotClass[] = ['drive', 'volley', 'smash', 'bandeja', 'lob'];
    for (const cls of classes) {
      for (const assist of [0, 0.5, 1]) {
        for (const aim of [-1, -0.5, 0, 0.5, 1]) {
          for (const g of [0, 0.5, 0.88, 1]) {
            for (const fx of [-4.6, 0, 4.6]) {
              const t = aimTarget({ cls, g, aim, from: { x: fx, z: 6 }, rightX: 1, fwd: -1, assist, sigma: humanSigma(assist, 1, false) });
              expect(Math.abs(t.x)).toBeLessThanOrEqual(COURT.halfWidth - 0.3);
              expect(-t.z).toBeLessThanOrEqual(COURT.halfLength - 0.35);
              expect(-t.z).toBeGreaterThan(1);
            }
          }
        }
      }
    }
  });

  it('follows the stick: right goes right, left goes left, released goes back towards the middle', () => {
    const base = { cls: 'drive' as const, g: 0.5, from: { x: 3, z: 7 }, rightX: 1 as const, fwd: -1 as const, assist: 0.5, sigma: 0.39 };
    const left = aimTarget({ ...base, aim: -1 });
    const mid = aimTarget({ ...base, aim: 0 });
    const right = aimTarget({ ...base, aim: 1 });
    expect(left.x).toBeLessThan(-3);
    expect(right.x).toBeGreaterThan(3);
    expect(mid.x).toBeGreaterThan(0.5);
    expect(mid.x).toBeLessThan(2.5);
    // Seen from the other end of the court (the online guest's player), right is still the player's right.
    const far = aimTarget({ ...base, aim: 1, from: { x: -3, z: -7 }, rightX: -1, fwd: 1 });
    expect(far.x).toBeLessThan(-3);
    expect(far.z).toBeGreaterThan(0);
  });

  it('serves into the diagonal box wherever the stick points', () => {
    for (const box of [1, -1] as const) {
      for (const aim of [-1, -0.3, 0, 0.3, 1]) {
        for (const g of [0, 0.6, 1]) {
          const t = aimTarget({ cls: 'serve', g, aim, from: { x: -box * 2.1, z: 7.75 }, rightX: 1, fwd: -1, assist: 0.5, sigma: humanSigma(0.5, 1, true), serveBox: box });
          expect(t.x * box).toBeGreaterThan(0.5);
          expect(t.x * box).toBeLessThan(3.9);
          expect(-t.z).toBeLessThan(COURT.serviceLineZ - 0.3);
        }
      }
    }
  });

  it('keeps aimed shots in the court: full stick no longer means the side wall', () => {
    for (const aim of [-1, 1, 0.5, 0]) {
      const t = play({}, { type: 'drive', hold: 0.5, aim, lead: 0.9, seconds: 2500, stickWhileRunning: aim });
      log('drive aim', aim, JSON.stringify({ ...t, depth: mean(t.depth).toFixed(2) }));
      expect(t.shots).toBeGreaterThan(40);
      expect((t.wall + t.long) / t.shots).toBeLessThan(0.04);
    }
  }, 120000);
});

describe('power gauge', () => {
  it('fills in about a second and has an overhit zone at the top', () => {
    expect(gaugeAt(0)).toBe(0);
    expect(gaugeAt(CHARGE_TIME / 2)).toBeCloseTo(0.5, 5);
    expect(gaugeAt(5)).toBe(1);
    expect(OVER_START).toBeGreaterThan(0.8);
  });

  it('a measured smash stays in; only an overhit one risks the back wall', () => {
    const soft = play({}, { type: 'smash', hold: 0.3, aim: 0, lead: 1.2, seconds: 3000 });
    const ideal = play({}, { type: 'smash', hold: 0.75, aim: 0.6, lead: 1.2, seconds: 3000 });
    const full = play({}, { type: 'smash', hold: 3, aim: 0.6, lead: 1.2, seconds: 3000 });
    for (const [name, t] of [['soft', soft], ['ideal', ideal], ['full', full]] as const) {
      log('smash', name, JSON.stringify({ ...t, depth: mean(t.depth).toFixed(2) }));
    }
    expect(soft.shots).toBeGreaterThan(40);
    expect(soft.in / soft.shots).toBeGreaterThan(0.97);
    expect(ideal.in / ideal.shots).toBeGreaterThan(0.97);
    // Harder means deeper...
    expect(mean(ideal.depth)).toBeGreaterThan(mean(soft.depth) + 0.2);
    // ...and overhitting costs accuracy, without being hopeless.
    expect(full.in / full.shots).toBeLessThan(ideal.in / ideal.shots);
    expect(full.in / full.shots).toBeGreaterThan(0.6);
  }, 180000);

  it('serves at the power reached when the button is released', () => {
    const sim = new Simulation({ difficulty: 'medium', assist: 0.5, humanControlled: true, seed: 3 });
    sim.startMatch(0);
    const speeds: number[] = [];
    for (const hold of [0.1, 0.8]) {
      let pressed = false;
      let releaseAt = 0;
      for (let i = 0; i < TICKS(12); i++) {
        if (sim.phase === 'serve_ready' && !pressed) {
          sim.press(0, 'drive');
          pressed = true;
          releaseAt = sim.now + hold;
        }
        if (pressed && sim.now >= releaseAt) sim.release(0);
        sim.tick();
        const hit = sim.drainEvents().find((e) => e.kind === 'hit') as Extract<SimEvent, { kind: 'hit' }> | undefined;
        if (hit) {
          speeds.push(hit.speedKmh);
          expect(hit.power).toBeCloseTo(hold / CHARGE_TIME, 1);
          break;
        }
      }
      // Let the point finish before the next serve.
      for (let i = 0; i < TICKS(30) && !(sim.phase === 'serve_ready' && sim.server.id === 0 && pressed === true && speeds.length === 2); i++) {
        if (sim.phase === 'serve_ready' && sim.server.id === 0 && sim.now > releaseAt + 2) break;
        sim.tick();
        sim.drainEvents();
      }
    }
    expect(speeds.length).toBe(2);
    expect(speeds[1]).toBeGreaterThan(speeds[0] + 10);
  }, 60000);
});

describe('timing', () => {
  it('remembers a press made well before the ball arrives', () => {
    for (const lead of [0.25, 0.6, 1.0, 1.6]) {
      const t = play({}, { type: 'drive', hold: 0, aim: 0, lead, seconds: 1500 });
      log('tap lead', lead, JSON.stringify({ shots: t.shots, swings: t.swings, misses: t.misses }));
      expect(t.swings).toBeGreaterThan(30);
      expect(t.misses / t.swings).toBeLessThan(0.05);
    }
  }, 120000);

  it('does not turn a press made while the opponents get ready to serve into a swing at their serve', () => {
    const sim = new Simulation({ difficulty: 'medium', assist: 0.5, humanControlled: true, seed: 5 });
    sim.startMatch(2);
    let tapped = false;
    let swings = 0;
    for (let i = 0; i < TICKS(8); i++) {
      if (sim.phase === 'serve_ready' && !tapped) {
        sim.shot(0, { type: 'drive', power: 0.5 });
        tapped = true;
      }
      sim.tick();
      for (const e of sim.drainEvents()) if (e.kind === 'swing' && e.player === 0) swings++;
      if (sim.phase === 'point_over') break;
    }
    expect(tapped).toBe(true);
    expect(swings).toBe(0);
  });
});

describe('serve', () => {
  /** How far the server is from the serve position, and whether a receiver is out of place. */
  function offSpot(sim: Simulation): number {
    const server = sim.server;
    const sx = sim.match.referee.serveSide === 'right' ? server.rightX : -server.rightX;
    // The server stands behind the service line, on the correct side of the centre mark.
    const d = Math.hypot(server.x - sx * 2.1, Math.abs(server.z) - 7.75);
    const receivers = sim.active.filter((p) => p.team !== server.team);
    return Math.max(d, ...receivers.map((p) => (Math.abs(p.z) < 6.5 ? 9 : 0)));
  }

  it('puts everyone back in position for the second serve', () => {
    for (const singles of [false, true]) {
      for (const human of [true, false]) {
        const sim = new Simulation({ difficulty: 'medium', assist: 0.5, humanControlled: human, seed: 21, singles, match: { setsToWin: 40 } });
        sim.startMatch(0);
        let checked = 0;
        let afterFault = false;
        for (let i = 0; i < TICKS(600) && checked < 5; i++) {
          if (sim.phase === 'serve_ready' && afterFault) {
            // Second serve: server behind the service line on the right side, nobody at the net on the wrong spot.
            expect(offSpot(sim)).toBeLessThan(0.25);
            checked++;
            afterFault = false;
          }
          if (human && sim.phase === 'serve_ready' && sim.server.id === 0 && !sim.chargeOf(0)) sim.shot(0, { type: 'drive', power: 0.5, aim: 0 });
          // The human keeps the stick pushed towards the net, as a player following their serve in would.
          sim.setMove(0, 0.6, -1);
          sim.tick();
          for (const e of sim.drainEvents()) {
            // Every first serve is sent into the net.
            if (e.kind === 'hit' && e.stroke === 'serve' && sim.match.referee.serveNumber === 1) {
              const b = sim.world.ball;
              sim.world.setBall({ ...b, vx: 0, vy: -2, vz: -Math.sign(b.pz) * 6 });
            }
            if (e.kind === 'fault' && e.serveNumber === 1) afterFault = true;
          }
        }
        expect(checked).toBe(5);
      }
    }
  }, 120000);

  it('keeps the server still during the serve, so the stick only aims', () => {
    const sim = new Simulation({ difficulty: 'medium', assist: 0.5, humanControlled: true, seed: 8 });
    sim.startMatch(0);
    let x0 = 0;
    let z0 = 0;
    let started = false;
    for (let i = 0; i < TICKS(10); i++) {
      if (sim.phase === 'serve_ready' && !started) {
        x0 = sim.players[0].x;
        z0 = sim.players[0].z;
        sim.shot(0, { type: 'drive', power: 0.5 });
        started = true;
      }
      sim.setMove(0, 1, 0);
      sim.setAim(0, 1);
      sim.tick();
      const hit = sim.drainEvents().some((e) => e.kind === 'hit');
      if (hit) break;
    }
    expect(started).toBe(true);
    expect(Math.hypot(sim.players[0].x - x0, sim.players[0].z - z0)).toBeLessThan(0.05);
  });

  it('lands in the box at any stick position, and only risks a fault when overhit', () => {
    const run = (aim: number, power: number) => {
      const sim = new Simulation({ difficulty: 'medium', assist: 0.5, humanControlled: true, seed: 31, match: { setsToWin: 40 } });
      sim.startMatch(0);
      let serves = 0;
      let faults = 0;
      for (let i = 0; i < TICKS(4000) && serves < 100 && sim.phase !== 'match_over'; i++) {
        if (sim.phase === 'serve_ready' && sim.server.id === 0 && !sim.chargeOf(0)) {
          sim.shot(0, { type: 'drive', power });
          serves++;
        }
        sim.setAim(0, aim);
        sim.tick();
        for (const e of sim.drainEvents()) if (e.kind === 'fault' && sim.server.id === 0) faults++;
      }
      return { serves, faults };
    };
    for (const aim of [-1, -0.4, 0, 0.4, 1]) {
      const r = run(aim, 0.6);
      log('serve aim', aim, JSON.stringify(r));
      expect(r.serves).toBeGreaterThan(60);
      expect(r.faults / r.serves).toBeLessThan(0.05);
    }
    const hard = run(0, 1);
    log('serve full power', JSON.stringify(hard));
    expect(hard.faults / hard.serves).toBeGreaterThan(0.02);
    expect(hard.faults / hard.serves).toBeLessThan(0.4);
  }, 180000);
});
