/**
 * Presentation time-scale controller: brief impact freezes ("hit-stop") and longer slow motion
 * for key moments. Converts real frame time into simulation time; while an effect is pending,
 * time runs slower until its real-time budget is consumed. When both overlap, the slower one wins.
 * Purely presentational: the simulation still advances in fixed ticks, just fewer of them.
 */
export class HitStop {
  enabled = true;
  private remaining = 0;
  private slowLeft = 0;
  private slowFactor = 1;

  constructor(private readonly stopScale = 0.04) {}

  /** Starts (or extends) a stop of `seconds` of real time. */
  trigger(seconds: number): void {
    if (this.enabled && seconds > 0) this.remaining = Math.max(this.remaining, seconds);
  }

  /** Runs time at `scale` (0..1) for `seconds` of real time; replaces any pending slow motion. */
  slowMo(seconds: number, scale: number): void {
    if (!this.enabled || seconds <= 0) return;
    this.slowLeft = seconds;
    this.slowFactor = Math.min(1, Math.max(0, scale));
  }

  /** True during a hit-stop (not slow motion). */
  get active(): boolean {
    return this.remaining > 0;
  }

  get slowActive(): boolean {
    return this.slowLeft > 0;
  }

  /** Real frame time → simulation time, consuming pending effects piecewise. */
  scale(dt: number): number {
    let out = 0;
    let left = dt;
    while (left > 0) {
      const stop = this.remaining > 0;
      const slow = this.slowLeft > 0;
      if (!stop && !slow) return out + left;
      const seg = Math.min(left, stop ? this.remaining : left, slow ? this.slowLeft : left);
      out += seg * Math.min(stop ? this.stopScale : 1, slow ? this.slowFactor : 1);
      if (stop) this.remaining -= seg;
      if (slow) this.slowLeft -= seg;
      left -= seg;
    }
    return out;
  }

  clear(): void {
    this.remaining = 0;
    this.slowLeft = 0;
  }
}
