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

/**
 * Bold italic text on a transparent background (line-call labels). Returned texture has
 * `userData.aspect` = width / height so callers can size the quad without distortion.
 */
export function labelTexture(text: string, color: string): THREE.Texture {
  const h = 128;
  const font = `italic 900 ${h * 0.72}px 'Segoe UI', system-ui, Arial, sans-serif`;
  const [, probe] = canvas(1, 1);
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width + h * 0.5);
  const [c, g] = canvas(w, h);
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = h * 0.12;
  g.strokeStyle = 'rgba(10,16,28,0.85)';
  g.strokeText(text, w / 2, h * 0.54);
  g.fillStyle = color;
  g.fillText(text, w / 2, h * 0.54);
  const t = toTexture(c);
  t.userData.aspect = w / h;
  return t;
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

/** Soft puffy cloud on transparent: overlapping radial blobs, flatter at the base. */
export function cloudTexture(): THREE.Texture {
  const [c, g] = canvas(256, 128);
  const puffs = [
    [70, 80, 42],
    [120, 62, 52],
    [175, 76, 40],
    [100, 88, 34],
    [150, 90, 36],
    [205, 92, 26],
    [45, 94, 24],
  ];
  for (const [x, y, r] of puffs) {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.75)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return toTexture(c);
}
