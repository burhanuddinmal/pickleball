import * as THREE from 'three';
import { COURT } from '../utils/Constants';
import { courtTexture } from '../render/Textures';

export interface CourtTheme {
  surround: string;
  court: string;
  kitchen: string;
  line: string;
}

export const DEFAULT_COURT_THEME: CourtTheme = {
  surround: '#2f7a55',
  court: '#2a63b8',
  kitchen: '#3f8ee0',
  line: '#ffffff',
};

/**
 * Builds the playing surface and all line markings at true USAP dimensions.
 * Lines are part of the court: their outer edges sit on the 20' x 44' boundary,
 * and the non-volley line is included in the 7' kitchen.
 */
export function buildCourt(theme: CourtTheme = DEFAULT_COURT_THEME): THREE.Group {
  const g = new THREE.Group();
  g.name = 'court';
  const W = COURT.WIDTH;
  const L = COURT.LENGTH;
  const HL = COURT.HALF_LENGTH;
  const HW = COURT.HALF_WIDTH;
  const K = COURT.KITCHEN_DEPTH;
  const lw = COURT.LINE_WIDTH;

  const surroundTex = courtTexture(theme.surround, '#000000');
  surroundTex.repeat.set(8, 12);
  const surround = new THREE.Mesh(
    new THREE.PlaneGeometry(W + 6.5, L + 9),
    new THREE.MeshStandardMaterial({ map: surroundTex, roughness: 0.92 }),
  );
  surround.rotation.x = -Math.PI / 2;
  surround.receiveShadow = true;
  g.add(surround);

  const courtTex = courtTexture(theme.court, '#ffffff');
  courtTex.repeat.set(4, 8);
  const courtMat = new THREE.MeshStandardMaterial({ map: courtTex, roughness: 0.85 });
  const playing = new THREE.Mesh(new THREE.PlaneGeometry(W, L), courtMat);
  playing.rotation.x = -Math.PI / 2;
  playing.position.y = 0.002;
  playing.receiveShadow = true;
  g.add(playing);

  const kitchenMat = new THREE.MeshStandardMaterial({ color: theme.kitchen, roughness: 0.85 });
  for (const s of [1, -1]) {
    const k = new THREE.Mesh(new THREE.PlaneGeometry(W, K), kitchenMat);
    k.rotation.x = -Math.PI / 2;
    k.position.set(0, 0.003, (s * K) / 2);
    k.receiveShadow = true;
    g.add(k);
  }

  const lineMat = new THREE.MeshStandardMaterial({ color: theme.line, roughness: 0.6 });
  const line = (w: number, l: number, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), lineMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.005, z);
    m.receiveShadow = true;
    g.add(m);
  };
  // Sidelines and baselines.
  line(lw, L, HW - lw / 2, 0);
  line(lw, L, -HW + lw / 2, 0);
  line(W, lw, 0, HL - lw / 2);
  line(W, lw, 0, -HL + lw / 2);
  for (const s of [1, -1]) {
    // Non-volley (kitchen) line, inside the 7' zone.
    line(W, lw, 0, s * (K - lw / 2));
    // Centerline from the kitchen line to the baseline.
    const len = HL - K;
    line(lw, len, 0, s * (K + len / 2));
  }
  return g;
}
