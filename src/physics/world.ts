import RAPIER from '@dimforge/rapier3d-compat';
import { COURT } from '../rules/court';
import {
  BALL_INERTIA,
  BALL_MASS,
  BALL_RADIUS,
  type BallState,
  GRAVITY,
  SURFACES,
  SPIN_DAMPING,
  type SurfaceProps,
  aeroAccel,
} from './ballistics';

export type ContactSurface = 'floor' | 'glass' | 'fence' | 'net' | 'ground';

export interface BallContact {
  surface: ContactSurface;
  x: number;
  y: number;
  z: number;
  /** Ball speed just before the contact, m/s. */
  speed: number;
}

/**
 * Rapier limits rotation to a quarter turn per step, so the step must be short enough for
 * realistic spin: at 240 Hz the ceiling is about 188 rad/s (1800 rpm).
 */
export const PHYSICS_DT = 1 / 240;
export const SUBSTEPS_PER_TICK = 2;
/** Fixed game tick: two physics substeps. */
export const TICK_DT = PHYSICS_DT * SUBSTEPS_PER_TICK;
export const MAX_SPIN = 180;
const WALL_T = 0.12;

let rapierReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

/**
 * Rapier world holding the court (floor, glass, wire mesh, net) and the ball as the only dynamic
 * body. Drag and the Magnus effect are applied as forces every step.
 */
