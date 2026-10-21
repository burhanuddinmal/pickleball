import { AIM, COURT, type Side } from '../utils/Constants';
import { clamp } from '../utils/MathUtils';

/**
 * Pure shot-targeting helpers. Aim is normalized in the hitter's frame: aimX -1..1 is left..right
 * across the opponent's court as the hitter sees it, aimDepth 0..1 is net..baseline (see
 * aimToWorld). Every input method snaps to a 3×3 grid of target zones pulled inside the lines.
 */

export interface Aim {
  aimX: number;
  aimDepth: number;
}

/** Column -1 / 0 / 1 = left / center / right. Row -1 / 0 / 1 = short / middle / deep. */
export type Lane = -1 | 0 | 1;

/** Normalized lateral target of a side column (aim assist keeps it AIM.INSET inside the sideline). */
export const SIDE_COLUMN_X = (COURT.HALF_WIDTH - AIM.INSET) / COURT.HALF_WIDTH;
export const ROW_DEPTH: Record<Lane, number> = {
  [-1]: (COURT.KITCHEN_DEPTH + AIM.SHORT_PAST_KITCHEN) / COURT.HALF_LENGTH,
  0: 0.66,
  1: (COURT.HALF_LENGTH - AIM.INSET) / COURT.HALF_LENGTH,
};

export function zoneAim(col: Lane, row: Lane): Aim {
  return { aimX: col * SIDE_COLUMN_X, aimDepth: ROW_DEPTH[row] };
}

const laneOf = (v: number, dead: number): Lane => (v > dead ? 1 : v < -dead ? -1 : 0);

/** Snaps any aim to the nearest of the 3×3 target zones. */
export function snapAim(aimX: number, aimDepth: number): Aim {
  const col = laneOf(aimX, SIDE_COLUMN_X / 2);
  const d = clamp(aimDepth, 0, 1.2);
  const midShort = (ROW_DEPTH[-1] + ROW_DEPTH[0]) / 2;
  const midDeep = (ROW_DEPTH[0] + ROW_DEPTH[1]) / 2;
  const row: Lane = d < midShort ? -1 : d > midDeep ? 1 : 0;
  return zoneAim(col, row);
}

/**
 * Safe default with no direction held: deep, shaded slightly away from the opponent.
 * `opponentX` is the opponent's world x; `side` is the hitter's side.
 */
export function defaultAim(side: Side, opponentX: number): Aim {
  // In the hitter's aim space the opponent sits at aimX = x / (HALF_WIDTH * side) (see aimToWorld).
  const oppAim = opponentX / (COURT.HALF_WIDTH * side);
  const away = oppAim >= 0 ? -1 : 1;
  return { aimX: away * AIM.DEFAULT_AWAY, aimDepth: ROW_DEPTH[1] };
}

/**
 * Direction-at-hit aiming from the movement input held when the swing starts. `moveX` / `moveY`
 * are side-relative (right / toward the net positive). Left/right picks the column; forward is
 * deep, back is short. Nothing held gives defaultAim().
 */
export function directionalAim(moveX: number, moveY: number, side: Side, opponentX: number): Aim {
  const col = laneOf(moveX, AIM.DEAD_ZONE);
  const back = moveY < -AIM.DEAD_ZONE;
  if (col === 0 && !back && moveY <= AIM.DEAD_ZONE) return defaultAim(side, opponentX);
  const center = col === 0 ? defaultAim(side, opponentX).aimX : col * SIDE_COLUMN_X;
  return { aimX: center, aimDepth: ROW_DEPTH[back ? -1 : 1] };
}

/**
 * Touch swipe aiming (screen px; up = negative dy). Short swipes are a tap (default aim); the
 * direction needs a clear lean to pick a column or the short row, then snaps to a zone.
 */
export const SWIPE_TAP_PX = 24;
export function swipeAim(dx: number, dy: number, side: Side, opponentX: number): Aim {
  const len = Math.hypot(dx, dy);
  if (len < SWIPE_TAP_PX) return defaultAim(side, opponentX);
  const nx = dx / len;
  const ny = -dy / len;
  const col = laneOf(nx, 0.42);
  const row: Lane = ny < -0.5 ? -1 : ny > 0.35 || col === 0 ? 1 : 0;
  return zoneAim(col, row);
}

/** Converts a world ground point (e.g. a mouse click) into the hitter's normalized aim, snapped. */
export function pointAim(side: Side, x: number, z: number): Aim {
  return snapAim(x / (COURT.HALF_WIDTH * side), (-z * side) / COURT.HALF_LENGTH);
}
