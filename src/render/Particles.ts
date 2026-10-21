import * as THREE from 'three';

export interface ParticleSpec {
  /** Spawn position (copied). */
  pos: THREE.Vector3;
  /** Initial velocity in m/s (copied); defaults to zero. */
  vel?: THREE.Vector3;
  /** Lifetime in seconds. */
  life: number;
  /** World-space diameter in meters at birth. */
  size: number;
  /** Size multiplier reached at the end of life (1 = constant). */
  grow?: number;
  color: THREE.ColorRepresentation;
  /** Opacity at birth; fades linearly to 0. */
  alpha?: number;
  /** Downward acceleration in m/s². */
  gravity?: number;
  /** Linear velocity damping in 1/s. */
  drag?: number;
}

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uScale;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.001, -mv.z);
    // Pull the sprite toward the camera by its radius (same screen position) so the court and
    // other nearby surfaces don't slice the flat quad.
    mv.xyz *= max(0.0, 1.0 - 0.5 * aSize / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */ `
  uniform float uSoftness;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = vAlpha * (1.0 - smoothstep(1.0 - uSoftness, 1.0, d));
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor, a);
    #include <colorspace_fragment>
  }`;

/**
 * Fixed-size pool of camera-facing round particles drawn as one `THREE.Points` call.
 * Simulation is a simple CPU integrator; when the pool is full the oldest particle is reused.
 */
export class Particles {
  readonly points: THREE.Points;
  private readonly n: number;
  private next = 0;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private readonly grow: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly aPos: THREE.BufferAttribute;
  private readonly aColor: THREE.BufferAttribute;
  private readonly aSize: THREE.BufferAttribute;
  private readonly aAlpha: THREE.BufferAttribute;
  private readonly uniforms = { uScale: { value: 1 }, uSoftness: { value: 0.6 } };
  private readonly color = new THREE.Color();

  constructor(count: number, blending: THREE.Blending, softness = 0.6) {
    this.n = count;
    this.vel = new Float32Array(count * 3);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.size0 = new Float32Array(count);
    this.grow = new Float32Array(count);
    this.alpha0 = new Float32Array(count);
    this.gravity = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.uniforms.uSoftness.value = softness;

    const geo = new THREE.BufferGeometry();
    const attr = (itemSize: number) => new THREE.BufferAttribute(new Float32Array(count * itemSize), itemSize).setUsage(THREE.DynamicDrawUsage);
    this.aPos = attr(3);
    this.aColor = attr(3);
    this.aSize = attr(1);
    this.aAlpha = attr(1);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aAlpha', this.aAlpha);

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  emit(p: ParticleSpec): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.aPos.setXYZ(i, p.pos.x, p.pos.y, p.pos.z);
    this.vel[i * 3] = p.vel?.x ?? 0;
    this.vel[i * 3 + 1] = p.vel?.y ?? 0;
    this.vel[i * 3 + 2] = p.vel?.z ?? 0;
    this.color.set(p.color);
    this.aColor.setXYZ(i, this.color.r, this.color.g, this.color.b);
    this.aColor.needsUpdate = true;
    this.age[i] = 0;
    this.life[i] = Math.max(0.01, p.life);
    this.size0[i] = p.size;
    this.grow[i] = p.grow ?? 1;
    this.alpha0[i] = p.alpha ?? 1;
    this.gravity[i] = p.gravity ?? 0;
    this.drag[i] = p.drag ?? 0;
    this.aSize.setX(i, p.size);
    this.aAlpha.setX(i, this.alpha0[i]);
  }

  /** `pixelScale` converts world size at 1 m distance into pixels (viewport height / (2·tan(fov/2))). */
  update(dt: number, pixelScale: number): void {
    this.uniforms.uScale.value = pixelScale;
    const pos = this.aPos.array as Float32Array;
    const size = this.aSize.array as Float32Array;
    const alpha = this.aAlpha.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      const k = Math.min(1, this.age[i] / this.life[i]);
      if (k >= 1) {
        alpha[i] = 0;
        size[i] = 0;
        continue;
      }
      const v = i * 3;
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[v] *= damp;
      this.vel[v + 1] = this.vel[v + 1] * damp - this.gravity[i] * dt;
      this.vel[v + 2] *= damp;
      pos[v] += this.vel[v] * dt;
      pos[v + 1] = Math.max(0.01, pos[v + 1] + this.vel[v + 1] * dt);
      pos[v + 2] += this.vel[v + 2] * dt;
      size[i] = this.size0[i] * (1 + (this.grow[i] - 1) * k);
      alpha[i] = this.alpha0[i] * (1 - k);
    }
    this.aPos.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aAlpha.needsUpdate = true;
  }
}
