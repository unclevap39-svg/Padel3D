import { BallView } from './entities/ball';
import { PhysicsWorld, TICK_DT, initPhysics } from './physics/world';
import { Stage } from './render/stage';

async function boot() {
  await initPhysics();
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const stage = new Stage(canvas, 'high');
  const world = new PhysicsWorld();
  const ball = new BallView();
  stage.scene.add(ball.group);
  const serve = () => world.setBall({ px: 2, py: 1.1, pz: 8.5, vx: -2.2, vy: 4.2, vz: -15, wx: -80, wy: 0, wz: 0 });
  serve();
  let acc = 0;
  let last = performance.now();
  let t = 0;
  document.getElementById('loading')?.classList.add('done');
  window.addEventListener('resize', () => stage.resize());
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    acc += dt;
    while (acc >= TICK_DT) {
      world.tick();
      acc -= TICK_DT;
      t += TICK_DT;
      if (t > 4) {
        t = 0;
        serve();
      }
    }
    ball.update(world.ball, world.ballRotation(), stage.camera);
    stage.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  (window as unknown as Record<string, unknown>).__dbg = { stage, world };
}
boot();