export class PhysicsWorld {
  private world: RAPIER.World;
  private events: RAPIER.EventQueue;
  private ballBody: RAPIER.RigidBody;
  private ballCollider: RAPIER.Collider;
  private surfaces = new Map<number, ContactSurface>();
  private aero = { x: 0, y: 0, z: 0 };
  private state: BallState = { px: 0, py: 1, pz: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 };
  /** Contacts that began during the last step. */
  readonly contacts: BallContact[] = [];
  /** Random source for the wire mesh's irregular rebound; replaceable for deterministic tests. */
  random: () => number = Math.random;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_DT;
    this.events = new RAPIER.EventQueue(true);
    this.buildCourt();

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, 1, 0)
      .setCcdEnabled(true)
      .setCanSleep(false)
      .setLinearDamping(0)
      .setAngularDamping(SPIN_DAMPING);
    this.ballBody = this.world.createRigidBody(bodyDesc);
    const colDesc = RAPIER.ColliderDesc.ball(BALL_RADIUS)
      .setMassProperties(
        BALL_MASS,
        { x: 0, y: 0, z: 0 },
        { x: BALL_INERTIA, y: BALL_INERTIA, z: BALL_INERTIA },
        { x: 0, y: 0, z: 0, w: 1 },
      )
      .setRestitution(1)
      .setFriction(1)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.ballCollider = this.world.createCollider(colDesc, this.ballBody);
  }

  private addBox(
    surface: ContactSurface,
    props: SurfaceProps,
    min: [number, number, number],
    max: [number, number, number],
  ): void {
    const desc = RAPIER.ColliderDesc.cuboid((max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2)
      .setTranslation((max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2)
      .setRestitution(props.restitution)
      .setFriction(props.friction)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
    const c = this.world.createCollider(desc);
    this.surfaces.set(c.handle, surface);
  }

  private buildCourt(): void {
    const W = COURT.halfWidth;
    const L = COURT.halfLength;
    // Playing surface, and the ground around the enclosure a little lower.
    this.addBox('floor', SURFACES.floor, [-W, -0.5, -L], [W, 0, L]);
    this.addBox('ground', SURFACES.ground, [-40, -0.6, -40], [40, -0.03, 40]);

    for (const s of [-1, 1]) {
      // Back wall: glass then mesh.
      const z0 = s > 0 ? L : -L - WALL_T;
      const z1 = s > 0 ? L + WALL_T : -L;
      this.addBox('glass', SURFACES.glass, [-W - WALL_T, 0, z0], [W + WALL_T, COURT.backGlassHeight, z1]);
      this.addBox('fence', SURFACES.fence, [-W - WALL_T, COURT.backGlassHeight, z0], [W + WALL_T, COURT.backTotalHeight, z1]);
      // Side walls.
      const x0 = s > 0 ? W : -W - WALL_T;
      const x1 = s > 0 ? W + WALL_T : -W;
      for (const e of [-1, 1]) {
        const a = COURT.sideStep1Length;
        const b = a + COURT.sideStep2Length;
        const zr = (d0: number, d1: number): [number, number] => {
          const za = e * (L - d0);
          const zb = e * (L - d1);
          return [Math.min(za, zb), Math.max(za, zb)];
        };
        const [p0, p1] = zr(0, a);
        this.addBox('glass', SURFACES.glass, [x0, 0, p0], [x1, COURT.sideStep1GlassHeight, p1]);
        this.addBox('fence', SURFACES.fence, [x0, COURT.sideStep1GlassHeight, p0], [x1, COURT.sideStep1TotalHeight, p1]);
        const [q0, q1] = zr(a, b);
        this.addBox('glass', SURFACES.glass, [x0, 0, q0], [x1, COURT.sideStep2GlassHeight, q1]);
        this.addBox('fence', SURFACES.fence, [x0, COURT.sideStep2GlassHeight, q0], [x1, COURT.sideStep2TotalHeight, q1]);
      }
      const c = L - COURT.sideStep1Length - COURT.sideStep2Length;
      this.addBox('fence', SURFACES.fence, [x0, 0, -c], [x1, COURT.sideFenceHeight, c]);

      // Net: two convex halves, 0.92 m at the post down to 0.88 m in the middle.
      const t = 0.012;
      const xp = s * W;
      const pts = new Float32Array([
        0, 0, -t, 0, 0, t, 0, COURT.netHeightCenter, -t, 0, COURT.netHeightCenter, t,
        xp, 0, -t, xp, 0, t, xp, COURT.netHeightPost, -t, xp, COURT.netHeightPost, t,
      ]);
      const hull = RAPIER.ColliderDesc.convexHull(pts);
      if (hull) {
        hull
          .setRestitution(SURFACES.net.restitution)
          .setFriction(SURFACES.net.friction)
          .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
        const col = this.world.createCollider(hull);
        this.surfaces.set(col.handle, 'net');
      }
    }
  }

  /** Current ball state (position, velocity, spin). The returned object is reused. */
  get ball(): Readonly<BallState> {
    return this.state;
  }

  setBall(b: BallState): void {
    this.ballBody.setTranslation({ x: b.px, y: b.py, z: b.pz }, true);
    this.ballBody.setLinvel({ x: b.vx, y: b.vy, z: b.vz }, true);
    this.ballBody.setAngvel({ x: b.wx, y: b.wy, z: b.wz }, true);
    Object.assign(this.state, b);
  }

  /** Orientation of the ball, for rendering its spin. */
  ballRotation(): { x: number; y: number; z: number; w: number } {
    return this.ballBody.rotation();
  }

  /** Advances by one physics substep; `contacts` holds what the ball touched during it. */
  step(): void {
    this.contacts.length = 0;
    this.substep();
  }

  /** Advances by one game tick; `contacts` holds what the ball touched during it. */
  tick(): void {
    this.contacts.length = 0;
    for (let i = 0; i < SUBSTEPS_PER_TICK; i++) this.substep();
  }

  private substep(): void {
    const s = this.state;
    const speedBefore = Math.hypot(s.vx, s.vy, s.vz);
    const bx = s.px;
    const by = s.py;
    const bz = s.pz;
    const bvx = s.vx;
    const bvy = s.vy;
    const bvz = s.vz;
    aeroAccel(s, this.aero);
    this.ballBody.resetForces(true);
    this.ballBody.addForce({ x: this.aero.x * BALL_MASS, y: this.aero.y * BALL_MASS, z: this.aero.z * BALL_MASS }, true);
    this.world.step(this.events);
    this.readBall();

    const first = this.contacts.length;
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const other = h1 === this.ballCollider.handle ? h2 : h1;
      const surface = this.surfaces.get(other);
      if (!surface) return;
      let x = s.px;
      let z = s.pz;
      if ((surface === 'floor' || surface === 'ground') && bvy < -1e-3) {
        // Place the contact where the incoming path met the surface, not where the ball is
        // after the step: line calls need the real landing spot.
        const top = surface === 'floor' ? 0 : -0.03;
        const tc = Math.min(PHYSICS_DT, Math.max(0, (by - BALL_RADIUS - top) / -bvy));
        x = bx + bvx * tc;
        z = bz + bvz * tc;
      }
      this.contacts.push({ surface, x, y: s.py, z, speed: speedBefore });
    });

    for (let i = first; i < this.contacts.length; i++) {
      if (this.contacts[i].surface === 'fence') this.scatterOffMesh();
    }
  }

  private readBall(): void {
    const p = this.ballBody.translation();
    const v = this.ballBody.linvel();
    const w = this.ballBody.angvel();
    const s = this.state;
    s.px = p.x;
    s.py = p.y;
    s.pz = p.z;
    s.vx = v.x;
    s.vy = v.y;
    s.vz = v.z;
    s.wx = w.x;
    s.wy = w.y;
    s.wz = w.z;
  }

  /** The wire mesh returns the ball unpredictably: random deflection and loss of pace. */
  private scatterOffMesh(): void {
    const s = this.state;
    const speed = Math.hypot(s.vx, s.vy, s.vz);
    if (speed < 0.5) return;
    const r = this.random;
    const k = 0.35 * speed;
    const scale = 0.7 + 0.3 * r();
    const vx = (s.vx + (r() - 0.5) * k) * scale;
    const vy = (s.vy + (r() - 0.5) * k) * scale;
    const vz = (s.vz + (r() - 0.5) * k) * scale;
    // Never let the perturbation push the ball back into the wall it just left.
    const outX = Math.abs(s.px) > COURT.halfWidth - 0.15 ? -Math.sign(s.px) : 0;
    const outZ = Math.abs(s.pz) > COURT.halfLength - 0.15 ? -Math.sign(s.pz) : 0;
    const fx = outX !== 0 && vx * outX < 0.3 ? outX * 0.3 : vx;
    const fz = outZ !== 0 && vz * outZ < 0.3 ? outZ * 0.3 : vz;
    this.ballBody.setLinvel({ x: fx, y: vy, z: fz }, true);
    this.ballBody.setAngvel({ x: s.wx * 0.4, y: s.wy * 0.4, z: s.wz * 0.4 }, true);
    s.vx = fx;
    s.vy = vy;
    s.vz = fz;
  }
}
