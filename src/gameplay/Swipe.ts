import { SWIPE } from '../utils/Constants';
import { clamp } from '../utils/MathUtils';

interface Sample {
  x: number;
  y: number;
  t: number;
}

/**
 * Follows one swipe (screen px, time in seconds). The swipe vector runs from the start point; the
 * flick speed only looks at the last SWIPE.SAMPLE_WINDOW, so a slow wind-up ending in a quick
 * flick still counts as fast.
 */
export class SwipeTracker {
  private samples: Sample[] = [];
  private origin: Sample = { x: 0, y: 0, t: 0 };

  start(x: number, y: number, t: number): void {
    this.origin = { x, y, t };
    this.samples = [this.origin];
  }

  move(x: number, y: number, t: number): void {
    const s = this.samples;
    if (s.length && t < s[s.length - 1].t) return;
    s.push({ x, y, t });
    // Keep one sample older than the window so it always spans the full window.
    while (s.length > 2 && t - s[1].t > SWIPE.SAMPLE_WINDOW) s.shift();
  }

  /** Swipe vector (px) from the start point to the latest sample. */
  delta(): { dx: number; dy: number } {
    const last = this.samples[this.samples.length - 1] ?? this.origin;
    return { dx: last.x - this.origin.x, dy: last.y - this.origin.y };
  }

  /**
   * Flick speed (px/s) over the recent window, measured up to `now` so a pointer held still
   * slows down.
   */
  flickSpeed(now?: number): number {
    const s = this.samples;
    if (s.length < 2) return 0;
    const last = s[s.length - 1];
    const end = Math.max(now ?? last.t, last.t);
    if (end - last.t >= SWIPE.SAMPLE_WINDOW) return 0; // held still for the whole window
    let i = s.length - 1;
    while (i > 0 && end - s[i - 1].t <= SWIPE.SAMPLE_WINDOW) i--;
    const first = s[Math.max(0, i - 1)];
    const dt = Math.max(end - first.t, 1 / 240);
    return Math.hypot(last.x - first.x, last.y - first.y) / dt;
  }
}

/** Shot power 0..1 from a flick speed (px/s), normalized to the screen's size (px). */
export function swipePower(pxPerSec: number, screenPx: number): number {
  const speed = pxPerSec / Math.max(screenPx, 1);
  return clamp((speed - SWIPE.SLOW) / (SWIPE.FAST - SWIPE.SLOW), 0, 1);
}

/** Screen size used to normalize swipe speeds. */
export const screenSize = (): number => Math.min(window.innerWidth, window.innerHeight);

/** Player-chosen controls: hold-to-charge power, or power from swipe speed. */
export type ControlStyle = 'charge' | 'swipe';

/** Visual feedback for a swipe (screen px, time in seconds); `power` is the shot's 0..1 power. */
export interface SwipeFx {
  start(x: number, y: number, t: number): void;
  move(x: number, y: number, t: number): void;
  end(x: number, y: number, t: number, power: number): void;
}
