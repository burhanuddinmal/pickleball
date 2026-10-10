import * as THREE from 'three';
import { clamp } from '../utils/MathUtils';
import { ringTexture } from './Textures';

/** Aim ring scale-in / scale-out time (s). */
const AIM_POP = 0.12;

export interface LandingMarker {
  x: number;
  z: number;
  /** Within reach of the hero: tinted green. */
  good: boolean;
  /** 1 just after the opponent's hit, 0 at the bounce. */
  remaining01: number;
}

/** Ground markers: the player's aim target and the predicted landing spot of an incoming ball. */
export class Indicators {
  private aim: THREE.Mesh;
  private landing: THREE.Mesh;
  private landingMat: THREE.MeshBasicMaterial;
  private aimK = 0;
  private t = 0;

  constructor(scene: THREE.Scene) {
    const tex = ringTexture();
    const mk = (color: number, size: number) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, depthWrite: false, opacity: 0.85 }),
      );
      m.rotation.x = -Math.PI / 2;
      m.renderOrder = 3;
      m.visible = false;
      scene.add(m);
      return m;
    };
    this.aim = mk(0xffe14d, 0.75);
    this.landing = mk(0xffffff, 0.55);
    this.landingMat = this.landing.material as THREE.MeshBasicMaterial;
  }

  update(dt: number, aim: { x: number; z: number } | null, landing: LandingMarker | null): void {
    this.t += dt;
    // Aim ring pops in and out in place rather than toggling instantly.
    this.aimK = clamp(this.aimK + (aim ? dt : -dt) / AIM_POP, 0, 1);
    this.aim.visible = this.aimK > 0;
    if (aim) this.aim.position.set(aim.x, 0.012, aim.z);
    if (this.aim.visible) {
      const pop = 1 - Math.pow(1 - this.aimK, 3);
      const s = (1 + Math.sin(this.t * 6) * 0.06) * pop;
      this.aim.scale.set(s, s, 1);
    }

    this.landing.visible = !!landing;
    if (landing) {
      // Countdown: the ring closes from ~1.8x to 1x and firms up as the bounce approaches.
      const r = clamp(landing.remaining01, 0, 1);
      const s = 1 + 0.8 * r;
      this.landing.position.set(landing.x, 0.011, landing.z);
      this.landing.scale.set(s, s, 1);
      this.landingMat.opacity = 0.95 - 0.55 * r;
      this.landingMat.color.set(landing.good ? 0x6dff9c : 0xffffff);
    }
  }
}
