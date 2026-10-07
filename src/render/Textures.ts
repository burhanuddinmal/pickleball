import * as THREE from 'three';

/**
 * Procedural textures. Generated at startup so the game ships with zero image downloads;
 * any of these can be swapped for authored assets via AssetConfig later.
 */
function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function toTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Perforated pickleball: bright yellow-green with a ring pattern of holes. */
export function ballTexture(): THREE.Texture {
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#e4f53a';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#5a6b12';
  const rows = [18, 42, 64, 86, 110];
  rows.forEach((y, r) => {
    const count = r === 2 ? 10 : r === 0 || r === 4 ? 5 : 8;
    for (let i = 0; i < count; i++) {
      const x = ((i + (r % 2) * 0.5) / count) * 256;
      const rad = r === 0 || r === 4 ? 5 : 6.5;
      g.beginPath();
      g.ellipse(x, y, rad * (r === 0 || r === 4 ? 2.2 : 1), rad, 0, 0, Math.PI * 2);
      g.fill();
    }
  });
  return toTexture(c);
}

/** Soft radial blob used for ball and player contact shadows. */
export function blobTexture(): THREE.Texture {
  const [c, g] = canvas(64, 64);
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.85)');
  grd.addColorStop(0.5, 'rgba(0,0,0,0.45)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return toTexture(c, false);
}

/** Ring with soft edge for target / landing markers. */
export function ringTexture(): THREE.Texture {
  const [c, g] = canvas(128, 128);
  g.strokeStyle = 'white';
  g.lineWidth = 10;
  g.beginPath();
  g.arc(64, 64, 52, 0, Math.PI * 2);
  g.stroke();
  g.globalAlpha = 0.35;
  g.beginPath();
  g.arc(64, 64, 30, 0, Math.PI * 2);
  g.fill();
  return toTexture(c, false);
}

/** Net mesh pattern (tiling). */
export function netTexture(): THREE.Texture {
  const [c, g] = canvas(64, 64);
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(25,25,30,0.95)';
  g.lineWidth = 3;
  g.strokeRect(0, 0, 64, 64);
  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Subtle acrylic court grain. */
export function courtTexture(base: string, speck: string): THREE.Texture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = speck;
  for (let i = 0; i < 2200; i++) {
    g.globalAlpha = Math.random() * 0.12;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
  }
  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Vertical sky gradient used as the scene background. */
export function skyTexture(top: string, horizon: string): THREE.Texture {
  const [c, g] = canvas(4, 256);
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, top);
  grd.addColorStop(0.62, horizon);
  grd.addColorStop(1, horizon);
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 256);
  return toTexture(c);
}

/** Chain-link fence pattern. */
export function fenceTexture(): THREE.Texture {
  const [c, g] = canvas(64, 64);
  g.strokeStyle = 'rgba(40,52,60,0.8)';
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(64, 64);
  g.moveTo(64, 0);
  g.lineTo(0, 64);
  g.stroke();
  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
