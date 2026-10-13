import { Vector3 } from 'three';
import { createBallState } from '../physics/BallPhysics';
import { samplePath } from '../physics/Trajectory';
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

/** Shot parameters locked in when a swing starts (direction-at-hit aiming). */
export interface SwingAim {
  aimX: number;
  aimDepth: number;
  power: number;
}

const SWING_BUFFER = 0.14;

/**
 * Per-axis velocity step: accelerate toward the target, brake harder when reversing, and skid
 * to a stop with no input.
 */
export function stepVelocity(v: number, target: number, hasInput: boolean, dt: number): number {
  let rate: number = PLAYER.DECEL;
  if (hasInput) rate = v * target < 0 || (Math.abs(target) < Math.abs(v) && Math.abs(v) > 0.01) ? PLAYER.TURN_ACCEL : PLAYER.ACCEL;
  return approach(v, target, rate * dt);
}

/**
 * Applies an InputProvider's intent to an Athlete: acceleration-based movement, bounds,
 * facing and swing triggering. Contains no rules and no rendering.
 */
export class PlayerController {
  bounds: MoveBounds = FREE_BOUNDS;
  /** Aim and power captured at the start of the current / last swing. */
  readonly swingAim: SwingAim = { aimX: 0, aimDepth: 0.75, power: 0 };
  private swingBuffer = 0;
  private bufferedPower = 0;
  private lastIntent: PlayerIntent | null = null;
  /** Remaining auto-step displacement (world) and time left to apply it. */
  private readonly step = new Vector3();
  private stepTime = 0;
  private readonly predict = createBallState();

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
    if (a.inContactWindow) maxSpeed *= PLAYER.SWING_SPEED_MUL;
    const tx = mx * a.side * maxSpeed;
    const tz = -my * a.side * maxSpeed;
    const hasInput = mag > 0.05;
    a.vel.x = stepVelocity(a.vel.x, tx, hasInput, dt);
    a.vel.z = stepVelocity(a.vel.z, tz, hasInput, dt);
    a.pos.x += a.vel.x * dt;
    a.pos.z += a.vel.z * dt;
    if (this.stepTime > 0) {
      const k = Math.min(1, dt / this.stepTime);
      a.pos.x += this.step.x * k;
      a.pos.z += this.step.z * k;
      this.step.multiplyScalar(1 - k);
      this.stepTime -= dt;
    }
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
    a.facing = dampAngle(a.facing, yaw, PLAYER.TURN_RATE, dt);

    // Swing with a short input buffer so slightly early presses still register.
    a.updateSwing(dt);
    if (intent.swing) {
      this.swingBuffer = SWING_BUFFER;
      this.bufferedPower = intent.power;
    } else this.swingBuffer = Math.max(0, this.swingBuffer - dt);
    if (this.swingBuffer > 0) {
      const power = this.bufferedPower;
      const started = a.holdingBall
        ? a.startSwing('serve', 'forehand', 0)
        : a.startSwing('stroke', a.handFor(ctx.ballPos.x), power);
      if (started) {
        // Direction-at-hit: the aim held when the swing starts is the one that is played.
        this.swingAim.aimX = intent.aimX;
        this.swingAim.aimDepth = intent.aimDepth;
        this.swingAim.power = a.swing.power;
        this.swingBuffer = 0;
        if (a.swing.kind === 'stroke') this.planAutoStep(ctx);
        return true;
      }
    }
    return false;
  }

  /**
   * Swing assist: if the ball will pass just out of reach during the contact window, step up to
   * AUTO_STEP toward the closest point of its path.
   */
  private planAutoStep(ctx: InputContext): void {
    const a = this.athlete;
    if (!ctx.ballLive || ctx.lastHitterSide === a.side) return;
    const s = this.predict;
    s.pos.copy(ctx.ballPos);
    s.vel.copy(ctx.ballVel);
    s.spin.set(0, 0, 0);
    s.rolling = false;
    s.atRest = false;
    s.bounceCount = 0;
    const path = samplePath(s, PLAYER.CONTACT_WINDOW, 1 / 120, Math.max(0, 2 - ctx.bouncesSinceHit));
    let best = Infinity;
    let bx = 0;
    let bz = 0;
    for (const p of path) {
      if (p.pos.y < PLAYER.REACH_MIN_H || p.pos.y > PLAYER.REACH_MAX_H) continue;
      if (p.pos.z * a.side < 0) continue;
      const d = Math.hypot(p.pos.x - a.pos.x, p.pos.z - a.pos.z);
      if (d < best) {
        best = d;
        bx = p.pos.x;
        bz = p.pos.z;
      }
    }
    if (best <= PLAYER.REACH * 0.95 || best > PLAYER.REACH + PLAYER.AUTO_STEP) return;
    const move = Math.min(PLAYER.AUTO_STEP, best - PLAYER.REACH * 0.85);
    this.step.set(((bx - a.pos.x) / best) * move, 0, ((bz - a.pos.z) / best) * move);
    this.stepTime = PLAYER.AUTO_STEP_TIME;
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
    this.stepTime = 0;
    this.step.set(0, 0, 0);
    this.athlete.vel.set(0, 0, 0);
    this.athlete.resetSwing();
    this.input.reset?.();
  }
}
