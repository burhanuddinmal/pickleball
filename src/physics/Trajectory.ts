import { Vector3 } from 'three';
import { PHYSICS } from '../utils/Constants';
import { copyBallState, createBallState, stepBall, type BallEvent, type BallState } from './BallPhysics';

export interface LandingPrediction {
  point: Vector3;
  time: number;
  hitsNet: boolean;
}

export interface PathSample {
  t: number;
  pos: Vector3;
  vel: Vector3;
  /** Number of bounces that happened before this sample. */
  bounces: number;
}

const sim = createBallState();
const events: BallEvent[] = [];

/** Predicts where (and when) the ball will next touch the court, using the exact live physics. */
export function predictLanding(state: BallState, maxTime = 5): LandingPrediction | null {
  copyBallState(state, sim);
  let hitsNet = false;
  const steps = Math.ceil(maxTime / PHYSICS.FIXED_DT);
  for (let i = 1; i <= steps; i++) {
    events.length = 0;
    stepBall(sim, events);
    for (const e of events) {
      if (e.type === 'net') hitsNet = true;
      if (e.type === 'bounce' || (e.type === 'rest' && !hitsNet)) {
        return { point: e.pos.clone(), time: i * PHYSICS.FIXED_DT, hitsNet };
      }
    }
    if (sim.atRest || sim.rolling) return { point: sim.pos.clone(), time: i * PHYSICS.FIXED_DT, hitsNet };
  }
  return null;
}

/**
 * Samples the future path (positions every `sampleDt`) until `maxBounces` bounces have occurred
 * or `maxTime` elapses. Used by AI interception planning and debug drawing.
 */
export function samplePath(state: BallState, maxTime = 4, sampleDt = 1 / 60, maxBounces = 2): PathSample[] {
  copyBallState(state, sim);
  const out: PathSample[] = [];
  const every = Math.max(1, Math.round(sampleDt / PHYSICS.FIXED_DT));
  const steps = Math.ceil(maxTime / PHYSICS.FIXED_DT);
  let bounces = 0;
  for (let i = 1; i <= steps; i++) {
    events.length = 0;
    stepBall(sim, events);
    for (const e of events) if (e.type === 'bounce') bounces++;
    if (bounces >= maxBounces || sim.atRest) break;
    if (i % every === 0) {
      out.push({ t: i * PHYSICS.FIXED_DT, pos: sim.pos.clone(), vel: sim.vel.clone(), bounces });
    }
  }
  return out;
}
