import * as THREE from 'three';
import type { BallState } from '../physics/BallPhysics';
import { BALL } from '../utils/Constants';
import { ballTexture, blobTexture } from './Textures';

const TRAIL_POINTS = 14;

/** Ball mesh, ground contact shadow and a short fading trail. Reads BallState only. */
export class BallView {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh;
  private shadow: THREE.Mesh;
  private trail: THREE.Mesh;
  private trailPos: THREE.Vector3[] = [];
  private trailGeo: THREE.BufferGeometry;
  private trailMat: THREE.MeshBasicMaterial;
  private readonly r = BALL.RADIUS * BALL.VISUAL_SCALE;

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshStandardMaterial({
      map: ballTexture(),
      roughness: 0.55,
      emissive: new THREE.Color(0x6b7a10),
      emissiveIntensity: 0.45,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(this.r, 24, 16), mat);
    this.mesh.castShadow = true;

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 2;

    this.trailGeo = new THREE.BufferGeometry();
    const verts = new Float32Array(TRAIL_POINTS * 2 * 3);
    const alpha = new Float32Array(TRAIL_POINTS * 2);
    const idx: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    this.trailGeo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
    this.trailGeo.setIndex(idx);
    this.trailMat = new THREE.MeshBasicMaterial({ color: 0xf4ff8a, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
    this.trail = new THREE.Mesh(this.trailGeo, this.trailMat);
    this.trail.frustumCulled = false;

    this.group.add(this.mesh, this.shadow, this.trail);
    scene.add(this.group);
  }

  update(state: BallState, dt: number, camera: THREE.Camera, visible = true): void {
    this.group.visible = visible;
    const p = state.pos;
    this.mesh.position.copy(p);
    // Visual spin, plus a little roll from velocity so a flat ball still looks alive.
    this.mesh.rotation.x += (state.spin.x - state.vel.z * 4) * dt * 0.5;
    this.mesh.rotation.z += (state.spin.z + state.vel.x * 4) * dt * 0.5;

    const h = Math.max(0, p.y - BALL.RADIUS);
    const s = this.r * 2.6 * (1 + h * 0.35);
    this.shadow.scale.set(s, s, 1);
    this.shadow.position.set(p.x, 0.008, p.z);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.25, 0.9 - h * 0.18);

    this.updateTrail(state, camera);
  }

  private updateTrail(state: BallState, camera: THREE.Camera): void {
    const speed = state.vel.length();
    this.trailPos.unshift(state.pos.clone());
    if (this.trailPos.length > TRAIL_POINTS) this.trailPos.length = TRAIL_POINTS;
    const show = speed > 9 && this.trailPos.length > 2;
    this.trail.visible = show;
    if (!show) return;
    this.trailMat.opacity = Math.min(0.55, (speed - 9) / 12);
    const pos = this.trailGeo.attributes.position as THREE.BufferAttribute;
    const camPos = camera.position;
    const side = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const p = this.trailPos[Math.min(i, this.trailPos.length - 1)];
      const q = this.trailPos[Math.min(i + 1, this.trailPos.length - 1)];
      dir.subVectors(p, q);
      if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
      toCam.subVectors(camPos, p);
      side.crossVectors(dir, toCam).normalize();
      const w = this.r * 0.9 * (1 - i / TRAIL_POINTS);
      pos.setXYZ(i * 2, p.x + side.x * w, p.y + side.y * w, p.z + side.z * w);
      pos.setXYZ(i * 2 + 1, p.x - side.x * w, p.y - side.y * w, p.z - side.z * w);
    }
    pos.needsUpdate = true;
  }

  resetTrail(): void {
    this.trailPos.length = 0;
    this.trail.visible = false;
  }
}
