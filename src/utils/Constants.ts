/**
 * World units are meters. Coordinate system:
 *   x = lateral (across the court width), y = up, z = along court length.
 *   The net sits on the plane z = 0.
 *   The NEAR side (human player by default) is z > 0, the FAR side is z < 0.
 */

export const FT = 0.3048;
export const IN = 0.0254;

/** Official USA Pickleball court geometry. */
export const COURT = {
  LENGTH: 44 * FT,
  WIDTH: 20 * FT,
  HALF_LENGTH: 22 * FT,
  HALF_WIDTH: 10 * FT,
  /** Non-volley zone depth measured from the net. */
  KITCHEN_DEPTH: 7 * FT,
  LINE_WIDTH: 2 * IN,
  NET_HEIGHT_CENTER: 34 * IN,
  NET_HEIGHT_SIDELINE: 36 * IN,
  /** Posts are 22 ft apart (1 ft outside each sideline). */
  NET_POST_X: 11 * FT,
} as const;

export const BALL = {
  RADIUS: 0.0373,
  MASS: 0.026,
  /** Rendered size multiplier so the ball reads well on small screens. Physics uses the real radius. */
  VISUAL_SCALE: 1.7,
} as const;

export const PHYSICS = {
  GRAVITY: 9.81,
  /** Quadratic drag factor k in a = -k |v| v (0.5 * rho * Cd * A / m, tuned slightly livelier than reality). */
  DRAG: 0.032,
  /** Magnus factor in a = M (omega x v). */
  MAGNUS: 0.006,
  /** Vertical coefficient of restitution on the court (USAP bounce spec ~0.64). */
  RESTITUTION: 0.66,
  /** Fraction of the contact-point slip velocity removed on each bounce. */
  GROUND_FRICTION: 0.22,
  /** Fraction of spin kept after a bounce. */
  SPIN_KEEP_BOUNCE: 0.5,
  /** Spin decay per second while airborne. */
  SPIN_DECAY_AIR: 0.12,
  /** Rolling friction (1/s) once the ball stops bouncing. */
  ROLL_FRICTION: 1.6,
  /** Below this vertical impact speed the ball rolls instead of bouncing. */
  MIN_BOUNCE_SPEED: 0.35,
  NET_RESTITUTION: 0.12,
  TAPE_RESTITUTION: 0.35,
  TAPE_RADIUS: 0.02,
  REST_SPEED: 0.08,
  /** Physics substep; all gameplay uses the same step so prediction is exact. */
  FIXED_DT: 1 / 240,
  MAX_SPEED: 32,
} as const;

export const SIM = {
  /** Gameplay tick rate. Physics runs 2 substeps per tick. */
  TICK_DT: 1 / 120,
  MAX_TICKS_PER_FRAME: 12,
} as const;

export const PLAYER = {
  RUN_SPEED: 4.7,
  SPRINT_SPEED: 6.3,
  ACCEL: 34,
  DECEL: 42,
  /** Horizontal reach from body center to where the paddle can meet the ball. */
  REACH: 1.1,
  REACH_MIN_H: 0.06,
  REACH_MAX_H: 2.45,
  BODY_RADIUS: 0.3,
  SWING_DURATION: 0.42,
  /** Swing time window during which the paddle can make contact. */
  CONTACT_WINDOW: 0.26,
  SERVE_CONTACT_DELAY: 0.16,
  SERVE_CONTACT_HEIGHT: 0.72,
  /** How far behind the baseline / outside the sidelines a player may roam. */
  BACK_ROOM: 3.6,
  SIDE_ROOM: 2.6,
  NET_GAP: 0.28,
} as const;

/** +1 = near side (z > 0), -1 = far side (z < 0). */
export type Side = 1 | -1;
export const NEAR: Side = 1;
export const FAR: Side = -1;
export const otherSide = (s: Side): Side => (s === 1 ? -1 : 1);
