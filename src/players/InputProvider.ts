import type { Vector3 } from 'three';
import type { Side } from '../utils/Constants';

/**
 * What a player wants to do this tick, expressed relative to their own side of the court so the
 * same intent works for either side and for local, AI or (later) network sources.
 *   moveX: -1..1 left/right as seen by the player facing the net
 *   moveY: -1..1 backward/forward (forward = toward the net)
 *   aimX:  -1..1 left/right landing position across the opponent's court
 *   aimDepth: 0..1 from the net to the opponent's baseline
 */
export interface PlayerIntent {
  moveX: number;
  moveY: number;
  sprint: boolean;
  /** Edge-triggered: true on the tick the player starts a swing. */
  swing: boolean;
  aimX: number;
  aimDepth: number;
  /** Charge 0..1 for the swing starting this tick, or the current charge while `charging`. */
  power: number;
  /** True while the swing button is held (charging a power shot). */
  charging: boolean;
}

/** Read-only snapshot of the world that input providers may observe. Never mutate. */
export interface InputContext {
  side: Side;
  selfPos: Vector3;
  opponentPos: Vector3;
  ballPos: Vector3;
  ballVel: Vector3;
  ballLive: boolean;
  /** Side of the player who last hit the ball (null before the serve). */
  lastHitterSide: Side | null;
  /** Bounces since the last paddle contact. */
  bouncesSinceHit: number;
  /** Increments on every paddle contact in the rally (1 = serve). */
  shotIndex: number;
  /** True when this player must let the incoming ball bounce (two-bounce rule). */
  mustLetBounce: boolean;
  isServing: boolean;
  isReceiving: boolean;
  /** When serving: true if serving from the right-hand court. */
  serveFromRight: boolean;
  time: number;
}

export interface InputProvider {
  update(ctx: InputContext, dt: number): void;
  getIntent(): PlayerIntent;
  /** Called when a rally resets so providers can clear buffered input. */
  reset?(): void;
}

export const emptyIntent = (): PlayerIntent => ({
  moveX: 0,
  moveY: 0,
  sprint: false,
  swing: false,
  aimX: 0,
  aimDepth: 0.75,
  power: 0,
  charging: false,
});
