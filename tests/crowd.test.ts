import { describe, expect, it } from 'vitest';
import { CROWD_LAYOUT_DEFAULTS, layoutCrowdSeats, rowCenterX, type CrowdSeat } from '../src/court/Crowd';
import { Rng } from '../src/utils/MathUtils';
import { COURT } from '../src/utils/Constants';

const fx = COURT.HALF_WIDTH + 3.6;
const fz = COURT.HALF_LENGTH + 5;
const opts = { ...CROWD_LAYOUT_DEFAULTS, fx, fz };

function layout(occupancy: number, seed = 1234) {
  const rng = new Rng(seed);
  return layoutCrowdSeats({ ...opts, occupancy }, () => rng.next());
}

describe('crowd layout', () => {
  it('never overlaps neighbours in the same row, across seeds', () => {
    for (const seed of [1, 7, 42, 999, 123456]) {
      const seats = layout(1, seed);
      const byRow = new Map<string, CrowdSeat[]>();
      for (const s of seats) {
        const key = `${s.side}:${s.row}`;
        byRow.set(key, [...(byRow.get(key) ?? []), s]);
      }
      for (const row of byRow.values()) {
        row.sort((a, b) => a.z - b.z);
        for (let i = 1; i < row.length; i++) {
          const a = row[i - 1];
          const b = row[i];
          const minGap = (opts.personWidth * a.scale + opts.personWidth * b.scale) / 2;
          expect(b.z - a.z).toBeGreaterThanOrEqual(minGap - 1e-9);
        }
      }
    }
  });

  it('keeps everyone on their own step', () => {
    for (const s of layout(1)) {
      expect(Math.abs(s.x - rowCenterX(fx, s.side, s.row, opts.rowDepth))).toBeLessThanOrEqual(opts.rowDepth / 2);
      expect(Math.abs(s.z)).toBeLessThanOrEqual(fz * 0.8);
      expect(s.y).toBeCloseTo(opts.rowRise * (1 + s.row * 2));
    }
  });

  it('fills the requested share of seats with no seat used twice', () => {
    const total = layout(1).length;
    const seats = layout(0.55);
    expect(seats.length).toBe(Math.round(total * 0.55));
    const keys = seats.map((s) => `${s.side}:${s.row}:${Math.round(s.z / opts.seatPitch)}`);
    expect(new Set(keys).size).toBe(seats.length);
    expect(layout(0)).toHaveLength(0);
  });
});
