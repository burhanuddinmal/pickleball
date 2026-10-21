import * as THREE from 'three';
import { clamp } from '../utils/MathUtils';
import { Confetti } from './Confetti';
import { Particles } from './Particles';
import type { GraphicsQuality } from './SceneManager';
import { ringTexture } from './Textures';

const RING_COUNT = 6;
const RING_LIFE = 0.38;

interface GroundRing {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  t: number;
  size: number;
  alpha: number;
}

/**
 * One-shot impact VFX: paddle-contact flash and sparks, bounce dust and expanding ground rings,
 * net puffs, whiff swirls, footwork dust and match-win confetti.
 * Driven by rally events from GameManager; purely visual.
 */
export class Effects {
  /** Bright additive flash sprite on contact; off under reduce-effects. */
  flashEnabled = true;
  private sparks: Particles;
  private dust: Particles;
  private confettiPool: Confetti;
  private rings: GroundRing[] = [];
  private nextRing = 0;
  private density: number;
  private readonly v = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor(scene: THREE.Scene, quality: GraphicsQuality) {
    this.density = quality === 'low' ? 0.5 : 1;
    this.sparks = new Particles(quality === 'low' ? 64 : 160, THREE.AdditiveBlending, 0.7);
    this.dust = new Particles(quality === 'low' ? 48 : 120, THREE.NormalBlending, 0.9);
    this.confettiPool = new Confetti(quality === 'low' ? 80 : 200);
    scene.add(this.sparks.points, this.dust.points, this.confettiPool.mesh);

    const tex = ringTexture();
    for (let i = 0; i < RING_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 3;
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh, mat, t: RING_LIFE, size: 1, alpha: 0 });
    }
  }

  /** Paddle contact at `pos`; `vel` is the ball's new velocity, `intensity` 0..1. */
  hitBurst(pos: THREE.Vector3, vel: THREE.Vector3, intensity: number): void {
    const k = clamp(intensity, 0, 1);
    if (this.flashEnabled) {
      this.sparks.emit({ pos, life: 0.08 + 0.06 * k, size: 0.3 + 0.45 * k, grow: 1.7, color: 0xfff4c2, alpha: 0.9 });
    }
    this.dir.copy(vel);
    if (this.dir.lengthSq() < 1e-6) this.dir.set(0, 1, 0);
    this.dir.normalize();
    const count = Math.round((5 + 9 * k) * this.density);
    for (let i = 0; i < count; i++) {
      // Cone around the outgoing direction, plus a little backspray.
      this.v.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(1.3);
      this.v.add(this.dir).normalize().multiplyScalar(2.5 + Math.random() * (3 + 6 * k));
      this.sparks.emit({
        pos,
        vel: this.v,
        life: 0.16 + Math.random() * 0.18,
        size: 0.06 + Math.random() * 0.04,
        grow: 0.3,
        color: Math.random() < 0.5 ? 0xffffff : 0xffe14d,
        gravity: 6,
        drag: 4,
      });
    }
  }

  /** Ball bounce at `pos` with impact `speed` (m/s); out-of-bounds rings are tinted red. */
  bounceBurst(pos: THREE.Vector3, speed: number, inBounds: boolean): void {
    if (speed < 1) return;
    const k = clamp(speed / 8, 0.2, 1);
    const count = Math.round((4 + 8 * k) * this.density);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = (0.6 + Math.random()) * 1.4 * k;
      this.p.set(pos.x + Math.cos(a) * 0.05, 0.03, pos.z + Math.sin(a) * 0.05);
      this.v.set(Math.cos(a) * out, 0.4 + Math.random() * 0.6 * k, Math.sin(a) * out);
      this.dust.emit({
        pos: this.p,
        vel: this.v,
        life: 0.35 + Math.random() * 0.25,
        size: 0.08 + Math.random() * 0.06,
        grow: 2.5,
        color: 0xdfe9f5,
        alpha: 0.5,
        gravity: 1.5,
        drag: 3,
      });
    }
    const ring = this.rings[this.nextRing];
    this.nextRing = (this.nextRing + 1) % RING_COUNT;
    ring.t = 0;
    ring.size = 0.55 + 0.6 * k;
    ring.alpha = 0.45 + 0.35 * k;
    ring.mat.color.set(inBounds ? 0xffffff : 0xff6b5a);
    ring.mesh.position.set(pos.x, 0.013, pos.z);
    ring.mesh.visible = true;
  }

  /** Ball meets the net at `pos`: a puff of white fibres/dust, bigger on a tape (cord) hit. */
  netPuff(pos: THREE.Vector3, tape: boolean): void {
    const count = Math.round((tape ? 10 : 6) * this.density);
    for (let i = 0; i < count; i++) {
      // Spray sideways and to both faces of the net, a little upward.
      this.v.set((Math.random() - 0.5) * 1.6, 0.3 + Math.random() * (tape ? 1.4 : 0.6), (Math.random() - 0.5) * 2.2);
      this.dust.emit({
        pos,
        vel: this.v,
        life: 0.3 + Math.random() * 0.2,
        size: 0.05 + Math.random() * 0.05,
        grow: 2,
        color: 0xffffff,
        alpha: tape ? 0.7 : 0.5,
        gravity: 1,
        drag: 4,
      });
    }
  }

  /** Swing that missed everything: a faint air swirl at the paddle (`pos`). */
  whiffPuff(pos: THREE.Vector3): void {
    const count = Math.round(5 * this.density);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.6;
      this.p.set(pos.x + Math.cos(a) * 0.08, pos.y + Math.sin(a) * 0.08, pos.z);
      this.v.set(Math.cos(a) * 0.6, Math.sin(a) * 0.6 + 0.2, (Math.random() - 0.5) * 0.4);
      this.dust.emit({
        pos: this.p,
        vel: this.v,
        life: 0.35 + Math.random() * 0.15,
        size: 0.07 + Math.random() * 0.04,
        grow: 2.4,
        color: 0xeef4ff,
        alpha: 0.35,
        drag: 3,
      });
    }
  }

  /** Hard push-off at an athlete's feet (`pos`); dust kicks back along `-dir` (horizontal). */
  footDust(pos: THREE.Vector3, dir: THREE.Vector3): void {
    const count = Math.round(4 * this.density);
    for (let i = 0; i < count; i++) {
      this.p.set(pos.x + (Math.random() - 0.5) * 0.25, 0.03, pos.z + (Math.random() - 0.5) * 0.25);
      const out = 0.6 + Math.random() * 0.8;
      this.v.set(-dir.x * out + (Math.random() - 0.5) * 0.5, 0.25 + Math.random() * 0.4, -dir.z * out + (Math.random() - 0.5) * 0.5);
      this.dust.emit({
        pos: this.p,
        vel: this.v,
        life: 0.3 + Math.random() * 0.2,
        size: 0.07 + Math.random() * 0.05,
        grow: 2.6,
        color: 0xd9e2ec,
        alpha: 0.35,
        gravity: 1.2,
        drag: 3.5,
      });
    }
  }

  /** Match-win confetti bursting up around `pos` (the winner's feet). */
  confetti(pos: THREE.Vector3): void {
    this.confettiPool.burst(pos, Math.round(200 * this.density));
  }

  clearConfetti(): void {
    this.confettiPool.clear();
  }

  update(dt: number, camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    this.confettiPool.update(dt);
    const pixelScale = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.sparks.update(dt, pixelScale);
    this.dust.update(dt, pixelScale);
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.t += dt;
      const k = r.t / RING_LIFE;
      if (k >= 1) {
        r.mesh.visible = false;
        continue;
      }
      const s = r.size * (0.25 + 0.75 * (1 - Math.pow(1 - k, 3)));
      r.mesh.scale.set(s, s, 1);
      r.mat.opacity = r.alpha * (1 - k);
    }
  }
}
