import { Vector3 } from 'three';
import { BALL, PHYSICS } from '../utils/Constants';
import { collideGround, collideNet } from './CollisionSystem';

export interface BallState {
  pos: Vector3;
  vel: Vector3;
  /** Angular velocity (rad/s). */
  spin: Vector3;
  /** True once the ball has stopped bouncing and is rolling along the court. */
  rolling: boolean;
  atRest: boolean;
  /** Total bounces since the state was last launched (diagnostic only). */
  bounceCount: number;
}

export type BallEvent =
  | { type: 'bounce'; pos: Vector3; speed: number }
  | { type: 'net'; pos: Vector3; tape: boolean }
  | { type: 'rest'; pos: Vector3 };

export interface StepOptions {
  /** Disable net collisions (used by the shot solver to find the free trajectory). */
  ignoreNet?: boolean;
}

export function createBallState(pos = new Vector3(0, 1, 0)): BallState {
  return { pos: pos.clone(), vel: new Vector3(), spin: new Vector3(), rolling: false, atRest: false, bounceCount: 0 };
}

export function copyBallState(src: BallState, dst: BallState = createBallState()): BallState {
  dst.pos.copy(src.pos);
  dst.vel.copy(src.vel);
  dst.spin.copy(src.spin);
  dst.rolling = src.rolling;
  dst.atRest = src.atRest;
  dst.bounceCount = src.bounceCount;
  return dst;
}

const prev = new Vector3();

/**
 * Advances the ball by exactly one fixed substep (PHYSICS.FIXED_DT).
 * Pure function over BallState so live simulation and prediction are bit-identical.
 */
export function stepBall(s: BallState, out?: BallEvent[], opts?: StepOptions): void {
  if (s.atRest) return;
  const dt = PHYSICS.FIXED_DT;
  const v = s.vel;
  const w = s.spin;

  if (s.rolling) {
    const k = Math.max(0, 1 - PHYSICS.ROLL_FRICTION * dt);
    v.x *= k;
    v.z *= k;
    v.y = 0;
    w.multiplyScalar(k);
  } else {
    const speed = v.length();
    const drag = PHYSICS.DRAG * speed;
    const m = PHYSICS.MAGNUS;
    // Magnus: omega x v
    const mx = w.y * v.z - w.z * v.y;
    const my = w.z * v.x - w.x * v.z;
    const mz = w.x * v.y - w.y * v.x;
    v.x += (-drag * v.x + m * mx) * dt;
    v.y += (-PHYSICS.GRAVITY - drag * v.y + m * my) * dt;
    v.z += (-drag * v.z + m * mz) * dt;
    w.multiplyScalar(1 - PHYSICS.SPIN_DECAY_AIR * dt);
  }

  prev.copy(s.pos);
  s.pos.addScaledVector(v, dt);

  if (!opts?.ignoreNet) collideNet(s, prev, out);
  collideGround(s, out);

  if (s.rolling && s.pos.y <= BALL.RADIUS + 1e-6 && Math.hypot(v.x, v.z) < PHYSICS.REST_SPEED) {
    v.set(0, 0, 0);
    s.atRest = true;
    out?.push({ type: 'rest', pos: s.pos.clone() });
  }
}

/** Starts a new flight from a paddle contact. */
export function launchBall(s: BallState, pos: Vector3, vel: Vector3, spin: Vector3): void {
  s.pos.copy(pos);
  s.vel.copy(vel);
  if (s.vel.length() > PHYSICS.MAX_SPEED) s.vel.setLength(PHYSICS.MAX_SPEED);
  s.spin.copy(spin);
  s.rolling = false;
  s.atRest = false;
  s.bounceCount = 0;
}

/** Live ball wrapper: owns state and collects events for gameplay systems. */
export class BallPhysics {
  readonly state: BallState = createBallState();
  /** When false the ball is held (e.g. by the server) and not simulated. */
  live = false;
  private events: BallEvent[] = [];

  /** Runs `substeps` fixed substeps and returns events generated during them. */
  advance(substeps: number): BallEvent[] {
    this.events.length = 0;
    if (!this.live) return this.events;
    for (let i = 0; i < substeps; i++) stepBall(this.state, this.events);
    return this.events;
  }

  hold(pos: Vector3): void {
    this.live = false;
    this.state.pos.copy(pos);
    this.state.vel.set(0, 0, 0);
    this.state.spin.set(0, 0, 0);
    this.state.rolling = false;
    this.state.atRest = false;
  }

  launch(pos: Vector3, vel: Vector3, spin: Vector3): void {
    launchBall(this.state, pos, vel, spin);
    this.live = true;
  }
}
