import * as THREE from 'three';

const COLORS = [0xffd23f, 0xff5a4e, 0x30c4a2, 0x7a5cff, 0xffffff, 0x4fb3ff, 0xff8fb1];
const GRAVITY = 5;
/** Air drag (1/s): high, so pieces settle into a slow (~1.7 m/s) fluttering fall. */
const DRAG = 3;

/**
 * Pooled confetti: small coloured quads in one instanced draw call, launched in a burst and
 * fluttering down under heavy drag. CPU-integrated; idle (no per-frame work) once all have landed
 * and faded.
 */
export class Confetti {
  readonly mesh: THREE.InstancedMesh;
  private readonly n: number;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly phase: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private next = 0;
  private alive = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(count: number) {
    this.n = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.rot = new Float32Array(count * 3);
    this.spin = new Float32Array(count * 3);
    this.phase = new Float32Array(count);
    this.age = new Float32Array(count).fill(1);
    this.life = new Float32Array(count).fill(1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.05, 0.085), mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) {
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, this.c.setHex(COLORS[i % COLORS.length]));
    }
    this.mesh.visible = false;
  }

  /** Bursts `count` pieces up and out from around `center` (world, feet level). */
  burst(center: THREE.Vector3, count: number): void {
    for (let k = 0; k < Math.min(count, this.n); k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.n;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.5;
      const out = 1.2 + Math.random() * 2.6;
      const v = i * 3;
      this.pos[v] = center.x + Math.cos(a) * r;
      this.pos[v + 1] = 1.6 + Math.random() * 0.6;
      this.pos[v + 2] = center.z + Math.sin(a) * r;
      this.vel[v] = Math.cos(a) * out;
      this.vel[v + 1] = 4 + Math.random() * 4;
      this.vel[v + 2] = Math.sin(a) * out;
      for (let j = 0; j < 3; j++) {
        this.rot[v + j] = Math.random() * Math.PI * 2;
        this.spin[v + j] = (Math.random() - 0.5) * 14;
      }
      this.phase[i] = Math.random() * Math.PI * 2;
      if (this.age[i] >= this.life[i]) this.alive++;
      this.age[i] = 0;
      this.life[i] = 4.5 + Math.random() * 2;
      this.mesh.setColorAt(i, this.c.setHex(COLORS[Math.floor(Math.random() * COLORS.length)]));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.visible = true;
  }

  update(dt: number): void {
    if (this.alive === 0) return;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      const v = i * 3;
      if (this.age[i] >= this.life[i]) {
        this.alive--;
        this.m.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.m);
        continue;
      }
      const grounded = this.pos[v + 1] <= 0.012;
      if (!grounded) {
        const d = Math.max(0, 1 - DRAG * dt);
        // Flutter: a side-to-side sway that grows as the piece slows into its fall.
        const sway = Math.sin(this.age[i] * 6 + this.phase[i]) * 1.4 * dt;
        this.vel[v] = this.vel[v] * d + sway;
        this.vel[v + 1] = (this.vel[v + 1] - GRAVITY * dt) * d;
        this.vel[v + 2] = this.vel[v + 2] * d + sway * 0.6;
        for (let j = 0; j < 3; j++) {
          this.pos[v + j] += this.vel[v + j] * dt;
          this.rot[v + j] += this.spin[v + j] * dt;
        }
        if (this.pos[v + 1] <= 0.012) {
          // Land flat on the court (XYZ order: in-plane spin from z, then laid down by x).
          this.pos[v + 1] = 0.012;
          this.rot[v] = -Math.PI / 2;
          this.rot[v + 1] = 0;
        }
      }
      const fade = Math.min(1, (this.life[i] - this.age[i]) / 0.6);
      this.p.set(this.pos[v], this.pos[v + 1], this.pos[v + 2]);
      this.q.setFromEuler(this.e.set(this.rot[v], this.rot[v + 1], this.rot[v + 2]));
      this.m.compose(this.p, this.q, this.s.setScalar(fade));
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.alive === 0) this.mesh.visible = false;
  }

  clear(): void {
    this.age.fill(1);
    this.life.fill(1);
    this.alive = 0;
    this.m.makeScale(0, 0, 0);
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = false;
  }
}
