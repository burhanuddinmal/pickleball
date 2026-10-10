import * as THREE from 'three';
import { COURT } from '../utils/Constants';
import { cloudTexture, fenceTexture, skyTexture } from '../render/Textures';
import type { GraphicsQuality } from '../render/SceneManager';
import { Crowd, CROWD_LAYOUT_DEFAULTS, layoutCrowdSeats, rowCenterX } from './Crowd';

export interface EnvironmentTheme {
  name: string;
  skyTop: string;
  skyHorizon: string;
  ground: string;
  fog: string;
  stands: string;
}

export const OUTDOOR_THEME: EnvironmentTheme = {
  name: 'Sunset Park',
  skyTop: '#3d8fe0',
  skyHorizon: '#cfe9ff',
  ground: '#4f8a3c',
  fog: '#cfe4f5',
  stands: '#39424e',
};

/** Slow background motion (drifting clouds, swaying tree tops); null on low quality. */
export class Ambient {
  private readonly uniforms = { uTime: { value: 0 } };
  private readonly clouds: THREE.Sprite[] = [];
  /** Cloud drift speed (m/s along x) and wrap half-width. */
  private static readonly DRIFT = 0.9;
  private static readonly SPAN = 130;

  constructor(group: THREE.Group, treeMat: THREE.MeshStandardMaterial) {
    treeMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            // Sway grows toward the tip (cone spans y -3.5..3.5); phase from the instance position.
            float ph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
            float w = (position.y + 3.5) / 7.0;
            w *= w;
            transformed.x += sin(uTime * 1.1 + ph) * 0.22 * w;
            transformed.z += sin(uTime * 0.8 + ph * 1.7) * 0.12 * w;
          #endif`,
        );
    };
    treeMat.customProgramCacheKey = () => 'trees-sway';

    const tex = cloudTexture();
    for (let i = 0; i < 9; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, opacity: 0.7 + Math.random() * 0.25 });
      const cloud = new THREE.Sprite(mat);
      const a = (i / 9) * Math.PI * 2 + Math.random() * 0.4;
      const d = 95 + Math.random() * 25;
      const w = 26 + Math.random() * 22;
      cloud.scale.set(w, w * 0.45, 1);
      cloud.position.set(Math.cos(a) * d, 16 + Math.random() * 14, Math.sin(a) * d);
      group.add(cloud);
      this.clouds.push(cloud);
    }
  }

  update(dt: number): void {
    this.uniforms.uTime.value += dt;
    for (const c of this.clouds) {
      c.position.x += Ambient.DRIFT * dt;
      if (c.position.x > Ambient.SPAN) c.position.x -= Ambient.SPAN * 2;
    }
  }
}

/**
 * Procedural venue around the court: sky, ground, fence, bleachers with a lightweight
 * instanced crowd, and light towers. Purely visual; nothing here affects gameplay.
 * Returns the crowd and ambient motion (both null on low quality) so the game loop can animate them.
 */
export function buildEnvironment(
  scene: THREE.Scene,
  theme: EnvironmentTheme,
  quality: GraphicsQuality,
): { group: THREE.Group; crowd: Crowd | null; ambient: Ambient | null } {
  const g = new THREE.Group();
  g.name = 'environment';
  scene.background = skyTexture(theme.skyTop, theme.skyHorizon);
  scene.fog = new THREE.Fog(theme.fog, 45, 140);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: theme.ground, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  g.add(ground);

  // Fence enclosing the court area.
  const fx = COURT.HALF_WIDTH + 3.6;
  const fz = COURT.HALF_LENGTH + 5;
  const fh = 3;
  const tex = fenceTexture();
  const fenceMat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.8 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x2a3138, metalness: 0.5, roughness: 0.5 });
  const fence = (len: number, x: number, z: number, rotY: number) => {
    const t = tex.clone();
    t.repeat.set(len / 0.18, fh / 0.18);
    t.needsUpdate = true;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, fh), fenceMat.clone());
    (m.material as THREE.MeshStandardMaterial).map = t;
    m.position.set(x, fh / 2, z);
    m.rotation.y = rotY;
    g.add(m);
    const n = Math.round(len / 3);
    for (let i = 0; i <= n; i++) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, fh, 6), postMat);
      const o = -len / 2 + (len * i) / n;
      p.position.set(x + Math.cos(rotY) * o, fh / 2, z - Math.sin(rotY) * o);
      g.add(p);
    }
  };
  fence(fx * 2, 0, -fz, 0);
  fence(fz * 2, -fx, 0, Math.PI / 2);
  fence(fz * 2, fx, 0, Math.PI / 2);
  // Low wall behind the near baseline so the camera can see over it.
  const wall = new THREE.Mesh(new THREE.BoxGeometry(fx * 2, 0.9, 0.15), new THREE.MeshStandardMaterial({ color: 0x1f5c8a, roughness: 0.7 }));
  wall.position.set(0, 0.45, fz);
  g.add(wall);

  // Bleachers along both sidelines with an instanced low-poly crowd seated on a non-overlapping grid.
  const standMat = new THREE.MeshStandardMaterial({ color: theme.stands, roughness: 0.8 });
  const { rows, rowDepth, rowRise } = CROWD_LAYOUT_DEFAULTS;
  for (const s of [1, -1]) {
    for (let r = 0; r < rows; r++) {
      const h = rowRise * (1 + r * 2);
      const step = new THREE.Mesh(new THREE.BoxGeometry(rowDepth, h, fz * 1.6), standMat);
      step.position.set(rowCenterX(fx, s, r, rowDepth), h / 2, 0);
      step.receiveShadow = true;
      g.add(step);
    }
  }
  const occupancy = quality === 'low' ? 0 : quality === 'medium' ? 0.55 : 0.9;
  let crowd: Crowd | null = null;
  if (occupancy > 0) {
    crowd = new Crowd(layoutCrowdSeats({ ...CROWD_LAYOUT_DEFAULTS, fx, fz, occupancy }));
    g.add(crowd.mesh);
  }

  // Light towers at the corners.
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.4 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6d8, emissiveIntensity: quality === 'low' ? 1.2 : 2.4 });
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 11, 8), towerMat);
      pole.position.set(sx * (fx + 7), 5.5, sz * (fz - 2));
      g.add(pole);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.3), lampMat);
      lamp.position.set(sx * (fx + 7), 11, sz * (fz - 2));
      lamp.lookAt(0, 0, 0);
      g.add(lamp);
    }
  }

  // Distant tree line for depth.
  const treeMat = new THREE.MeshStandardMaterial({ color: 0x2f6b3a, roughness: 1 });
  const mtx = new THREE.Matrix4();
  const trees = new THREE.InstancedMesh(new THREE.ConeGeometry(2.2, 7, 7), treeMat, 60);
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const d = 55 + Math.random() * 15;
    const sc = 0.8 + Math.random() * 0.8;
    mtx.compose(new THREE.Vector3(Math.cos(a) * d, 3.5 * sc, Math.sin(a) * d), new THREE.Quaternion(), new THREE.Vector3(sc, sc, sc));
    trees.setMatrixAt(i, mtx);
  }
  g.add(trees);
  const ambient = quality === 'low' ? null : new Ambient(g, treeMat);

  scene.add(g);
  return { group: g, crowd, ambient };
}
