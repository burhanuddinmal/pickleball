import type { Vector3 } from 'three';
import { COURT, otherSide, PLAYER, RULES, type Side } from '../utils/Constants';

/**
 * Pure, render-free pickleball rules (USA Pickleball, singles). Every function here is
 * deterministic and unit-tested; RallyManager applies them to the live simulation.
 */

/** Ball-on-line counts as in: allow for the ball's contact patch touching the line's outer edge. */
export const LINE_TOLERANCE = 0.01;

export type RallyEndReason =
  | 'OUT_OF_BOUNDS'
  | 'NET'
  | 'MISS'
  | 'BALL_STUCK'
  | 'SERVE_IN_KITCHEN'
  | 'SERVE_WRONG_COURT'
  | 'TWO_BOUNCE_VIOLATION'
  | 'KITCHEN_VOLLEY'
  | 'FOOT_FAULT';

export interface RallyOutcome {
  /** Side that won the rally, or null for a replay (e.g. safety reset). */
  winner: Side | null;
  reason: RallyEndReason;
  /** Side responsible for ending the rally (null for a replay). */
  faultBy: Side | null;
}

export const sideOfZ = (z: number): Side => (z >= 0 ? 1 : -1);

/** A fault by `side`: the other side wins the rally. */
const fault = (side: Side, reason: RallyEndReason): RallyOutcome => ({ winner: otherSide(side), reason, faultBy: side });

export function isInsideCourt(x: number, z: number, tol = LINE_TOLERANCE): boolean {
  return Math.abs(x) <= COURT.HALF_WIDTH + tol && Math.abs(z) <= COURT.HALF_LENGTH + tol;
}

/**
 * Distance (m) from a ground point to the nearest sideline or baseline segment. Used for
 * presentation only ("close call" highlights); judging uses isInsideCourt().
 */
export function distanceToNearestLine(x: number, z: number): number {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const side = Math.hypot(ax - COURT.HALF_WIDTH, Math.max(0, az - COURT.HALF_LENGTH));
  const base = Math.hypot(az - COURT.HALF_LENGTH, Math.max(0, ax - COURT.HALF_WIDTH));
  return Math.min(side, base);
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
      return fault(hitterSide, 'NET');
    }
    if (!isInsideCourt(pos.x, pos.z)) return fault(hitterSide, 'OUT_OF_BOUNDS');
    return null;
  }
  // A second bounce means the receiver failed to return a good ball.
  return { winner: hitterSide, reason: 'MISS', faultBy: receiver };
}

/**
 * Judges the first bounce of a serve. It must land in the diagonal service court: past the
 * kitchen line (a ball touching the kitchen line is a fault), and between the centerline and
 * sideline, up to the baseline (those lines are in). A serve that clips the net and still lands
 * in the right court is good (no let).
 */
export function judgeServeLanding(serverSide: Side, fromRight: boolean, pos: { x: number; z: number }): RallyOutcome | null {
  const receiver = otherSide(serverSide);
  if (sideOfZ(pos.z) === serverSide) return fault(serverSide, 'NET');
  if (!isInsideCourt(pos.x, pos.z)) return fault(serverSide, 'OUT_OF_BOUNDS');
  // Receiver-relative coordinates. Serving from the server's right lands in the receiver's right court.
  const depth = pos.z * receiver;
  const lateral = pos.x * receiver * (fromRight ? 1 : -1);
  if (depth <= COURT.KITCHEN_DEPTH + LINE_TOLERANCE) return fault(serverSide, 'SERVE_IN_KITCHEN');
  if (lateral < -LINE_TOLERANCE) return fault(serverSide, 'SERVE_WRONG_COURT');
  return null;
}

/**
 * True if a player standing at `pos` on `side` has a foot in the non-volley zone or on its line.
 * The kitchen spans sideline to sideline; standing outside the sidelines is not in the kitchen.
 */
export function isInKitchen(side: Side, pos: { x: number; z: number }, foot: number = PLAYER.FOOT_RADIUS): boolean {
  const depth = pos.z * side;
  return depth >= 0 && depth - foot <= COURT.KITCHEN_DEPTH && Math.abs(pos.x) - foot <= COURT.HALF_WIDTH;
}

