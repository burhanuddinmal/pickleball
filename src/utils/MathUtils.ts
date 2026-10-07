import { COURT, type Side } from './Constants';

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Framerate-independent exponential smoothing toward a target. */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));
export const approach = (current: number, target: number, maxDelta: number): number =>
  current < target ? Math.min(current + maxDelta, target) : Math.max(current - maxDelta, target);
export const signOf = (v: number): Side => (v >= 0 ? 1 : -1);

/** Angle-aware smoothing (radians). */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * (1 - Math.exp(-lambda * dt));
}

/**
 * Converts side-relative court coordinates into world coordinates.
 * `lateral` is meters to the right of center as seen by a player standing on `side`
 * facing the net; `depth` is meters from the net into that side's half.
 */
export function sideToWorld(side: Side, lateral: number, depth: number): { x: number; z: number } {
  return { x: lateral * side, z: depth * side };
}

export function worldToSide(side: Side, x: number, z: number): { lateral: number; depth: number } {
  return { lateral: x * side, depth: z * side };
}

/**
 * Converts a normalized aim (aimX in [-1,1] left..right from the hitter's view, depth in [0,1]
 * from net to baseline) into a world-space landing target on the opponent's half.
 */
export function aimToWorld(hitterSide: Side, aimX: number, aimDepth: number): { x: number; z: number } {
  const targetSide = (hitterSide * -1) as Side;
  // The hitter's "right" is the target side's "left", so negate the lateral.
  return sideToWorld(targetSide, -aimX * COURT.HALF_WIDTH, aimDepth * COURT.HALF_LENGTH);
}

/** Small deterministic PRNG (mulberry32) so simulations and tests are reproducible. */
export class Rng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  /** Approximately normal(0,1). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}
