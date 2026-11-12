import * as THREE from 'three';

const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/**
 * Broadcast-style camera: behind and above the player, drifting sideways with them and gently
 * tracking the ball. `focus` pulls it in for slow-motion replays of winners.
 */
export class CameraRig {
  private pos = new THREE.Vector3(0, 6.4, 18);
  private look = new THREE.Vector3(0, 0.8, 4.1);
  private baseFov = 35;
  /** 0..1: how much the camera closes in on the ball (slow motion). */
  focus = 0;
  /** Menu mode: slow orbit around the court. */
  orbit = false;
  /**
   * Home screen: close view of the player's character. `shift` places it across the frame:
   * 0 in the middle, 1 at the right edge, -1 at the left edge.
   */
  hero: { zoom: number; shift?: number } | null = null;
  private heroShift = 0;
  private orbitT = 0;
  private wantPos = new THREE.Vector3();
  private wantLook = new THREE.Vector3();

  setBaseFov(fov: number): void {
    this.baseFov = fov;
  }

  /** Jump straight to the framing for this player and ball, without easing. */
  snap(camera: THREE.PerspectiveCamera, player = { x: 2.5, z: 8 }, ball = { x: 0, y: 1, z: 0 }): void {
    this.update(camera, 100, player, ball);
  }

  update(camera: THREE.PerspectiveCamera, dt: number, player: { x: number; z: number }, ball: { x: number; y: number; z: number }): void {
    const bx = Math.max(-5, Math.min(5, ball.x));
    const bz = Math.max(-10, Math.min(10, ball.z));
    if (this.hero) {
      this.orbitT += dt;
      const k = this.hero.zoom;
      const sway = Math.sin(this.orbitT * 0.25) * 0.1;
      // Place the character about three quarters of the way across the screen, whatever its shape.
      const dist = 3.7 * k;
      const halfWidth = dist * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
      this.heroShift += ((this.hero.shift ?? 0.56) - this.heroShift) * Math.min(1, dt * 5);
      const lateral = this.heroShift * halfWidth;
      this.wantPos.set(player.x + lateral + 0.3 + sway, 1.28, player.z - dist);
      this.wantLook.set(player.x + lateral, 1.0, player.z);
    } else if (this.orbit) {
      this.orbitT += dt;
      const a = Math.sin(this.orbitT * 0.12) * 0.5;
      this.wantPos.set(Math.sin(a) * 17 + 3.5, 5.6, Math.cos(a) * 17);
      this.wantLook.set(3.2 + bx * 0.1, 0.9, -1 + bz * 0.1);
    } else {
      // The player's depth pulls the camera in a little when they come to the net.
      const depth = Math.max(0, Math.min(1, (8 - player.z) / 6));
      this.wantPos.set(player.x * 0.42 + bx * 0.12, 6.4 - depth * 0.4, 18 - depth * 2.4);
      this.wantLook.set(player.x * 0.25 + bx * 0.25, 0.8 + Math.min(1.0, ball.y * 0.1), 4.1 - depth * 2.6 + bz * 0.05);
      if (this.focus > 0) {
        this.wantLook.lerp(new THREE.Vector3(bx, Math.min(2, ball.y * 0.5) + 0.4, bz), this.focus * 0.7);
      }
    }
    this.pos.lerp(this.wantPos, damp(2.6, dt));
    this.look.lerp(this.wantLook, damp(3.4, dt));
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
    const fov = this.baseFov * (1 - 0.14 * this.focus);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }
}
