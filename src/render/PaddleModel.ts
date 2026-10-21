import * as THREE from 'three';

export interface PaddleLook {
  face: string;
  edge: string;
  accent: string;
  grip: string;
}

export const STARTER_PADDLE: PaddleLook = { face: '#ff6b35', edge: '#1d1f24', accent: '#ffd23f', grip: '#222222' };
export const RIVAL_PADDLE: PaddleLook = { face: '#7a5cff', edge: '#15161a', accent: '#41e2ba', grip: '#1b1b1b' };

const FACE_W = 0.205;
const FACE_H = 0.27;
const HANDLE = 0.13;
/** Distance from the butt of the handle to the centre of the face (unscaled, along +Y). */
export const PADDLE_FACE_CENTER = HANDLE + FACE_H / 2;

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = 0;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/**
 * Solid-face pickleball paddle (not a strung racket). Origin is at the butt of the handle;
 * the paddle extends along +Y, with its face normal along +Z.
 */
export function buildPaddle(look: PaddleLook): THREE.Group {
  const g = new THREE.Group();
  const faceW = FACE_W;
  const faceH = FACE_H;
  const handle = HANDLE;

  const faceMat = new THREE.MeshStandardMaterial({ color: look.face, roughness: 0.45, metalness: 0.05 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: look.edge, roughness: 0.5 });
  const face = new THREE.Mesh(
    new THREE.ExtrudeGeometry(roundedRect(faceW, faceH, 0.05), { depth: 0.014, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.003, bevelSegments: 2, curveSegments: 6 }),
    [faceMat, edgeMat],
  );
  face.position.set(0, handle, -0.007);
  face.castShadow = true;
  g.add(face);

  // Accent stripe on both faces.
  const stripeMat = new THREE.MeshStandardMaterial({ color: look.accent, roughness: 0.4 });
  for (const z of [0.0115, -0.0115]) {
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(faceW * 0.8, 0.03), stripeMat);
    stripe.position.set(0, handle + faceH * 0.62, z);
    if (z < 0) stripe.rotation.y = Math.PI;
    g.add(stripe);
  }

  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.018, handle + 0.02, 10),
    new THREE.MeshStandardMaterial({ color: look.grip, roughness: 0.9 }),
  );
  grip.position.y = (handle + 0.02) / 2;
  grip.castShadow = true;
  g.add(grip);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.012, 10), edgeMat);
  g.add(cap);
  return g;
}
