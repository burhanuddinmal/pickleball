import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createBallState, launchBall, stepBall, type BallEvent } from '../src/physics/BallPhysics';
import { netHeightAt } from '../src/physics/CollisionSystem';
import { predictLanding } from '../src/physics/Trajectory';
import { planShot } from '../src/gameplay/ShotSystem';
import { BALL, COURT, PHYSICS } from '../src/utils/Constants';

function run(state = createBallState(), seconds: number, events: BallEvent[] = []) {
  const steps = Math.round(seconds / PHYSICS.FIXED_DT);
  for (let i = 0; i < steps; i++) stepBall(state, events);
  return events;
}

describe('ball physics', () => {
  it('falls under gravity and bounces with the official bounce height', () => {
    // USAP: dropped from 78" the ball must rebound 30-34".
    const s = createBallState(new Vector3(2, 78 * 0.0254 + BALL.RADIUS, 3));
    const events: BallEvent[] = [];
    let maxAfter = 0;
    let bounced = false;
    for (let i = 0; i < 2 * 240; i++) {
      stepBall(s, events);
      if (events.some((e) => e.type === 'bounce')) bounced = true;
      if (bounced) maxAfter = Math.max(maxAfter, s.pos.y - BALL.RADIUS);
      if (bounced && s.vel.y < 0) break;
    }
    const inches = maxAfter / 0.0254;
    expect(inches).toBeGreaterThan(28);
    expect(inches).toBeLessThan(36);
  });

  it('eventually comes to rest (never stuck bouncing forever)', () => {
    const s = createBallState(new Vector3(0, 2, 3));
    s.vel.set(1, 0, -1);
    const events = run(s, 20);
    expect(s.atRest).toBe(true);
    expect(events.some((e) => e.type === 'rest')).toBe(true);
    expect(s.pos.y).toBeCloseTo(BALL.RADIUS, 5);
  });

  it('topspin dives and kicks forward; backspin floats', () => {
    const base = () => {
      const s = createBallState();
      launchBall(s, new Vector3(0, 1, 6), new Vector3(0, 4.5, -13), new Vector3());
      return s;
    };
    const flat = base();
    const top = base();
    top.spin.set(-40, 0, 0); // forward-rotating for a ball travelling -z
    const back = base();
    back.spin.set(40, 0, 0);
    const l0 = predictLanding(flat)!;
    const lt = predictLanding(top)!;
    const lb = predictLanding(back)!;
    expect(lt.point.z).toBeGreaterThan(l0.point.z); // lands shorter
    expect(lb.point.z).toBeLessThan(l0.point.z); // carries longer
  });
});

describe('net collision', () => {
  it('net is 34" at center and 36" at the sidelines', () => {
    expect(netHeightAt(0)).toBeCloseTo(34 * 0.0254, 5);
    expect(netHeightAt(COURT.HALF_WIDTH)).toBeCloseTo(36 * 0.0254, 5);
  });

  it('a low fast ball cannot tunnel through the net and drops on the hitter side', () => {
    const s = createBallState();
    launchBall(s, new Vector3(0, 0.5, 4), new Vector3(0, 0.6, -25), new Vector3());
    const events = run(s, 4);
    expect(events.some((e) => e.type === 'net')).toBe(true);
    expect(s.pos.z).toBeGreaterThan(0);
    expect(s.atRest || s.rolling).toBe(true);
  });

  it('a ball well above the net passes cleanly', () => {
    const s = createBallState();
    launchBall(s, new Vector3(0, 1.0, 5), new Vector3(0, 4, -12), new Vector3());
    const events = run(s, 3);
    expect(events.some((e) => e.type === 'net')).toBe(false);
    expect(s.pos.z).toBeLessThan(0);
  });

  it('a ball outside the posts is not blocked', () => {
    const s = createBallState();
    launchBall(s, new Vector3(COURT.NET_POST_X + 0.3, 0.4, 3), new Vector3(0, 1, -10), new Vector3());
    const events = run(s, 2);
    expect(events.some((e) => e.type === 'net')).toBe(false);
  });

  it('a tape clip resolves to one side without sticking in the net', () => {
    for (const vy of [-0.2, 0, 0.2, 0.4]) {
      const s = createBallState();
      const h = netHeightAt(0);
      launchBall(s, new Vector3(0, h + BALL.RADIUS + 0.005, 0.5), new Vector3(0, vy, -6), new Vector3());
      run(s, 8);
      expect(s.atRest).toBe(true);
      expect(Math.abs(s.pos.z)).toBeGreaterThan(BALL.RADIUS * 0.99);
    }
  });
});

describe('trajectory prediction', () => {
  it('predicted landing matches the live simulation exactly', () => {
    const s = createBallState();
    launchBall(s, new Vector3(1, 1, 6), new Vector3(-1, 4, -11), new Vector3(-20, 0, 0));
    const pred = predictLanding(s)!;
    const events: BallEvent[] = [];
    let t = 0;
    while (!events.some((e) => e.type === 'bounce')) {
      stepBall(s, events);
      t += PHYSICS.FIXED_DT;
    }
    const b = events.find((e) => e.type === 'bounce')!;
    expect(b.pos.distanceTo(pred.point)).toBeLessThan(1e-9);
    expect(t).toBeCloseTo(pred.time, 6);
  });
});

describe('shot solver', () => {
  const cases: [Vector3, Vector3, number][] = [
    [new Vector3(0, 0.9, 6.5), new Vector3(-2, 0, -5.5), 1.2], // deep cross-court
    [new Vector3(2, 0.4, 2.3), new Vector3(1.5, 0, -1.4), 0.9], // dink from the kitchen line
    [new Vector3(-1, 1.6, 4), new Vector3(2.5, 0, -6), 0.5], // drive
    [new Vector3(0, 0.7, 6.9), new Vector3(-1.5, 0, -4.5), 1.1], // serve
  ];
  for (const [from, target, T] of cases) {
    it(`lands within 5cm of target and clears the net (${target.x}, ${target.z})`, () => {
      const sol = planShot({ from, target, flightTime: T, minNetClearance: 0.08 });
      expect(sol.converged).toBe(true);
      expect(Math.hypot(sol.landing.x - target.x, sol.landing.z - target.z)).toBeLessThan(0.05);
      expect(sol.netClearance).toBeGreaterThanOrEqual(0.08);
      // Verify with real physics including the net.
      const s = createBallState();
      launchBall(s, from, sol.velocity, sol.spin);
      const pred = predictLanding(s)!;
      expect(pred.hitsNet).toBe(false);
      expect(Math.hypot(pred.point.x - target.x, pred.point.z - target.z)).toBeLessThan(0.05);
    });
  }
});
