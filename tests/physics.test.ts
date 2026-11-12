import { beforeAll, describe, expect, it } from 'vitest';
import { BALL_RADIUS, type BallState, predict, solveShot } from '../src/physics/ballistics';
import { PHYSICS_DT, PhysicsWorld, TICK_DT, initPhysics } from '../src/physics/world';

const ball = (p: Partial<BallState>): BallState => ({ px: 0, py: 1, pz: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0, ...p });

beforeAll(async () => {
  await initPhysics();
});

describe('ball physics (Rapier)', () => {
  it('rebounds to a regulation-like height from a 2.54 m drop', () => {
    const w = new PhysicsWorld();
    w.setBall(ball({ px: 2, py: 2.54, pz: 5 }));
    let bounced = false;
    let apex = 0;
    for (let i = 0; i < 800; i++) {
      w.step();
      if (w.contacts.some((c) => c.surface === 'floor')) bounced = true;
      if (bounced) apex = Math.max(apex, w.ball.py - BALL_RADIUS);
      if (bounced && w.ball.vy < 0) break;
    }
    expect(bounced).toBe(true);
    // Regulation on a hard floor is 1.35-1.45 m; sand-filled turf takes a little off.
    expect(apex).toBeGreaterThan(1.1);
    expect(apex).toBeLessThan(1.45);
  });

  it('comes back off the back glass', () => {
    const w = new PhysicsWorld();
    w.setBall(ball({ px: 0, py: 1.2, pz: 8, vz: 15 }));
    let hit = false;
    for (let i = 0; i < 240 && !hit; i++) {
      w.step();
      hit = w.contacts.some((c) => c.surface === 'glass');
    }
    expect(hit).toBe(true);
    for (let i = 0; i < 5; i++) w.step();
    expect(w.ball.vz).toBeLessThan(-5);
    expect(w.ball.pz).toBeLessThan(10);
  });

  it('does not tunnel through the glass at smash speed', () => {
    const w = new PhysicsWorld();
    w.setBall(ball({ px: 0, py: 1.0, pz: 9.5, vz: 60 }));
    for (let i = 0; i < 30; i++) w.step();
    expect(w.ball.pz).toBeLessThan(10);
  });

  it('is stopped by the net', () => {
    const w = new PhysicsWorld();
    w.setBall(ball({ px: 1, py: 0.5, pz: 2, vz: -20 }));
    let net = false;
    for (let i = 0; i < 240; i++) {
      w.step();
      if (w.contacts.some((c) => c.surface === 'net')) net = true;
    }
    expect(net).toBe(true);
    expect(w.ball.pz).toBeGreaterThan(0);
  });

  it('scatters off the wire mesh', () => {
    const run = (seed: number) => {
      const w = new PhysicsWorld();
      let s = seed;
      w.random = () => {
        s = (s * 16807) % 2147483647;
        return s / 2147483647;
      };
      w.setBall(ball({ px: 4, py: 1.5, pz: 0, vx: 12 }));
      for (let i = 0; i < 120; i++) w.step();
      return { vx: w.ball.vx, vz: w.ball.vz };
    };
    const a = run(11);
    const b = run(977);
    expect(a.vx).toBeLessThan(0);
    expect(b.vx).toBeLessThan(0);
    expect(Math.abs(a.vz - b.vz)).toBeGreaterThan(0.05);
  });

  it('top spin dips and kicks forward, slice floats and holds up', () => {
    const fly = (spin: number) => {
      const w = new PhysicsWorld();
      // Moving along -z; top spin axis is up × direction = (dz, 0, -dx) = (-1, 0, 0).
      w.setBall(ball({ px: 0, py: 1, pz: 9, vy: 5.5, vz: -14, wx: -spin }));
      let t = 0;
      for (let i = 0; i < 1200; i++) {
        w.step();
        t += PHYSICS_DT;
        if (w.contacts.some((c) => c.surface === 'floor')) break;
      }
      const landZ = w.ball.pz;
      for (let i = 0; i < 3; i++) w.step();
      return { landZ, t, vzAfter: w.ball.vz };
    };
    const top = fly(170);
    const flat = fly(0);
    const slice = fly(-170);
    // Top spin lands shorter (less negative z travelled), slice carries further.
    expect(top.landZ).toBeGreaterThan(flat.landZ + 0.3);
    expect(slice.landZ).toBeLessThan(flat.landZ - 0.3);
    // After the bounce top spin keeps more forward pace than slice.
    expect(Math.abs(top.vzAfter)).toBeGreaterThan(Math.abs(slice.vzAfter));
  });
});

