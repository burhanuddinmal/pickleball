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
  /** Ramp toward the stick direction (m/s²): ~0.06 s to full run speed. */
  ACCEL: 80,
  /** Braking with no input: ~0.085 s / ~0.2 m skid from a run. */
  DECEL: 55,
  /** Braking when the input opposes the current velocity, so reversals feel instant. */
  TURN_ACCEL: 140,
  /** Body turn rate toward the ball (exponential smoothing, 1/s). */
  TURN_RATE: 22,
  /** Move-speed multiplier while the paddle is in its contact window (not the whole swing). */
  SWING_SPEED_MUL: 0.8,
  /** Swing assist: when a swing starts with the ball this far beyond REACH, step toward it. */
  AUTO_STEP: 0.4,
  /** Time (s) over which the auto-step is applied. */
  AUTO_STEP_TIME: 0.1,
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
  /** Height of the ball held in the server's hand before the toss. */
  SERVE_HOLD_HEIGHT: 0.82,
  /** Server and receiver stand this far right (or left) of center, in diagonal service courts. */
  SERVE_LATERAL: 1.25,
  /** Receiver's starting distance from the net (just inside the baseline). */
  RECEIVE_DEPTH: COURT.HALF_LENGTH - 0.15,
  /** Rendered player height (m) and paddle size multiplier, shared by both player models. */
  MODEL_HEIGHT: 1.7,
  PADDLE_SCALE: 1.05,
  /** How far behind the baseline / outside the sidelines a player may roam. */
  BACK_ROOM: 3.6,
  SIDE_ROOM: 2.6,
  NET_GAP: 0.28,
  /** Distance from body center to the edge of the feet, for kitchen and foot-fault judging. */
  FOOT_RADIUS: 0.1,
} as const;

export const RULES = {
  /** After a volley, stepping into the kitchen within this time is a momentum fault (s). */
  MOMENTUM_WINDOW: 0.5,
} as const;

/** Hold-to-charge power shots. */
export const POWER = {
  /** Hold time (s) for a full charge. */
  CHARGE_TIME: 0.6,
  /** Presses shorter than this are plain taps (normal shot). */
  TAP_TIME: 0.12,
  /** Charge at or above which a shot counts as a power shot. */
  MIN: 0.3,
  /** Contact height (m) above which a charged shot becomes an overhead smash. */
  SMASH_HEIGHT: 1.5,
  /** Recovery (swing cooldown, s) after a power swing; a normal contact recovers in 0.02 s. */
  RECOVERY: 0.28,
} as const;

/** "Swipe" control style: a flick's speed sets the shot's power. */
export const SWIPE = {
  /** Flick speed is measured over this much of the swipe before release (s). */
  SAMPLE_WINDOW: 0.08,
  /** Flick speeds in screen-heights per second: at or below SLOW no power, at FAST full power. */
  SLOW: 1.0,
  FAST: 4.0,
} as const;

/** Shot targeting: 3×3 target zones and error scaling. */
export const AIM = {
  /** Aim assist: zone targets sit this far (m) inside the sidelines / baseline. */
  INSET: 0.5,
  /** Short targets land this far (m) past the kitchen line. */
  SHORT_PAST_KITCHEN: 0.6,
  /** Stick / key deflection needed to pick a side column or short/deep row. */
  DEAD_ZONE: 0.3,
  /** With no direction held, aim this far (normalized) away from the opponent. */
  DEFAULT_AWAY: 0.3,
  /** Multiplier on the base aim error for a perfect and for a worst-quality contact. */
  ERROR_BEST: 0.4,
  ERROR_WORST: 2.0,
  /** Base aim error before scaling: lateral, depth. */
  BASE_ERR_X: 0.05,
  BASE_ERR_DEPTH: 0.04,
  /** Swing time (s) range inside CONTACT_WINDOW that counts as perfectly timed. */
  SWEET_START: 0.04,
  SWEET_END: 0.15,
} as const;

/** +1 = near side (z > 0), -1 = far side (z < 0). */
export type Side = 1 | -1;
export const NEAR: Side = 1;
export const FAR: Side = -1;
export const otherSide = (s: Side): Side => (s === 1 ? -1 : 1);
