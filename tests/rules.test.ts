import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { RallyManager } from '../src/game/RallyManager';
import {
  applyRallyResult,
  hasGamePoint,
  isInKitchen,
  isLegalServePosition,
  judgeContact,
  judgeMomentum,
  judgeServeLanding,
  judgeServePosition,
  newScore,
  type RallyEndReason,
  type ScoreState,
} from '../src/gameplay/RuleManager';
import { solveShot } from '../src/gameplay/ShotSystem';
import { Athlete } from '../src/players/Athlete';
import { emptyIntent, type InputContext, type InputProvider, type PlayerIntent } from '../src/players/InputProvider';
import { FREE_BOUNDS, PlayerController } from '../src/players/PlayerController';
import { COURT, FAR, NEAR, PLAYER, RULES, SIM } from '../src/utils/Constants';
import { Rng } from '../src/utils/MathUtils';

const K = COURT.KITCHEN_DEPTH;
const HL = COURT.HALF_LENGTH;
const HW = COURT.HALF_WIDTH;

/** Ground point on the receiving (far) side for a NEAR server, in the receiver's own frame. */
const farPoint = (lateral: number, depth: number) => ({ x: lateral * FAR, z: depth * FAR });

describe('serve must land in the diagonal service court', () => {
  it('accepts a serve deep in the correct court (right and left)', () => {
    // Serving from the right lands in the receiver's right court (positive receiver-relative lateral).
    expect(judgeServeLanding(NEAR, true, farPoint(1.5, 5))).toBeNull();
    expect(judgeServeLanding(NEAR, false, farPoint(-1.5, 5))).toBeNull();
    expect(judgeServeLanding(FAR, true, { x: 1.5, z: 5 })).toBeNull();
  });

  it('faults a serve into the kitchen, including the kitchen line', () => {
    expect(judgeServeLanding(NEAR, true, farPoint(1.5, 1.0))).toMatchObject({ reason: 'SERVE_IN_KITCHEN', winner: FAR, faultBy: NEAR });
    expect(judgeServeLanding(NEAR, true, farPoint(1.5, K))).toMatchObject({ reason: 'SERVE_IN_KITCHEN' });
    expect(judgeServeLanding(NEAR, true, farPoint(1.5, K + 0.005))).toMatchObject({ reason: 'SERVE_IN_KITCHEN' });
    expect(judgeServeLanding(NEAR, true, farPoint(1.5, K + 0.05))).toBeNull();
  });

  it('faults a serve into the wrong half; the centerline is in', () => {
    expect(judgeServeLanding(NEAR, true, farPoint(-1.0, 5))).toMatchObject({ reason: 'SERVE_WRONG_COURT', winner: FAR });
    expect(judgeServeLanding(NEAR, false, farPoint(1.0, 5))).toMatchObject({ reason: 'SERVE_WRONG_COURT' });
    expect(judgeServeLanding(NEAR, true, farPoint(0, 5))).toBeNull();
    expect(judgeServeLanding(NEAR, true, farPoint(-0.005, 5))).toBeNull();
  });

  it('baseline and sideline are in; beyond them is out', () => {
    expect(judgeServeLanding(NEAR, true, farPoint(1, HL))).toBeNull();
    expect(judgeServeLanding(NEAR, true, farPoint(HW, 5))).toBeNull();
    expect(judgeServeLanding(NEAR, true, farPoint(1, HL + 0.05))).toMatchObject({ reason: 'OUT_OF_BOUNDS' });
    expect(judgeServeLanding(NEAR, true, farPoint(HW + 0.05, 5))).toMatchObject({ reason: 'OUT_OF_BOUNDS' });
  });

  it("a serve that stays on the server's side is a net fault", () => {
    expect(judgeServeLanding(NEAR, true, { x: 0.5, z: 0.3 })).toMatchObject({ reason: 'NET', winner: FAR });
  });
});

describe('kitchen geometry', () => {
  it('a foot in the kitchen or on its line counts as in the kitchen', () => {
    expect(isInKitchen(NEAR, { x: 0, z: 1 })).toBe(true);
    expect(isInKitchen(NEAR, { x: 0, z: K + PLAYER.FOOT_RADIUS - 0.01 })).toBe(true); // toe on the line
    expect(isInKitchen(NEAR, { x: 0, z: K + PLAYER.FOOT_RADIUS + 0.05 })).toBe(false);
    expect(isInKitchen(FAR, { x: 1, z: -1 })).toBe(true);
    expect(isInKitchen(FAR, { x: 1, z: 1 })).toBe(false); // other side of the net
  });

  it('outside the sidelines is not the kitchen', () => {
    expect(isInKitchen(NEAR, { x: HW + 0.5, z: 1 })).toBe(false);
  });
});

