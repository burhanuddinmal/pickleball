import type { Vector3 } from 'three';
import { COURT, otherSide, type Side } from '../utils/Constants';

/**
 * Pure, render-free pickleball rules. Every function here is deterministic and unit-tested.
 * Phase 1 covers rally-ending conditions; serve/kitchen/two-bounce rules are added in Phase 2.
 */

/** Ball-on-line counts as in: allow for the ball's contact patch touching the line's outer edge. */
export const LINE_TOLERANCE = 0.01;

export type RallyEndReason =
  | 'OUT_OF_BOUNDS'
  | 'NET'
  | 'MISS'
  | 'BALL_STUCK';

export interface RallyOutcome {
  /** Side that won the rally, or null for a replay (e.g. safety reset). */
  winner: Side | null;
  reason: RallyEndReason;
  /** Side responsible for ending the rally (null for a replay). */
  faultBy: Side | null;
}

export const sideOfZ = (z: number): Side => (z >= 0 ? 1 : -1);

export function isInsideCourt(x: number, z: number, tol = LINE_TOLERANCE): boolean {
  return Math.abs(x) <= COURT.HALF_WIDTH + tol && Math.abs(z) <= COURT.HALF_LENGTH + tol;
}

/**
 * Judges a bounce. `bounceIndex` is 1 for the first bounce after the last paddle contact.
 * Returns an outcome if the bounce ends the rally, otherwise null.
 */
export function judgeBounce(hitterSide: Side, bounceIndex: number, pos: Vector3): RallyOutcome | null {
  const receiver = otherSide(hitterSide);
  if (bounceIndex === 1) {
    if (sideOfZ(pos.z) === hitterSide) {
      // Never crossed: the ball hit the net (or was mishit) and landed on the hitter's side.
      return { winner: receiver, reason: 'NET', faultBy: hitterSide };
    }
    if (!isInsideCourt(pos.x, pos.z)) {
      return { winner: receiver, reason: 'OUT_OF_BOUNDS', faultBy: hitterSide };
    }
    return null;
  }
  // A second bounce means the receiver failed to return a good ball.
  return { winner: hitterSide, reason: 'MISS', faultBy: receiver };
}

/** A ball that stops without a rally-ending bounce counts against the side it stopped on. */
export function judgeRest(hitterSide: Side | null, pos: Vector3): RallyOutcome {
  if (hitterSide === null) return { winner: null, reason: 'BALL_STUCK', faultBy: null };
  const loser = sideOfZ(pos.z);
  return { winner: otherSide(loser), reason: loser === hitterSide ? 'NET' : 'MISS', faultBy: loser };
}

/** Match lengths the player can pick. Like real pickleball, a game must be won by 2. */
export const MATCH_TARGETS = [7, 11, 21] as const;
export type MatchTarget = (typeof MATCH_TARGETS)[number];

/** Returns which score won the game, or null while the game is still going. */
export function matchWinner(a: number, b: number, target: number): 'a' | 'b' | null {
  if (a >= target && a - b >= 2) return 'a';
  if (b >= target && b - a >= 2) return 'b';
  return null;
}

/** True when `score` is one point away from winning against `other`. */
export function isGamePoint(score: number, other: number, target: number): boolean {
  return matchWinner(score + 1, other, target) === 'a';
}
