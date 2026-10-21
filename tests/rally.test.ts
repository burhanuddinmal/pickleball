import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { RallyManager } from '../src/game/RallyManager';
import { distanceToNearestLine, judgeBounce, judgeRest, isInsideCourt, isGamePoint, matchWinner } from '../src/gameplay/RuleManager';
import { AIController, AI_PROFILES, type AIProfile, type Difficulty } from '../src/players/AIController';
import { Athlete } from '../src/players/Athlete';
import { emptyIntent, type InputContext, type InputProvider, type PlayerIntent } from '../src/players/InputProvider';
import { PlayerController } from '../src/players/PlayerController';
import { COURT, FAR, NEAR, PLAYER, SIM } from '../src/utils/Constants';
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

  it('measures distance to the nearest sideline or baseline', () => {
    expect(distanceToNearestLine(0, 0)).toBeCloseTo(COURT.HALF_WIDTH);
    expect(distanceToNearestLine(COURT.HALF_WIDTH - 0.05, 1)).toBeCloseTo(0.05);
    expect(distanceToNearestLine(-COURT.HALF_WIDTH - 0.08, -2)).toBeCloseTo(0.08);
    expect(distanceToNearestLine(0.5, -(COURT.HALF_LENGTH - 0.03))).toBeCloseTo(0.03);
    expect(distanceToNearestLine(0, COURT.HALF_LENGTH + 0.2)).toBeCloseTo(0.2);
    // Beyond a corner: distance to the corner itself, not to the extended line.
    expect(distanceToNearestLine(COURT.HALF_WIDTH + 0.3, COURT.HALF_LENGTH + 0.4)).toBeCloseTo(0.5);
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

/** Stands still, holds the serve for `hold` seconds, then serves diagonally. Never returns a ball. */
class ScriptedServer implements InputProvider {
  private intent = emptyIntent();
  private t = 0;
  constructor(private hold: number) {}
  update(ctx: InputContext, dt: number): void {
    this.intent.swing = false;
    if (!ctx.isServing) return;
    this.t += dt;
    if (this.t > this.hold) {
      this.intent.aimX = (ctx.serveFromRight ? -1 : 1) * 0.5;
      this.intent.aimDepth = 0.8;
      this.intent.swing = true;
    }
  }
  getIntent(): PlayerIntent {
    return this.intent;
  }
  reset(): void {
    this.t = 0;
  }
}

describe('AI receiving serve', () => {
  function setup(profile: AIProfile, hold = 1) {
    const server = new Athlete('s', NEAR, 'Server');
    const receiver = new Athlete('r', FAR, 'Receiver');
    const ai = new AIController(profile, 5);
    const rally = new RallyManager([new PlayerController(server, new ScriptedServer(hold)), new PlayerController(receiver, ai)], new Rng(5));
    return { server, receiver, ai, rally };
  }

  it('rerolls a whiff each rally instead of missing every later serve', () => {
    const { server, ai, rally } = setup({ ...AI_PROFILES.medium, whiff: 1 });
    expect(playRally(rally, server, true).shots).toBe(1);
    ai.profile = { ...AI_PROFILES.medium, whiff: 0 };
    expect(playRally(rally, server, false).shots).toBeGreaterThanOrEqual(2);
  });

  it('waits in the diagonal service court while the server holds the ball', () => {
    for (const fromRight of [true, false]) {
      const { server, receiver, rally } = setup(AI_PROFILES.medium, 3);
      rally.startServe(server, fromRight);
      while (rally.phase === 'serve') rally.tick(SIM.TICK_DT);
      const lateral = receiver.pos.x * receiver.side;
      expect(Math.abs(lateral - (fromRight ? PLAYER.SERVE_LATERAL : -PLAYER.SERVE_LATERAL))).toBeLessThan(0.3);
    }
  });
});

/** Swings once, immediately, at nothing. */
class ScriptedWhiff implements InputProvider {
  private intent = emptyIntent();
  private swung = false;
  update(): void {
    this.intent.swing = !this.swung;
    this.swung = true;
  }
  getIntent(): PlayerIntent {
    return this.intent;
  }
}

describe('swing events', () => {
  it('reports when each swing ends, flagging whiffs', () => {
    const server = new Athlete('s', NEAR, 'Server');
    const receiver = new Athlete('r', FAR, 'Receiver');
    const rally = new RallyManager([new PlayerController(server, new ScriptedServer(0.6)), new PlayerController(receiver, new ScriptedWhiff())], new Rng(5));
    const ends: { who: string; kind: string; contact: boolean }[] = [];
    rally.bus.on('swingEnd', (e) => ends.push({ who: e.athlete.id, kind: e.kind, contact: e.contact }));
    rally.startServe(server, true);
    for (let i = 0; i < 160; i++) rally.tick(SIM.TICK_DT);
    expect(ends).toEqual([
      { who: 'r', kind: 'stroke', contact: false },
      { who: 's', kind: 'serve', contact: true },
    ]);
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