describe('two-bounce rule and kitchen volleys', () => {
  const at = (depth: number) => ({ x: 0, z: depth });

  it('volleying the return of serve is a fault', () => {
    expect(judgeContact({ hitterSide: FAR, shotIndex: 1, bouncesSinceHit: 0, hitterPos: { x: 0, z: -5 } })).toMatchObject({
      reason: 'TWO_BOUNCE_VIOLATION',
      winner: NEAR,
      faultBy: FAR,
    });
  });

  it('volleying the third shot is a fault', () => {
    expect(judgeContact({ hitterSide: NEAR, shotIndex: 2, bouncesSinceHit: 0, hitterPos: at(5) })).toMatchObject({ reason: 'TWO_BOUNCE_VIOLATION' });
  });

  it('the return and third shot are fine after a bounce; volleys are allowed from shot 4 on', () => {
    expect(judgeContact({ hitterSide: FAR, shotIndex: 1, bouncesSinceHit: 1, hitterPos: { x: 0, z: -5 } })).toBeNull();
    expect(judgeContact({ hitterSide: NEAR, shotIndex: 2, bouncesSinceHit: 1, hitterPos: at(5) })).toBeNull();
    expect(judgeContact({ hitterSide: FAR, shotIndex: 3, bouncesSinceHit: 0, hitterPos: { x: 0, z: -4 } })).toBeNull();
  });

  it('volleying from the kitchen or its line is a fault', () => {
    expect(judgeContact({ hitterSide: NEAR, shotIndex: 3, bouncesSinceHit: 0, hitterPos: at(1.2) })).toMatchObject({ reason: 'KITCHEN_VOLLEY', winner: FAR });
    expect(judgeContact({ hitterSide: NEAR, shotIndex: 5, bouncesSinceHit: 0, hitterPos: at(K + 0.05) })).toMatchObject({ reason: 'KITCHEN_VOLLEY' });
  });

  it('a ball that bounced in the kitchen may be played from inside it', () => {
    expect(judgeContact({ hitterSide: NEAR, shotIndex: 4, bouncesSinceHit: 1, hitterPos: at(1.0) })).toBeNull();
  });

  it('stepping into the kitchen right after a volley is a momentum fault', () => {
    expect(judgeMomentum(NEAR, at(1.5), 0.2)).toMatchObject({ reason: 'KITCHEN_VOLLEY', winner: FAR });
    expect(judgeMomentum(NEAR, at(1.5), RULES.MOMENTUM_WINDOW + 0.01)).toBeNull();
    expect(judgeMomentum(NEAR, at(4), 0.1)).toBeNull();
    expect(judgeMomentum(NEAR, at(1.5), Infinity)).toBeNull();
  });
});

describe('server position (foot fault)', () => {
  const behind = HL + PLAYER.FOOT_RADIUS + 0.05;

  it('server must be behind the baseline, in the correct half', () => {
    expect(isLegalServePosition(NEAR, true, { x: 1.2, z: behind })).toBe(true);
    expect(isLegalServePosition(NEAR, false, { x: -1.2, z: behind })).toBe(true);
    expect(isLegalServePosition(FAR, true, { x: -1.2, z: -behind })).toBe(true);
  });

  it('touching the baseline or stepping into the court is a foot fault', () => {
    expect(judgeServePosition(NEAR, true, { x: 1.2, z: HL })).toMatchObject({ reason: 'FOOT_FAULT', winner: FAR, faultBy: NEAR });
    expect(judgeServePosition(NEAR, true, { x: 1.2, z: HL - 0.5 })).toMatchObject({ reason: 'FOOT_FAULT' });
  });

  it('serving from beyond the centerline or sideline extension is a foot fault', () => {
    expect(isLegalServePosition(NEAR, true, { x: -0.3, z: behind })).toBe(false);
    expect(isLegalServePosition(NEAR, true, { x: HW + 0.3, z: behind })).toBe(false);
    expect(isLegalServePosition(NEAR, false, { x: 0.3, z: behind })).toBe(false);
  });
});

