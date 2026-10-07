import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { RallyManager } from '../src/game/RallyManager';
import { judgeBounce, judgeRest, isInsideCourt, isGamePoint, matchWinner } from '../src/gameplay/RuleManager';
import { AIController, AI_PROFILES, type Difficulty } from '../src/players/AIController';
import { Athlete } from '../src/players/Athlete';
import { PlayerController } from '../src/players/PlayerController';
import { COURT, FAR, NEAR, SIM } from '../src/utils/Constants';
import { Rng } from '../src/utils/MathUtils';

function makeRally(d1: Difficulty, d2: Difficulty, seed = 1) {
  const a = new Athlete('p1', NEAR, 'Near');
  const b = new Athlete('p2', FAR, 'Far');
  const rally = new RallyManager(
    [new PlayerController(a, new AIController(AI_PROFILES[d1], seed)), new PlayerController(b, new AIController(AI_PROFILES[d2], seed + 7))],
    new Rng(seed),
  );
  return { a, b, rally };
}

function playRally(rally: RallyManager, server: Athlete, fromRight: boolean) {
  rally.startServe(server, fromRight);
  let ticks = 0;
  while (rally.phase !== 'dead' && ticks < 120 * 90) {
    rally.tick(SIM.TICK_DT);
    ticks++;
  }
  return { outcome: rally.outcome, shots: rally.shotIndex, seconds: ticks * SIM.TICK_DT };
}

describe('rule basics (phase 1)', () => {
  it('line balls are in, just past the line is out', () => {
    expect(isInsideCourt(COURT.HALF_WIDTH, 0)).toBe(true);
    expect(isInsideCourt(0, -COURT.HALF_LENGTH)).toBe(true);
    expect(isInsideCourt(COURT.HALF_WIDTH + 0.05, 0)).toBe(false);
    expect(isInsideCourt(0, COURT.HALF_LENGTH + 0.05)).toBe(false);
  });

  it('first bounce out of bounds is the hitter fault', () => {
    expect(judgeBounce(NEAR, 1, new Vector3(0, 0, -7.5))).toMatchObject({ winner: FAR, reason: 'OUT_OF_BOUNDS' });
  });

  it('first bounce on the hitter side is a net fault', () => {
    expect(judgeBounce(NEAR, 1, new Vector3(0, 0, 0.5))).toMatchObject({ winner: FAR, reason: 'NET' });
  });

  it('good first bounce continues; second bounce wins it for the hitter', () => {
    expect(judgeBounce(NEAR, 1, new Vector3(1, 0, -4))).toBeNull();
    expect(judgeBounce(NEAR, 2, new Vector3(1, 0, -9))).toMatchObject({ winner: NEAR, reason: 'MISS' });
  });

  it('ball resting before any hit is a replay, never a point', () => {
    expect(judgeRest(null, new Vector3())).toMatchObject({ winner: null });
  });
});

describe('AI vs AI rallies', () => {
  it('rallies always end, produce exchanges, and never stall', () => {
    const { a, b, rally } = makeRally('hard', 'hard', 3);
    let server = a;
    let right = true;
    let totalShots = 0;
    let longest = 0;
    const reasons: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      const r = playRally(rally, server, right);
      expect(r.outcome).not.toBeNull();
      expect(r.seconds).toBeLessThan(61);
      reasons[r.outcome!.reason] = (reasons[r.outcome!.reason] ?? 0) + 1;
      totalShots += r.shots;
      longest = Math.max(longest, r.shots);
      if (r.outcome!.winner !== null) {
        const w = r.outcome!.winner === a.side ? a : b;
        right = w === server ? !right : true;
        server = w;
      }
    }
    console.log('reasons', reasons, 'avg shots', totalShots / 40, 'longest', longest);
    expect(reasons.BALL_STUCK ?? 0).toBe(0);
    expect(totalShots / 40).toBeGreaterThan(3);
    expect(longest).toBeGreaterThan(6);
  });
});

describe('match scoring', () => {
  it('first to the target wins, but only by 2', () => {
    expect(matchWinner(11, 9, 11)).toBe('a');
    expect(matchWinner(11, 10, 11)).toBeNull();
    expect(matchWinner(12, 10, 11)).toBe('a');
    expect(matchWinner(5, 7, 7)).toBe('b');
    expect(matchWinner(20, 21, 21)).toBeNull();
    expect(matchWinner(34, 2, 11)).toBe('a');
  });

  it('flags game point', () => {
    expect(isGamePoint(10, 5, 11)).toBe(true);
    expect(isGamePoint(10, 10, 11)).toBe(false);
    expect(isGamePoint(6, 0, 7)).toBe(true);
  });
});
