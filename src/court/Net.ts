import * as THREE from 'three';
import { netHeightAt } from '../physics/CollisionSystem';
import { COURT, PHYSICS } from '../utils/Constants';
import { netTexture } from '../render/Textures';

/** Ripple lifetime (s) and peak z-displacement (m) for body and tape hits. */
const RIPPLE_LIFE = 0.5;
const RIPPLE_AMP_BODY = 0.07;
const RIPPLE_AMP_TAPE = 0.035;
/** Tape emissive flash on a net cord. */
const TAPE_FLASH_LIFE = 0.25;

/**
 * Visual net. Its top edge follows netHeightAt() exactly, so what you see is what the ball hits.
 * `onHit()` sends a ripple through the mesh (vertex shader, z only, with the top and bottom
 * edges pinned so the tape height never moves) and flashes the tape on a net cord.
 */
export class NetView {
  readonly root = new THREE.Group();
  /** Tape flash on net cords; off under reduce-effects. */
  flashEnabled = true;
  private readonly uniforms = { uHitX: { value: 0 }, uAmp: { value: 0 }, uTime: { value: 0 } };
  private rippleT = RIPPLE_LIFE;
  private rippleAmp = 0;
  private tapeMat: THREE.MeshStandardMaterial;
  private flashT = TAPE_FLASH_LIFE;

  constructor() {
    const g = this.root;
    g.name = 'net';
    const span = COURT.NET_POST_X * 2;
    const segs = 48;
    const rows = 6;
    const bottom = 0.04;

    // Rows let the ripple bend the body; uv.y (0 bottom, 1 top) pins both edges in the shader.
    const geo = new THREE.PlaneGeometry(span, 1, segs, rows);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const v = pos.getY(i) + 0.5;
      pos.setY(i, bottom + (netHeightAt(x) - bottom) * v);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    const tex = netTexture();
    tex.repeat.set(span / 0.06, 1 / 0.06);
    const netMat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.2, side: THREE.DoubleSide, roughness: 1 });
    // The camera faces the net almost head-on, so z displacement alone barely reads: the wave also
    // lights up the fabric (vRipple) so it shows as a bright sheen running along the net.
    netMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uHitX;\nuniform float uAmp;\nuniform float uTime;\nvarying float vRipple;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float rd = abs(position.x - uHitX);
          float rip = uAmp * sin(3.14159 * uv.y) * exp(-rd * 2.0) * sin(uTime * 30.0 - rd * 8.0);
          transformed.z += rip;
          vRipple = abs(rip) / ${RIPPLE_AMP_BODY.toFixed(3)};`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vRipple;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float sheen = clamp(vRipple * 1.6, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), sheen);
          diffuseColor.a = max(diffuseColor.a, sheen * 0.55);`,
        );
    };
    const mesh = new THREE.Mesh(geo, netMat);
    mesh.castShadow = true;
    g.add(mesh);

    // Tape along the top of the net.
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segs; i++) {
      const x = -COURT.NET_POST_X + (span * i) / segs;
      pts.push(new THREE.Vector3(x, netHeightAt(x), 0));
    }
    // Warm emissive: a pure white flash on white tape is lost after tone mapping.
    this.tapeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, emissive: 0xffd24a, emissiveIntensity: 0 });
    const tape = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), segs, PHYSICS.TAPE_RADIUS * 1.4, 6), this.tapeMat);
    tape.castShadow = true;
    g.add(tape);

    // Center strap.
    const strap = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, COURT.NET_HEIGHT_CENTER - bottom, 0.012),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }),
    );
    strap.position.set(0, bottom + (COURT.NET_HEIGHT_CENTER - bottom) / 2, 0);
    g.add(strap);

    // Posts.
    const postMat = new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.6, roughness: 0.35 });
    const postH = COURT.NET_HEIGHT_SIDELINE + 0.08;
    for (const s of [1, -1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, postH, 12), postMat);
      post.position.set(s * COURT.NET_POST_X, postH / 2, 0);
      post.castShadow = true;
      g.add(post);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.05, 16), postMat);
      base.position.set(s * COURT.NET_POST_X, 0.025, 0);
      g.add(base);
    }
  }

  /** Ball touched the net at lateral position `x`; `tape` for a net cord over the top. */
  onHit(x: number, tape: boolean): void {
    this.uniforms.uHitX.value = x;
    this.rippleAmp = tape ? RIPPLE_AMP_TAPE : RIPPLE_AMP_BODY;
    this.rippleT = 0;
    if (tape && this.flashEnabled) this.flashT = 0;
  }

  update(dt: number): void {
    if (this.rippleT < RIPPLE_LIFE) {
      this.rippleT = Math.min(RIPPLE_LIFE, this.rippleT + dt);
      const k = 1 - this.rippleT / RIPPLE_LIFE;
      this.uniforms.uTime.value = this.rippleT;
      this.uniforms.uAmp.value = this.rippleAmp * k * k;
    }
    if (this.flashT < TAPE_FLASH_LIFE) {
      this.flashT = Math.min(TAPE_FLASH_LIFE, this.flashT + dt);
      const k = 1 - this.flashT / TAPE_FLASH_LIFE;
      this.tapeMat.emissiveIntensity = 3 * k * k;
    }
  }
}
