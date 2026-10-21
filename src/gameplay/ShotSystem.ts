import { Vector3 } from 'three';
import { createBallState, launchBall, stepBall } from '../physics/BallPhysics';
import { netHeightAt } from '../physics/CollisionSystem';
import { AIM, BALL, COURT, PHYSICS, PLAYER, POWER, type Side } from '../utils/Constants';
import { aimToWorld, clamp, lerp, type Rng } from '../utils/MathUtils';

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
 * Contact quality 0..1 from timing and stretch. `swingT` is the swing time at contact (inside
 * PLAYER.CONTACT_WINDOW); `reachFrac` is horizontal ball distance / PLAYER.REACH.
 * Contacts inside the sweet window at a comfortable distance score 1; late or stretched lower.
 */
export function contactQuality(swingT: number, reachFrac: number): number {
  let timing = 1;
  if (swingT < AIM.SWEET_START) timing = 0.75 + 0.25 * (swingT / AIM.SWEET_START);
  else if (swingT > AIM.SWEET_END) timing = 1 - (swingT - AIM.SWEET_END) / (PLAYER.CONTACT_WINDOW - AIM.SWEET_END);
  const stretch = reachFrac <= 0.75 ? 1 : 1 - (reachFrac - 0.75) / 0.25;
  return clamp(timing, 0, 1) * clamp(0.4 + 0.6 * stretch, 0, 1);
}

export interface StrokeOptions {
  /** Contact quality 0..1 (see contactQuality); scales the random aim error. Default 0.7. */
  quality?: number;
  /** Charge 0..1; at POWER.MIN or above the stroke is a power shot (or a smash when high). */
  power?: number;
}

export type StrokeKind = 'normal' | 'power' | 'smash';

export function strokeKind(contactY: number, power: number): StrokeKind {
  if (power < POWER.MIN) return 'normal';
  return contactY > POWER.SMASH_HEIGHT ? 'smash' : 'power';
}

/** Aim error multiplier for a contact of the given quality and power. */
export function aimErrorScale(quality: number, power: number): number {
  return lerp(AIM.ERROR_BEST, AIM.ERROR_WORST, 1 - clamp(quality, 0, 1)) * (1 + 0.5 * power);
}

/**
 * Groundstroke / volley: lands on the aimed spot plus human error scaled by contact quality,
 * with an arc chosen from distance and contact height. Power shots are flatter, faster and
 * spinnier; a charged contact above POWER.SMASH_HEIGHT is a steep downward smash.
 */
export function buildStroke(contact: Vector3, side: Side, aimX: number, aimDepth: number, rng: Rng, opts: StrokeOptions = {}): ShotSolution {
  const quality = opts.quality ?? 0.7;
  const kind = strokeKind(contact.y, opts.power ?? 0);
  const p = kind === 'normal' ? 0 : clamp(opts.power ?? 0, 0, 1);
  const err = aimErrorScale(quality, p);
  const baseDepth = kind === 'smash' ? Math.min(aimDepth, 0.72) : aimDepth;
  const ax = clamp(aimX, -1.05, 1.05) + rng.gauss() * AIM.BASE_ERR_X * err;
  const ad = clamp(baseDepth, 0.12, 1.05) + rng.gauss() * AIM.BASE_ERR_DEPTH * err;
  const t = aimToWorld(side, ax, ad);
  const target = new Vector3(t.x, 0, t.z);
  const dist = Math.hypot(target.x - contact.x, target.z - contact.z);

  if (kind === 'smash') {
    const spin = topspin(target.clone().sub(contact), 10);
    return planShot({ from: contact, target, flightTime: 0.2 + dist * 0.018, spin, minNetClearance: 0.04, maxSpeed: PHYSICS.MAX_SPEED });
  }

  let T = 0.42 + dist * 0.062;
  if (contact.y > 1.3) T *= 0.85;
  if (contact.y < 0.5) T += 0.12;
  T *= 1 - 0.45 * p;
  const spin = topspin(target.clone().sub(contact), 14 + 18 * p);
  const sol = planShot({
    from: contact,
    target,
    flightTime: T,
    spin,
    minNetClearance: lerp(0.1, 0.04, p),
    maxSpeed: lerp(24, PHYSICS.MAX_SPEED * 0.97, p),
  });
  // Driving a ball from below net height is risky: a flat power shot can dip into the net.
  if (p > 0 && contact.y < COURT.NET_HEIGHT_CENTER) {
    sol.velocity.y += (rng.gauss() * 0.35 - 0.15) * p * (1.5 - quality);
  }
  return sol;
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
