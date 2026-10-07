import * as THREE from 'three';
import { COURT } from '../utils/Constants';
import { clamp, damp, lerp } from '../utils/MathUtils';

export interface CameraFocus {
  player: THREE.Vector3;
  ball: THREE.Vector3;
  ballLive: boolean;
  /** +1 when the followed player is on the near side. */
  side: 1 | -1;
}

/**
 * Third-person broadcast-style camera behind the local player. Follows the player smoothly,
 * leans slightly toward the ball, rises for high balls, and widens its FOV in portrait so the
 * full court width stays visible. Impact "kick" is a short decaying offset, not a random shake.
 */
export class CameraRig {
  private pos = new THREE.Vector3(0, 6, COURT.HALF_LENGTH + 8);
  private look = new THREE.Vector3(0, 0.5, -3);
  private kick = 0;
  private aspect = 1.6;
  shakeEnabled = true;

  constructor(private camera: THREE.PerspectiveCamera) {}

  /** 0 = tall portrait phone, 1 = landscape; tablets blend between the two framings. */
  private get landscapeBlend(): number {
    return clamp((this.aspect - 0.6) / 0.7, 0, 1);
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    // Landscape keeps ~62deg horizontal view; portrait uses a fixed tall vertical FOV and a
    // higher, steeper camera so the long court fills the screen.
    const hfov = THREE.MathUtils.degToRad(62);
    const landscapeV = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect)), 42, 70);
    this.camera.fov = lerp(66, landscapeV, this.landscapeBlend);
    this.camera.updateProjectionMatrix();
  }

  impulse(strength: number): void {
    if (this.shakeEnabled) this.kick = Math.min(1, this.kick + strength);
  }

  /** Instantly place the camera (used at the start of each point). */
  snap(f: CameraFocus): void {
    this.computeTargets(f);
    this.pos.copy(this.tPos);
    this.look.copy(this.tLook);
    this.apply();
  }

  private tPos = new THREE.Vector3();
  private tLook = new THREE.Vector3();

  private computeTargets(f: CameraFocus): void {
    const s = f.side;
    const L = this.landscapeBlend;
    const ballX = f.ballLive ? f.ball.x : f.player.x;
    const ballZ = f.ballLive ? f.ball.z : -s * 3;
    const ballY = f.ballLive ? f.ball.y : 1;
    const depth = f.player.z * s; // player's distance from the net
    const back = lerp(7.4, 7.6, L) + clamp(depth - COURT.HALF_LENGTH, -2, 3) * 0.55;
    const height = lerp(10.5, 5.4, L) + clamp(ballY - 2.5, 0, 4) * 0.35 + clamp(-ballZ * s - 4, 0, 4) * 0.15;
    const x = f.player.x * lerp(0.35, 0.55, L) + ballX * 0.15;
    this.tPos.set(x, height, s * (Math.max(depth, COURT.HALF_LENGTH - 2) + back));
    const lookZ = clamp(ballZ * 0.25 - s * lerp(0.2, 2.6, L), -COURT.HALF_LENGTH, COURT.HALF_LENGTH);
    this.tLook.set(f.player.x * 0.3 + ballX * 0.25, 0.4 + clamp(ballY - 2, 0, 3) * 0.3, lookZ);
  }

  update(f: CameraFocus, dt: number): void {
    this.computeTargets(f);
    this.pos.x = damp(this.pos.x, this.tPos.x, 4, dt);
    this.pos.y = damp(this.pos.y, this.tPos.y, 2.5, dt);
    this.pos.z = damp(this.pos.z, this.tPos.z, 3, dt);
    this.look.x = damp(this.look.x, this.tLook.x, 3.5, dt);
    this.look.y = damp(this.look.y, this.tLook.y, 3, dt);
    this.look.z = damp(this.look.z, this.tLook.z, 2.5, dt);
    this.kick = Math.max(0, this.kick - dt * 4);
    this.apply();
  }

  private apply(): void {
    const k = this.kick * this.kick;
    this.camera.position.set(this.pos.x, this.pos.y - k * 0.25, this.pos.z - k * 0.6 * Math.sign(this.pos.z || 1));
    this.camera.lookAt(this.look);
  }
}
