import * as THREE from 'three';
import { ringTexture } from './Textures';

/** Ground markers: the player's aim target and the predicted landing spot of an incoming ball. */
export class Indicators {
  private aim: THREE.Mesh;
  private landing: THREE.Mesh;
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
  }

  update(dt: number, aim: { x: number; z: number } | null, landing: { x: number; z: number; good: boolean } | null): void {
    this.t += dt;
    this.aim.visible = !!aim;
    if (aim) {
      this.aim.position.set(aim.x, 0.012, aim.z);
      const s = 1 + Math.sin(this.t * 6) * 0.06;
      this.aim.scale.set(s, s, 1);
    }
    this.landing.visible = !!landing;
    if (landing) {
      this.landing.position.set(landing.x, 0.011, landing.z);
      (this.landing.material as THREE.MeshBasicMaterial).color.set(landing.good ? 0x6dff9c : 0xffffff);
    }
  }
}
