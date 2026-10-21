import { screenSize, swipePower, type SwipeFx } from '../gameplay/Swipe';
import { POWER } from '../utils/Constants';
import { clamp, lerp } from '../utils/MathUtils';

/** Seconds a trail point stays visible. */
const LIFE = 0.28;
const BURST_LIFE = 0.35;

interface Point {
  x: number;
  y: number;
  t: number;
  /** Power 0..1 of the segment ending here, from its own speed. */
  p: number;
}

/** Slow → cyan (the HUD rim), power → amber, full → hot orange (the charge meter's colors). */
const COLD = [150, 235, 255];
const READY = [255, 176, 58];
const HOT = [255, 106, 61];
function color(p: number, a: number): string {
  const [from, to, k] = p < POWER.MIN ? [COLD, READY, p / POWER.MIN] : [READY, HOT, (p - POWER.MIN) / (1 - POWER.MIN)];
  const c = from.map((v, i) => Math.round(lerp(v, to[i], k)));
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/**
 * HUD feedback for swipe-style swings: a fading comet trail behind the finger / mouse whose width
 * and color follow the swipe's speed, and a ring burst at release sized by the shot's power.
 * Purely visual; the input classes push points in through SwipeFx.
 */
export class SwipeTrail implements SwipeFx {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private points: Point[] = [];
  private burst: { x: number; y: number; t: number; p: number } | null = null;
  private raf = 0;
  /** Reduced effects: keep the trail (it is feedback), drop the burst. */
  reduced = false;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'swipe-trail';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  start(x: number, y: number, t: number): void {
    this.points = [{ x, y, t, p: 0 }];
    this.burst = null;
    this.resize();
    this.kick();
  }

  move(x: number, y: number, t: number): void {
    const last = this.points[this.points.length - 1];
    if (!last) return;
    const dt = t - last.t;
    if (dt <= 0) return;
    const speed = Math.hypot(x - last.x, y - last.y) / dt;
    // Smooth the per-segment power a little so jittery event timing doesn't flicker.
    const p = lerp(last.p, swipePower(speed, screenSize()), 0.5);
    this.points.push({ x, y, t, p });
    this.kick();
  }

  end(x: number, y: number, t: number, power: number): void {
    this.move(x, y, t);
    if (!this.reduced && power > 0) this.burst = { x, y, t, p: power };
    this.kick();
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private kick(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.draw);
  }

  private draw = (): void => {
    this.raf = 0;
    const now = performance.now() / 1000;
    const g = this.ctx;
    g.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const pts = this.points;
    while (pts.length > 1 && now - pts[1].t > LIFE) pts.shift();

    g.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const fade = clamp(1 - (now - b.t) / LIFE, 0, 1);
      if (fade <= 0) continue;
      const w = lerp(3, 16, b.p) * (0.35 + 0.65 * fade);
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.strokeStyle = color(b.p, 0.25 * fade); // soft glow under the core
      g.lineWidth = w * 2.4;
      g.stroke();
      g.strokeStyle = color(b.p, 0.9 * fade);
      g.lineWidth = w;
      g.stroke();
    }

    const bu = this.burst;
    if (bu) {
      const k = (now - bu.t) / BURST_LIFE;
      if (k >= 1) this.burst = null;
      else {
        g.beginPath();
        g.arc(bu.x, bu.y, lerp(10, 40 + 50 * bu.p, 1 - (1 - k) * (1 - k)), 0, Math.PI * 2);
        g.strokeStyle = color(bu.p, 1 - k);
        g.lineWidth = lerp(3, 8, bu.p) * (1 - k);
        g.stroke();
      }
    }

    const alive = (pts.length > 1 && now - pts[pts.length - 1].t < LIFE) || this.burst;
    if (alive) this.kick();
    else g.clearRect(0, 0, window.innerWidth, window.innerHeight);
  };
}
