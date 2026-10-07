import * as THREE from 'three';
import { COURT } from '../utils/Constants';
import { fenceTexture, skyTexture } from '../render/Textures';
import type { GraphicsQuality } from '../render/SceneManager';

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

/**
 * Procedural venue around the court: sky, ground, fence, bleachers with a lightweight
 * instanced crowd, and light towers. Purely visual; nothing here affects gameplay.
 */
export function buildEnvironment(scene: THREE.Scene, theme: EnvironmentTheme, quality: GraphicsQuality): THREE.Group {
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

  // Bleachers along both sidelines with an instanced crowd.
  const standMat = new THREE.MeshStandardMaterial({ color: theme.stands, roughness: 0.8 });
  const rows = 5;
  const crowdCount = quality === 'low' ? 0 : quality === 'medium' ? 220 : 420;
  const crowd = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.2, 0.35, 2, 6), new THREE.MeshStandardMaterial({ roughness: 0.9 }), crowdCount * 2);
  const palette = [0xe85d4a, 0xf2c14e, 0x4fb3bf, 0xffffff, 0x7a5cff, 0x2e2e38, 0x5cc96b, 0xff8fb1].map((c) => new THREE.Color(c));
  const mtx = new THREE.Matrix4();
  let idx = 0;
  for (const s of [1, -1]) {
    for (let r = 0; r < rows; r++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.45, fz * 1.6), standMat);
      step.position.set(s * (fx + 1.2 + r * 1.1), 0.225 + r * 0.45, 0);
      step.scale.y = 1 + r * 2;
      step.position.y = (0.45 * (1 + r * 2)) / 2;
      step.receiveShadow = true;
      g.add(step);
    }
    for (let i = 0; i < crowdCount; i++) {
      const r = Math.floor(Math.random() * rows);
      const x = s * (fx + 1.2 + r * 1.1 + (Math.random() - 0.5) * 0.3);
      const z = (Math.random() - 0.5) * fz * 1.5;
      mtx.makeTranslation(x, 0.45 * (1 + r * 2) + 0.38, z);
      crowd.setMatrixAt(idx, mtx);
      crowd.setColorAt(idx, palette[Math.floor(Math.random() * palette.length)]);
      idx++;
    }
  }
  crowd.count = idx;
  if (idx > 0) g.add(crowd);

  // Light towers at the corners.
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.4 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6d8, emissiveIntensity: 1.2 });
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
  const trees = new THREE.InstancedMesh(new THREE.ConeGeometry(2.2, 7, 7), treeMat, 60);
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const d = 55 + Math.random() * 15;
    const sc = 0.8 + Math.random() * 0.8;
    mtx.compose(new THREE.Vector3(Math.cos(a) * d, 3.5 * sc, Math.sin(a) * d), new THREE.Quaternion(), new THREE.Vector3(sc, sc, sc));
    trees.setMatrixAt(i, mtx);
  }
  g.add(trees);

  scene.add(g);
  return g;
}
