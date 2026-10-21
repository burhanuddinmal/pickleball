import * as THREE from 'three';

/**
 * Camera-facing ribbon through the last N pushed points (newest first). Tapers in width and
 * fades in alpha (RGBA vertex colours) toward the tail. Used for the ball trail and the paddle
 * swoosh. No per-frame allocations once the point buffer is full.
 */
export class RibbonTrail {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  private readonly pts: THREE.Vector3[] = [];
  private readonly geo = new THREE.BufferGeometry();
  private readonly side = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly toCam = new THREE.Vector3();

  constructor(
    private readonly count: number,
    blending: THREE.Blending = THREE.NormalBlending,
  ) {
    const verts = new Float32Array(count * 2 * 3);
    const colors = new Float32Array(count * 2 * 4);
    const idx: number[] = [];
    for (let i = 0; i < count - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(colors, 4));
    this.geo.setIndex(idx);
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Number of points currently recorded. */
  get length(): number {
    return this.pts.length;
  }

  /** Adds a new head point (copied), recycling the oldest once full. */
  push(p: THREE.Vector3): void {
    const head = this.pts.length >= this.count ? this.pts.pop()! : new THREE.Vector3();
    this.pts.unshift(head.copy(p));
  }

  reset(): void {
    this.pts.length = 0;
    this.mesh.visible = false;
  }

  /** Rebuilds the ribbon facing `camera`: `width` (m) at the head, tapering to 0 at the tail. */
  build(camera: THREE.Camera, width: number, color: THREE.Color, opacity: number): void {
    this.material.opacity = opacity;
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const col = this.geo.attributes.color as THREE.BufferAttribute;
    const camPos = camera.position;
    const { side, dir, toCam, pts, count } = this;
    const last = pts.length - 1;
    for (let i = 0; i < count; i++) {
      const p = pts[Math.min(i, last)];
      const q = pts[Math.min(i + 1, last)];
      dir.subVectors(p, q);
      if (dir.lengthSq() < 1e-8) dir.set(0, 0, 1);
      toCam.subVectors(camPos, p);
      side.crossVectors(dir, toCam).normalize();
      const w = width * (1 - i / count);
      pos.setXYZ(i * 2, p.x + side.x * w, p.y + side.y * w, p.z + side.z * w);
      pos.setXYZ(i * 2 + 1, p.x - side.x * w, p.y - side.y * w, p.z - side.z * w);
      const a = Math.pow(1 - i / (count - 1), 1.4);
      col.setXYZW(i * 2, color.r, color.g, color.b, a);
      col.setXYZW(i * 2 + 1, color.r, color.g, color.b, a);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }
}
