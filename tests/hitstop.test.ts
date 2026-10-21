import { describe, expect, it } from 'vitest';
import { HitStop } from '../src/game/HitStop';

describe('hit-stop', () => {
  it('passes time through when idle', () => {
    const h = new HitStop(0.05);
    expect(h.scale(1 / 60)).toBeCloseTo(1 / 60);
    expect(h.active).toBe(false);
  });

  it('slows time for exactly the requested real duration', () => {
    const h = new HitStop(0.05);
    h.trigger(0.05);
    expect(h.active).toBe(true);
    // 0.03 s fully inside the stop.
    expect(h.scale(0.03)).toBeCloseTo(0.03 * 0.05);
    // 0.02 s left in the stop, the remaining 0.01 s runs at full speed.
    expect(h.scale(0.03)).toBeCloseTo(0.02 * 0.05 + 0.01);
    expect(h.active).toBe(false);
  });

  it('extends rather than stacks overlapping stops', () => {
    const h = new HitStop(0);
    h.trigger(0.04);
    h.trigger(0.02);
    expect(h.scale(0.05)).toBeCloseTo(0.01);
  });

  it('does nothing when disabled, and clear() cancels a pending stop', () => {
    const h = new HitStop(0);
    h.enabled = false;
    h.trigger(0.1);
    expect(h.active).toBe(false);
    h.enabled = true;
    h.trigger(0.1);
    h.clear();
    expect(h.scale(0.02)).toBeCloseTo(0.02);
  });
});

describe('slow motion', () => {
  it('scales time for the requested real duration, then returns to full speed', () => {
    const h = new HitStop(0.05);
    h.slowMo(0.6, 0.35);
    expect(h.slowActive).toBe(true);
    expect(h.active).toBe(false);
    expect(h.scale(0.5)).toBeCloseTo(0.5 * 0.35);
    expect(h.scale(0.2)).toBeCloseTo(0.1 * 0.35 + 0.1);
    expect(h.slowActive).toBe(false);
    expect(h.scale(0.1)).toBeCloseTo(0.1);
  });

  it('uses the slower scale where a hit-stop overlaps slow motion', () => {
    const h = new HitStop(0.05);
    h.slowMo(0.1, 0.5);
    h.trigger(0.04);
    // 0.04 s hit-stop, then 0.06 s slow motion, then 0.02 s full speed.
    expect(h.scale(0.12)).toBeCloseTo(0.04 * 0.05 + 0.06 * 0.5 + 0.02);
  });

  it('is skipped when disabled and cancelled by clear()', () => {
    const h = new HitStop();
    h.enabled = false;
    h.slowMo(1, 0.3);
    expect(h.slowActive).toBe(false);
    h.enabled = true;
    h.slowMo(1, 0.3);
    h.clear();
    expect(h.scale(0.05)).toBeCloseTo(0.05);
  });
});