export interface ContactInfo {
  hitterSide: Side;
  /** Paddle contacts so far this rally, before this one (1 = only the serve has been hit). */
  shotIndex: number;
  /** Bounces since the previous paddle contact (0 = this contact is a volley). */
  bouncesSinceHit: number;
  hitterPos: { x: number; z: number };
}

/**
 * Judges a paddle contact during a live rally. Two-bounce rule: the return of serve and the
 * third shot must bounce first. Kitchen rule: no volleying with a foot in the kitchen or on its
 * line (a ball that has bounced may be played from anywhere).
 */
export function judgeContact(c: ContactInfo): RallyOutcome | null {
  if (c.bouncesSinceHit > 0) return null;
  if (c.shotIndex <= 2) return fault(c.hitterSide, 'TWO_BOUNCE_VIOLATION');
  if (isInKitchen(c.hitterSide, c.hitterPos)) return fault(c.hitterSide, 'KITCHEN_VOLLEY');
  return null;
}

/**
 * Momentum fault: carried into the kitchen by a volley during the follow-through.
 * `sinceVolley` is the time since this player's last volley (Infinity if none this rally).
 */
export function judgeMomentum(side: Side, pos: { x: number; z: number }, sinceVolley: number): RallyOutcome | null {
  if (sinceVolley > RULES.MOMENTUM_WINDOW) return null;
  return isInKitchen(side, pos) ? fault(side, 'KITCHEN_VOLLEY') : null;
}

/**
 * Server position at contact: behind the baseline (no foot touching it) and between the
 * imaginary extensions of the centerline and sideline of the correct half.
 */
export function isLegalServePosition(side: Side, fromRight: boolean, pos: { x: number; z: number }, foot: number = PLAYER.FOOT_RADIUS): boolean {
  const depth = pos.z * side;
  const lateral = pos.x * side * (fromRight ? 1 : -1);
  return depth - foot >= COURT.HALF_LENGTH && lateral >= 0 && lateral <= COURT.HALF_WIDTH;
}

/** Judges the server's position at the moment of contact. */
export function judgeServePosition(side: Side, fromRight: boolean, pos: { x: number; z: number }): RallyOutcome | null {
  return isLegalServePosition(side, fromRight, pos) ? null : fault(side, 'FOOT_FAULT');
}

/** A ball that stops without a rally-ending bounce counts against the side it stopped on. */
export function judgeRest(hitterSide: Side | null, pos: Vector3): RallyOutcome {
  if (hitterSide === null) return { winner: null, reason: 'BALL_STUCK', faultBy: null };
  const loser = sideOfZ(pos.z);
  return { winner: otherSide(loser), reason: loser === hitterSide ? 'NET' : 'MISS', faultBy: loser };
}

// ---------------------------------------------------------------- scoring

/** Side-out (traditional: only the server scores) or rally scoring (every rally scores). */
export type ScoringMode = 'sideout' | 'rally';
export const SCORING_MODES: readonly ScoringMode[] = ['sideout', 'rally'];

export interface ScoreState {
  /** Points for the near (+1) and far (-1) sides. */
  near: number;
  far: number;
  server: Side;
  /** Singles: serve from the right on an even server score, from the left on an odd one. */
  fromRight: boolean;
}

export const scoreFor = (s: ScoreState, side: Side): number => (side === 1 ? s.near : s.far);

export function newScore(server: Side): ScoreState {
  return { near: 0, far: 0, server, fromRight: true };
}

/**
 * Applies a rally result. Side-out: the server's win scores a point; the receiver's win is a
 * side out (no point, serve changes hands). Rally: the winner scores and serves next.
 */
export function applyRallyResult(s: ScoreState, winner: Side, mode: ScoringMode): ScoreState {
  const next = { ...s };
  const scores = mode === 'rally' || winner === s.server;
  if (scores) {
    if (winner === 1) next.near++;
    else next.far++;
  }
  next.server = winner;
  next.fromRight = scoreFor(next, winner) % 2 === 0;
  return next;
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

/** True if `side` wins the game by winning the next rally (side-out: only the server can score). */
export function hasGamePoint(s: ScoreState, side: Side, target: number, mode: ScoringMode): boolean {
  if (mode === 'sideout' && s.server !== side) return false;
  return isGamePoint(scoreFor(s, side), scoreFor(s, otherSide(side)), target);
}
