import * as THREE from 'three';
import { netHeightAt } from '../physics/CollisionSystem';
import { COURT, PHYSICS } from '../utils/Constants';
import { netTexture } from '../render/Textures';

/** Visual net. Its top edge follows netHeightAt() exactly, so what you see is what the ball hits. */
export function buildNet(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'net';
  const span = COURT.NET_POST_X * 2;
  const segs = 48;
  const bottom = 0.04;

  const geo = new THREE.PlaneGeometry(span, 1, segs, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setY(i, pos.getY(i) > 0 ? netHeightAt(x) : bottom);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  const tex = netTexture();
  tex.repeat.set(span / 0.06, 1 / 0.06);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.2, side: THREE.DoubleSide, roughness: 1 }),
  );
  mesh.castShadow = true;
  g.add(mesh);

  // Tape along the top of the net.
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= segs; i++) {
    const x = -COURT.NET_POST_X + (span * i) / segs;
    pts.push(new THREE.Vector3(x, netHeightAt(x), 0));
  }
  const tape = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), segs, PHYSICS.TAPE_RADIUS * 1.4, 6),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }),
  );
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
  return g;
}
