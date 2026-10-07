import { COURT, PLAYER } from '../utils/Constants';
import { approach, clamp, dampAngle } from '../utils/MathUtils';
import type { Athlete } from './Athlete';
import type { InputContext, InputProvider, PlayerIntent } from './InputProvider';

/** Allowed movement area in side-relative coordinates (lateral = right of center, depth = from net). */
export interface MoveBounds {
  minLateral: number;
  maxLateral: number;
  minDepth: number;
  maxDepth: number;
}

export const FREE_BOUNDS: MoveBounds = {
  minLateral: -COURT.HALF_WIDTH - PLAYER.SIDE_ROOM,
  maxLateral: COURT.HALF_WIDTH + PLAYER.SIDE_ROOM,
  minDepth: PLAYER.NET_GAP,
  maxDepth: COURT.HALF_LENGTH + PLAYER.BACK_ROOM,
};

const SWING_BUFFER = 0.14;

/**
 * Applies an InputProvider's intent to an Athlete: acceleration-based movement, bounds,
 * facing and swing triggering. Contains no rules and no rendering.
 */
export class PlayerController {
  bounds: MoveBounds = FREE_BOUNDS;
  private swingBuffer = 0;
  private lastIntent: PlayerIntent | null = null;

  constructor(
    readonly athlete: Athlete,
    public input: InputProvider,
  ) {}

  get intent(): PlayerIntent | null {
    return this.lastIntent;
  }

  /** Returns true if a swing started this tick. */
  tick(ctx: InputContext, dt: number): boolean {
    const a = this.athlete;
    this.input.update(ctx, dt);
    const intent = (this.lastIntent = this.input.getIntent());

    // Movement: intent is side-relative; forward (+moveY) is toward the net (-side in z).
    let mx = intent.moveX;
    let my = intent.moveY;
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }
    let maxSpeed = intent.sprint ? PLAYER.SPRINT_SPEED : PLAYER.RUN_SPEED;
    if (a.swing.active) maxSpeed *= 0.55;
    const tx = mx * a.side * maxSpeed;
    const tz = -my * a.side * maxSpeed;
    const rate = mag > 0.05 ? PLAYER.ACCEL : PLAYER.DECEL;
    a.vel.x = approach(a.vel.x, tx, rate * dt);
    a.vel.z = approach(a.vel.z, tz, rate * dt);
    a.pos.x += a.vel.x * dt;
    a.pos.z += a.vel.z * dt;
    this.applyBounds();

    // Facing: toward the net, turned partially toward the ball when it is live.
    let yaw = a.netYaw;
    if (ctx.ballLive) {
      const dx = ctx.ballPos.x - a.pos.x;
      const dz = ctx.ballPos.z - a.pos.z;
      const toBall = Math.atan2(-dx, -dz);
      let d = toBall - yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      yaw += clamp(d, -0.9, 0.9) * 0.6;
    }
    a.facing = dampAngle(a.facing, yaw, 12, dt);

    // Swing with a short input buffer so slightly early presses still register.
    a.updateSwing(dt);
    if (intent.swing) this.swingBuffer = SWING_BUFFER;
    else this.swingBuffer = Math.max(0, this.swingBuffer - dt);
    if (this.swingBuffer > 0) {
      const started = a.holdingBall
        ? a.startSwing('serve', 'forehand')
        : a.startSwing('stroke', a.handFor(ctx.ballPos.x));
      if (started) {
        this.swingBuffer = 0;
        return true;
      }
    }
    return false;
  }

  applyBounds(): void {
    const a = this.athlete;
    const b = this.bounds;
    const lateral = clamp(a.pos.x * a.side, b.minLateral, b.maxLateral);
    const depth = clamp(a.pos.z * a.side, b.minDepth, b.maxDepth);
    if (lateral !== a.pos.x * a.side) a.vel.x = 0;
    if (depth !== a.pos.z * a.side) a.vel.z = 0;
    a.pos.x = lateral * a.side;
    a.pos.z = depth * a.side;
  }

  reset(): void {
    this.swingBuffer = 0;
    this.athlete.vel.set(0, 0, 0);
    this.athlete.resetSwing();
    this.input.reset?.();
  }
}