describe('side-out scoring', () => {
  const s = (near: number, far: number, server: 1 | -1): ScoreState => ({ near, far, server, fromRight: (server === 1 ? near : far) % 2 === 0 });

  it('only the server scores', () => {
    expect(applyRallyResult(newScore(NEAR), NEAR, 'sideout')).toEqual({ near: 1, far: 0, server: NEAR, fromRight: false });
  });

  it('a lost rally on serve is a side out: no point, serve changes hands', () => {
    expect(applyRallyResult(s(3, 2, NEAR), FAR, 'sideout')).toEqual({ near: 3, far: 2, server: FAR, fromRight: true });
    expect(applyRallyResult(s(3, 5, NEAR), FAR, 'sideout')).toMatchObject({ far: 5, server: FAR, fromRight: false });
  });

  it("serves from the right on an even server score, the left on an odd one", () => {
    let st = newScore(NEAR);
    const sides: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      st = applyRallyResult(st, NEAR, 'sideout');
      sides.push(st.fromRight);
    }
    expect(sides).toEqual([false, true, false, true]);
  });

  it('rally scoring: every rally scores and the winner serves', () => {
    expect(applyRallyResult(s(3, 2, NEAR), FAR, 'rally')).toEqual({ near: 3, far: 3, server: FAR, fromRight: false });
  });

  it('game point only belongs to the server under side-out', () => {
    expect(hasGamePoint(s(10, 4, NEAR), NEAR, 11, 'sideout')).toBe(true);
    expect(hasGamePoint(s(4, 10, NEAR), FAR, 11, 'sideout')).toBe(false);
    expect(hasGamePoint(s(4, 10, NEAR), FAR, 11, 'rally')).toBe(true);
    expect(hasGamePoint(s(10, 10, NEAR), NEAR, 11, 'sideout')).toBe(false); // win by 2
  });
});

// ---------------------------------------------------------------- rules applied in a live rally

/** Serves to a fixed spot when told to; `swingNow` triggers a stroke on the next tick. */
class Scripted implements InputProvider {
  private intent = emptyIntent();
  swingNow = false;
  serveAfter = 0.3;
  private t = 0;
  update(ctx: InputContext, dt: number): void {
    this.intent.swing = false;
    if (ctx.isServing) {
      this.t += dt;
      if (this.t > this.serveAfter) {
        this.intent.aimX = (ctx.serveFromRight ? -1 : 1) * 0.5;
        this.intent.aimDepth = 0.8;
        this.intent.swing = true;
        this.t = -999;
      }
    } else if (this.swingNow) {
      this.intent.swing = true;
      this.swingNow = false;
    }
  }
  getIntent(): PlayerIntent {
    return this.intent;
  }
  reset(): void {
    this.t = 0;
  }
}

function setup() {
  const server = new Athlete('s', NEAR, 'Server');
  const receiver = new Athlete('r', FAR, 'Receiver');
  const sIn = new Scripted();
  const rIn = new Scripted();
  const sCtl = new PlayerController(server, sIn);
  const rCtl = new PlayerController(receiver, rIn);
  const rally = new RallyManager([sCtl, rCtl], new Rng(9));
  return { server, receiver, sIn, rIn, sCtl, rCtl, rally };
}

function runUntilDead(rally: RallyManager, each?: () => void, maxTicks = 120 * 10): RallyEndReason | undefined {
  for (let i = 0; i < maxTicks && rally.phase !== 'dead'; i++) {
    each?.();
    rally.tick(SIM.TICK_DT);
  }
  return rally.outcome?.reason;
}

/** Puts the receiver beside the ball (within reach) and swings once the ball reaches `depth` on the fly. */
function volleyAt(rally: RallyManager, receiver: Athlete, rIn: Scripted, depth: number, standDepth = depth) {
  let done = false;
  return () => {
    const b = rally.ball.state.pos;
    if (done || rally.phase !== 'live' || rally.bouncesSinceHit > 0 || rally.lastHitter === receiver) return;
    if (b.z * receiver.side >= depth) {
      receiver.pos.set(b.x + 0.4, 0, standDepth * receiver.side);
      rIn.swingNow = true;
      done = true;
    }
  };
}

