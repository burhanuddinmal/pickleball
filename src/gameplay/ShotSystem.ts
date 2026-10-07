import { Vector3 } from 'three';
import { createBallState, launchBall, stepBall } from '../physics/BallPhysics';
import { netHeightAt } from '../physics/CollisionSystem';
import { BALL, COURT, PHYSICS, type Side } from '../utils/Constants';
import { aimToWorld, clamp, type Rng } from '../utils/MathUtils';

export interface ShotRequest {
  from: Vector3;
  /** Desired landing point on the court (y ignored). */
  target: Vector3;
  /** Initial guess of flight time to the landing point; larger = higher arc. */
  flightTime: number;
  spin?: Vector3;
  /** Minimum gap between the bottom of the ball and the net tape. */
  minNetClearance?: number;
  maxSpeed?: number;
}

export interface ShotSolution {
  velocity: Vector3;
  spin: Vector3;
  landing: Vector3;
  flightTime: number;
  /** Bottom-of-ball clearance over the net (negative = would hit net; Infinity = doesn't cross). */
  netClearance: number;
  apex: number;
  converged: boolean;
}

const sim = createBallState();

interface FlightResult {
  landing: Vector3;
  time: number;
  netClearance: number;
  apex: number;
}

/** Flies the ball with net collisions disabled to measure the free trajectory. */
function fly(from: Vector3, vel: Vector3, spin: Vector3): FlightResult {
  launchBall(sim, from, vel, spin);
  let clearance = Infinity;
  let apex = from.y;
  let prevZ = from.z;
  let prevY = from.y;
  let prevX = from.x;
  const maxSteps = Math.ceil(6 / PHYSICS.FIXED_DT);
  for (let i = 1; i <= maxSteps; i++) {
    stepBall(sim, undefined, { ignoreNet: true });
    const p = sim.pos;
    if (p.y > apex) apex = p.y;
    if ((prevZ > 0) !== (p.z > 0)) {
      const t = prevZ / (prevZ - p.z);
      const xc = prevX + (p.x - prevX) * t;
      const yc = prevY + (p.y - prevY) * t;
      clearance = Math.min(clearance, yc - BALL.RADIUS - netHeightAt(xc));
    }
    if (sim.bounceCount > 0 || sim.rolling) {
      return { landing: p.clone(), time: i * PHYSICS.FIXED_DT, netClearance: clearance, apex };
    }
    prevX = p.x;
    prevY = p.y;
    prevZ = p.z;
  }
  return { landing: sim.pos.clone(), time: 6, netClearance: clearance, apex };
}

/**
 * Finds a launch velocity that lands the ball on `target` with roughly the requested flight time,
 * accounting for drag and spin by iterating on the real simulation.
 */
export function solveShot(req: ShotRequest): ShotSolution {
  const spin = req.spin?.clone() ?? new Vector3();
  const T = Math.max(0.2, req.flightTime);
  const dx = req.target.x - req.from.x;
  const dz = req.target.z - req.from.z;
  const dy = BALL.RADIUS - req.from.y;
  const vel = new Vector3(dx / T, (dy + 0.5 * PHYSICS.GRAVITY * T * T) / T, dz / T);

  let result = fly(req.from, vel, spin);
  let converged = false;
  for (let i = 0; i < 12; i++) {
    const ex = req.target.x - result.landing.x;
    const ez = req.target.z - result.landing.z;
    if (Math.hypot(ex, ez) < 0.01) {
      converged = true;
      break;
    }
    const gain = 1.05 / Math.max(0.15, result.time);
    vel.x += ex * gain;
    vel.z += ez * gain;
    result = fly(req.from, vel, spin);
  }
  if (!converged) {
    converged = Math.hypot(req.target.x - result.landing.x, req.target.z - result.landing.z) < 0.05;
  }
  return {
    velocity: vel,
    spin,
    landing: result.landing,
    flightTime: result.time,
    netClearance: result.netClearance,
    apex: result.apex,
    converged,
  };
}

/**
 * Plans a shot that clears the net by `minNetClearance`, raising the arc as needed and respecting
 * the max launch speed. Returns the best solution found.
 */
export function planShot(req: ShotRequest): ShotSolution {
  const minClear = req.minNetClearance ?? 0.1;
  const maxSpeed = req.maxSpeed ?? PHYSICS.MAX_SPEED;
  let T = req.flightTime;
  let best = solveShot({ ...req, flightTime: T });
  for (let i = 0; i < 14; i++) {
    const ok = best.netClearance >= minClear && best.velocity.length() <= maxSpeed && best.converged;
    if (ok) return best;
    T += best.velocity.length() > maxSpeed ? 0.1 : 0.07 + Math.max(0, minClear - best.netClearance) * 0.6;
    best = solveShot({ ...req, flightTime: T });
  }
  return best;
}

const UP = new Vector3(0, 1, 0);

/** Topspin axis for a ball travelling horizontally along `dir` (positive rate = topspin). */
function topspin(dir: Vector3, rate: number): Vector3 {
  const d = new Vector3(dir.x, 0, dir.z).normalize();
  return new Vector3().crossVectors(UP, d).multiplyScalar(rate);
}

/**
 * Phase 1 groundstroke/volley: lands on the aimed spot (plus a little human error) with an arc
 * chosen from distance and contact height. Shot types, timing and power arrive in Phase 3.
 */
export function buildStroke(contact: Vector3, side: Side, aimX: number, aimDepth: number, rng: Rng): ShotSolution {
  const ax = clamp(aimX, -1.05, 1.05) + rng.gauss() * 0.05;
  const ad = clamp(aimDepth, 0.12, 1.05) + rng.gauss() * 0.04;
  const t = aimToWorld(side, ax, ad);
  const target = new Vector3(t.x, 0, t.z);
  const dist = Math.hypot(target.x - contact.x, target.z - contact.z);
  let T = 0.42 + dist * 0.062;
  if (contact.y > 1.3) T *= 0.85;
  if (contact.y < 0.5) T += 0.12;
  const spin = topspin(target.clone().sub(contact), 14);
  return planShot({ from: contact, target, flightTime: T, spin, minNetClearance: 0.1, maxSpeed: 24 });
}

/** Underhand serve into the diagonal service court (aim is clamped to that court). */
export function buildServe(contact: Vector3, side: Side, fromRight: boolean, aimX: number, aimDepth: number): ShotSolution {
  const aim = clampServeAim(fromRight, aimX, aimDepth);
  const t = aimToWorld(side, aim.aimX, aim.aimDepth);
  const target = new Vector3(t.x, 0, t.z);
  const spin = topspin(target.clone().sub(contact), 6);
  return planShot({ from: contact, target, flightTime: 1.15, spin, minNetClearance: 0.22, maxSpeed: 20 });
}

/** Keeps a serve aim inside the diagonal service court (between the kitchen line and baseline). */
export function clampServeAim(fromRight: boolean, aimX: number, aimDepth: number): { aimX: number; aimDepth: number } {
  const dir = fromRight ? -1 : 1;
  const mag = clamp(Math.abs(aimX), 0.08, 0.95) * (Math.sign(aimX) === dir ? 1 : 0.5);
  const minDepth = COURT.KITCHEN_DEPTH / COURT.HALF_LENGTH + 0.07;
  return { aimX: dir * mag, aimDepth: clamp(aimDepth, minDepth, 0.97) };
}
