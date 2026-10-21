import * as THREE from 'three';
import type { BallState } from '../physics/BallPhysics';
import { BALL } from '../utils/Constants';
import { clamp } from '../utils/MathUtils';
import { RibbonTrail } from './RibbonTrail';
import { ballTexture, blobTexture } from './Textures';

const TRAIL_POINTS = 14;
const UP = new THREE.Vector3(0, 1, 0);
/** Squash & stretch spring: stiffness and damping (slightly underdamped for a jelly overshoot). */
const SPRING_K = 420;
const SPRING_C = 14;
/** Trail colour ramp by ball speed (m/s). */
const TRAIL_COOL = new THREE.Color(0xf4ff8a);
const TRAIL_WARM = new THREE.Color(0xffa63d);
const TRAIL_HOT = new THREE.Color(0xff4a2e);

/** Ball mesh, ground contact shadow and a short fading trail. Reads BallState only. */
export class BallView {
  readonly group = new THREE.Group();
  /** Parent of the mesh that carries squash & stretch, so the spinning texture is unaffected. */
  private deform = new THREE.Group();
  private mesh: THREE.Mesh;
  private shadow: THREE.Mesh;
  private shadowMat: THREE.MeshBasicMaterial;
  private trail = new RibbonTrail(TRAIL_POINTS);
  private readonly r = BALL.RADIUS * BALL.VISUAL_SCALE;
  /** Deformation along `axis`: > 0 stretches, < 0 squashes. */
  private stretch = 0;
  private stretchVel = 0;
  private axis = new THREE.Vector3(0, 1, 0);
  private readonly color = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshStandardMaterial({
      map: ballTexture(),
      roughness: 0.55,
      emissive: new THREE.Color(0x6b7a10),
      emissiveIntensity: 0.45,
    });
    // Fresnel rim so the ball separates from the court and sky (and catches the bloom on 'high').
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float rim = 1.0 - saturate(dot(normal, normalize(vViewPosition)));
        totalEmissiveRadiance += vec3(1.0, 1.0, 0.75) * pow(rim, 2.5) * 1.6;`,
      );
    };
    mat.customProgramCacheKey = () => 'ball-rim';
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(this.r, 24, 16), mat);
    this.mesh.castShadow = true;
    this.deform.add(this.mesh);

    this.shadowMat = new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false });
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.shadowMat);
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 2;

    this.group.add(this.deform, this.shadow, this.trail.mesh);
    scene.add(this.group);
  }

  /** Paddle contact: stretch along the outgoing direction `vel`, scaled by `intensity` (0..1). */
  onHit(vel: THREE.Vector3, intensity: number): void {
    if (vel.lengthSq() < 1e-6) return;
    this.axis.copy(vel).normalize();
    this.stretch = 0.12 + 0.3 * clamp(intensity, 0, 1);
    this.stretchVel = 0;
  }

  /** Bounce: squash vertically by impact `speed` (m/s). */
  onBounce(speed: number): void {
    if (speed < 1) return;
    this.axis.copy(UP);
    this.stretch = -0.35 * clamp(speed / 8, 0, 1);
    this.stretchVel = 0;
  }

  update(state: BallState, dt: number, camera: THREE.Camera, visible = true): void {
    this.group.visible = visible;
    const p = state.pos;
    this.deform.position.copy(p);
    // Visual spin, plus a little roll from velocity so a flat ball still looks alive.
    this.mesh.rotation.x += (state.spin.x - state.vel.z * 4) * dt * 0.5;
    this.mesh.rotation.z += (state.spin.z + state.vel.x * 4) * dt * 0.5;
    this.updateDeform(dt);

    // Contact shadow: tight and dark near the ground, soft and faint as the ball rises.
    const h = Math.max(0, p.y - BALL.RADIUS);
    const s = this.r * (1.9 + 2.2 * (1 - Math.exp(-h * 0.5)));
    this.shadow.scale.set(s, s, 1);
    this.shadow.position.set(p.x, 0.008, p.z);
    this.shadowMat.opacity = 0.22 + 0.78 * Math.exp(-h * 0.9);

    this.updateTrail(state, camera);
  }

  private updateDeform(dt: number): void {
    // Semi-implicit Euler in small steps so the stiff spring stays stable on long frames.
    let left = dt;
    while (left > 0) {
      const h = Math.min(left, 1 / 120);
      this.stretchVel += (-SPRING_K * this.stretch - SPRING_C * this.stretchVel) * h;
      this.stretch += this.stretchVel * h;
      left -= h;
    }
    if (Math.abs(this.stretch) < 1e-3 && Math.abs(this.stretchVel) < 1e-2) {
      this.stretch = 0;
      this.stretchVel = 0;
    }
    // Volume-preserving: lengthen along the axis, thin out across it.
    const along = Math.max(0.4, 1 + this.stretch);
    const across = 1 / Math.sqrt(along);
    this.deform.quaternion.setFromUnitVectors(UP, this.axis);
    this.deform.scale.set(across, along, across);
  }

  private updateTrail(state: BallState, camera: THREE.Camera): void {
    const speed = state.vel.length();
    this.trail.push(state.pos);
    const show = speed > 9 && this.trail.length > 2;
    this.trail.mesh.visible = show;
    if (!show) return;
    this.color.copy(TRAIL_COOL).lerp(TRAIL_WARM, clamp((speed - 12) / 6, 0, 1));
    this.color.lerp(TRAIL_HOT, clamp((speed - 18) / 5, 0, 1));
    this.trail.build(camera, this.r * 0.9, this.color, Math.min(0.75, (speed - 9) / 10));
  }

  resetTrail(): void {
    this.trail.reset();
  }
}