describe('rules in a live rally', () => {
  it('volleying the return of serve ends the rally with a two-bounce fault', () => {
    const { server, receiver, rIn, rally } = setup();
    rally.startServe(server, true);
    const reason = runUntilDead(rally, volleyAt(rally, receiver, rIn, K + 1));
    expect(reason).toBe('TWO_BOUNCE_VIOLATION');
    expect(rally.outcome).toMatchObject({ winner: NEAR, faultBy: FAR });
  });

  it('volleying from the kitchen (once volleys are allowed) is a kitchen fault', () => {
    const { server, receiver, rIn, rally } = setup();
    rally.startServe(server, true);
    let bumped = false;
    const volley = volleyAt(rally, receiver, rIn, 0.8, 1.0);
    const reason = runUntilDead(rally, () => {
      // Pretend we're deep in a rally so the two-bounce rule no longer applies.
      if (!bumped && rally.phase === 'live') {
        rally.shotIndex = 3;
        bumped = true;
      }
      volley();
    });
    expect(reason).toBe('KITCHEN_VOLLEY');
    expect(rally.outcome?.faultBy).toBe(FAR);
  });

  it('stepping into the kitchen just after a legal volley is a momentum fault', () => {
    const { server, receiver, rIn, rally } = setup();
    rally.startServe(server, true);
    let bumped = false;
    let volleyed = -1;
    const volley = volleyAt(rally, receiver, rIn, K + 0.6, K + 0.6);
    const reason = runUntilDead(rally, () => {
      if (!bumped && rally.phase === 'live') {
        rally.shotIndex = 3;
        bumped = true;
      }
      volley();
      if (volleyed < 0 && rally.lastHitter === receiver) volleyed = rally.rallyTime;
      // Follow-through carries the receiver into the kitchen 0.2 s after the volley.
      if (volleyed >= 0 && rally.rallyTime - volleyed > 0.2) receiver.pos.z = -1.2;
    });
    expect(reason).toBe('KITCHEN_VOLLEY');
  });

  it('a serve that lands in the kitchen is a fault', () => {
    const { server, rally } = setup();
    rally.startServe(server, true);
    const reason = runUntilDead(rally, () => {
      if (rally.phase === 'live' && rally.shotIndex === 1 && rally.ball.state.pos.z > 0 && rally.ball.state.vel.z < -5) {
        // Replace the served ball with a short dink into the receiver's kitchen (diagonal half).
        const from = rally.ball.state.pos.clone();
        const sol = solveShot({ from, target: new Vector3(-1.0, 0, -1.2), flightTime: 0.9 });
        rally.ball.launch(from, sol.velocity, sol.spin);
      }
    });
    expect(reason).toBe('SERVE_IN_KITCHEN');
    expect(rally.outcome?.winner).toBe(FAR);
  });

  it('serving from inside the baseline is a foot fault', () => {
    const { server, sCtl, rally } = setup();
    rally.startServe(server, true);
    sCtl.bounds = FREE_BOUNDS;
    server.pos.z = HL - 0.3;
    expect(runUntilDead(rally)).toBe('FOOT_FAULT');
  });

  it('a legal serve from the default spot is not a foot fault', () => {
    const { server, rally } = setup();
    rally.startServe(server, false);
    // Nobody returns: the serve bounces twice.
    expect(runUntilDead(rally)).toBe('MISS');
    expect(rally.outcome?.winner).toBe(NEAR);
  });
});

describe('AI follows the same rules', () => {
  it('never volleys illegally, foot-faults or misses the service court, and uses power shots', async () => {
    const { AIController, AI_PROFILES } = await import('../src/players/AIController');
    const reasons: Record<string, number> = {};
    let powerHits = 0;
    for (const d of ['easy', 'medium', 'hard', 'expert'] as const) {
      const a = new Athlete('a', NEAR, 'A');
      const b = new Athlete('b', FAR, 'B');
      const rally = new RallyManager(
        [new PlayerController(a, new AIController(AI_PROFILES[d], 11)), new PlayerController(b, new AIController(AI_PROFILES[d], 17))],
        new Rng(23),
      );
      rally.bus.on('hit', (e) => (powerHits += e.power ? 1 : 0));
      for (let i = 0; i < 25; i++) {
        rally.startServe(i % 2 ? a : b, i % 4 < 2);
        const r = runUntilDead(rally, undefined, 120 * 70);
        reasons[r!] = (reasons[r!] ?? 0) + 1;
      }
    }
    // (Long expert rallies can reach the 60 s safety cap; stalls are covered in rally.test.ts.)
    for (const bad of ['TWO_BOUNCE_VIOLATION', 'KITCHEN_VOLLEY', 'FOOT_FAULT', 'SERVE_IN_KITCHEN', 'SERVE_WRONG_COURT']) {
      expect(reasons[bad] ?? 0, bad).toBe(0);
    }
    expect(powerHits).toBeGreaterThan(0);
  });
});