describe('predictor and shot solver', () => {
  it('predicts where the Rapier ball lands', () => {
    const start = ball({ px: 1, py: 1, pz: 8, vx: -1, vy: 4, vz: -13, wx: -120 });
    const p = predict(start);
    const w = new PhysicsWorld();
    w.setBall(start);
    let land: { x: number; z: number } | null = null;
    for (let i = 0; i < 1200 && !land; i++) {
      w.step();
      const c = w.contacts.find((k) => k.surface === 'floor');
      if (c) land = { x: c.x, z: c.z };
    }
    expect(p.firstBounce).not.toBeNull();
    expect(land).not.toBeNull();
    expect(Math.abs(p.firstBounce!.x - land!.x)).toBeLessThan(0.15);
    expect(Math.abs(p.firstBounce!.z - land!.z)).toBeLessThan(0.15);
  });

  it('predicts the rebound off the back glass closely enough to position a player', () => {
    const start = ball({ px: 0.5, py: 1, pz: -2, vx: 0.5, vy: 3.5, vz: 17 });
    const p = predict(start, 3);
    const w = new PhysicsWorld();
    w.setBall(start);
    const at = p.samples.find((s) => s.walls >= 1 && s.t > 1.2);
    expect(at).toBeDefined();
    const steps = Math.round(at!.t / PHYSICS_DT);
    for (let i = 0; i < steps; i++) w.step();
    expect(Math.hypot(w.ball.px - at!.x, w.ball.pz - at!.z)).toBeLessThan(0.6);
  });

  it('solves flat, top-spin, slice and lob shots onto the target', () => {
    const cases = [
      { spin: 'flat' as const, speed: 18, lob: false },
      { spin: 'top' as const, speed: 22, lob: false },
      { spin: 'slice' as const, speed: 14, lob: false },
      { spin: 'top' as const, speed: 12, lob: true },
    ];
    for (const c of cases) {
      const sol = solveShot({
        from: { x: 2, y: 0.9, z: 8 },
        target: { x: -3, z: -7 },
        speed: c.speed,
        spin: c.spin,
        spinRate: 150,
        lob: c.lob,
      });
      expect(sol.ok).toBe(true);
      const p = predict(sol);
      expect(p.net).toBe(false);
      expect(p.firstBounce).not.toBeNull();
      expect(Math.hypot(p.firstBounce!.x + 3, p.firstBounce!.z + 7)).toBeLessThan(0.25);
    }
  });

  it('slows a shot down rather than hitting the net from low and close', () => {
    const sol = solveShot({
      from: { x: 0, y: 0.4, z: 2 },
      target: { x: 0, z: -3 },
      speed: 30,
      spin: 'flat',
      spinRate: 0,
    });
    const p = predict(sol);
    expect(p.net).toBe(false);
    expect(sol.speed).toBeLessThan(30);
  });

  it('smashes downward from a high contact point', () => {
    const sol = solveShot({
      from: { x: 0, y: 2.7, z: 3 },
      target: { x: 2, z: -6 },
      speed: 32,
      spin: 'flat',
      spinRate: 0,
    });
    expect(sol.ok).toBe(true);
    expect(sol.vy).toBeLessThan(0);
  });
});

/** Distance between the predicted and the simulated ball `after` seconds past its n-th contact. */
function drift(start: BallState, after: number, contacts: number): number | null {
  const w = new PhysicsWorld();
  w.random = () => 0.5;
  w.setBall(start);
  const pred = predict(start, 5, 0, 1);
  let seen = 0;
  let tHit = -1;
  for (let i = 1; i < 5 / TICK_DT; i++) {
    w.tick();
    const t = i * TICK_DT;
    for (const c of w.contacts) {
      if (c.surface === 'fence' || c.surface === 'net') return null; // the mesh scatters at random
      seen++;
      if (seen === contacts) tHit = t;
    }
    if (tHit >= 0 && t >= tHit + after) {
      const s = pred.samples.find((x) => x.t >= t - 1e-6);
      if (!s) return null;
      const b = w.ball;
      return Math.hypot(s.x - b.px, s.y - b.py, s.z - b.pz);
    }
  }
  return null;
}

describe('predictor after a bounce', () => {
  // Players run to where the ball is predicted to be: after a bounce the prediction must stay
  // close to the real path, or they head for the wrong spot and jump when the ball lands.
  const shots: Array<[string, Parameters<typeof solveShot>[0]]> = [
    ['serve', { from: { x: 2.1, y: 0.55, z: 7.3 }, target: { x: -2.4, z: -5.3 }, speed: 17, spin: 'slice', spinRate: 50, netClearance: 0.2 }],
    ['drive', { from: { x: 1, y: 0.8, z: 8 }, target: { x: -3, z: -7.5 }, speed: 20, spin: 'top', spinRate: 100, netClearance: 0.25 }],
    ['fast drive', { from: { x: -2, y: 0.8, z: 7 }, target: { x: 3.5, z: -8.4 }, speed: 24, spin: 'top', spinRate: 120, netClearance: 0.25 }],
    ['volley', { from: { x: 0, y: 1.2, z: 3 }, target: { x: 2, z: -7 }, speed: 16, spin: 'slice', spinRate: 70, netClearance: 0.18 }],
    ['bandeja', { from: { x: 0, y: 2.3, z: 5 }, target: { x: -3, z: -8 }, speed: 17, spin: 'slice', spinRate: 110, netClearance: 0.25 }],
    ['smash', { from: { x: 1, y: 2.4, z: 3 }, target: { x: -2, z: -6.3 }, speed: 30, spin: 'top', spinRate: 30, netClearance: 0.1 }],
    ['hard smash', { from: { x: -1, y: 2.4, z: 4 }, target: { x: 2.5, z: -6.8 }, speed: 38, spin: 'top', spinRate: 30, netClearance: 0.1 }],
    ['lob', { from: { x: 2, y: 0.8, z: 8 }, target: { x: -2, z: -8.6 }, speed: 12, spin: 'top', spinRate: 40, lob: true, lobAngle: 1.0 }],
  ];
  for (const [name, spec] of shots) {
    it(`follows a ${name} through its bounce on the floor and off the glass`, () => {
      const start = solveShot(spec);
      const floorSoon = drift(start, 0.2, 1);
      const floorLate = drift(start, 0.45, 1);
      const glassSoon = drift(start, 0.2, 2);
      expect(floorSoon).not.toBeNull();
      expect(floorSoon!).toBeLessThan(0.25);
      if (floorLate !== null) expect(floorLate).toBeLessThan(0.5);
      if (glassSoon !== null) expect(glassSoon).toBeLessThan(0.45);
    });
  }
});
