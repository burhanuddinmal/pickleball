import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { RallyManager } from '../src/game/RallyManager';
import { defaultAim, directionalAim, pointAim, ROW_DEPTH, SIDE_COLUMN_X, snapAim, swipeAim } from '../src/gameplay/Aim';
import { aimErrorScale, buildStroke, contactQuality, strokeKind } from '../src/gameplay/ShotSystem';
import { SwipeTracker, swipePower } from '../src/gameplay/Swipe';
import { createBallState, launchBall } from '../src/physics/BallPhysics';
import { predictLanding } from '../src/physics/Trajectory';
import { Athlete } from '../src/players/Athlete';
import { emptyIntent, type InputContext, type InputProvider, type PlayerIntent } from '../src/players/InputProvider';
import { PlayerController } from '../src/players/PlayerController';
import { AIM, COURT, FAR, NEAR, PHYSICS, PLAYER, POWER, SIM, SWIPE } from '../src/utils/Constants';
import { aimToWorld, Rng } from '../src/utils/MathUtils';

// ---------------------------------------------------------------- movement feel

/** Holds a fixed stick direction; can swing on demand. */
class Stick implements InputProvider {
  intent = emptyIntent();
  update(): void {}
  getIntent(): PlayerIntent {
    return this.intent;
  }
}

function ctxFor(a: Athlete, ball = new Vector3(0, 1, -5), ballVel = new Vector3()): InputContext {
  return {
    side: a.side,
    selfPos: a.pos,
    opponentPos: new Vector3(0, 0, -6),
    ballPos: ball,
    ballVel,
    ballLive: false,
    lastHitterSide: null,
    bouncesSinceHit: 0,
    shotIndex: 0,
    mustLetBounce: false,
    isServing: false,
    isReceiving: false,
    serveFromRight: true,
    time: 0,
  };
}

function mover() {
  const a = new Athlete('p', NEAR, 'P');
  a.pos.set(0, 0, 5);
  const stick = new Stick();
  const c = new PlayerController(a, stick);
  return { a, stick, c, ctx: ctxFor(a) };
}

const run = (c: PlayerController, ctx: InputContext, seconds: number) => {
  for (let t = 0; t < seconds - 1e-9; t += SIM.TICK_DT) c.tick(ctx, SIM.TICK_DT);
};

describe('movement responsiveness', () => {
  it('moves visibly within one 60 Hz frame and reaches run speed in under 0.07 s', () => {
    const { a, stick, c, ctx } = mover();
    stick.intent.moveX = 1;
    run(c, ctx, 1 / 60);
    expect(a.pos.x).toBeGreaterThan(0.008);
    run(c, ctx, 0.05);
    expect(a.vel.x).toBeCloseTo(PLAYER.RUN_SPEED, 5);
  });

  it('reverses direction at full speed in about 0.1 s', () => {
    const { a, stick, c, ctx } = mover();
    stick.intent.moveX = 1;
    run(c, ctx, 0.3);
    stick.intent.moveX = -1;
    run(c, ctx, 0.1);
    expect(a.vel.x).toBeLessThan(-PLAYER.RUN_SPEED * 0.95);
  });

  it('stops with a short skid when the stick is released', () => {
    const { a, stick, c, ctx } = mover();
    stick.intent.moveX = 1;
    run(c, ctx, 0.3);
    const x0 = a.pos.x;
    stick.intent.moveX = 0;
    run(c, ctx, 0.25);
    expect(a.vel.x).toBe(0);
    const skid = a.pos.x - x0;
    expect(skid).toBeGreaterThan(0.1);
    expect(skid).toBeLessThan(0.3);
  });

  it('slows to 80% only inside the contact window, not the whole swing', () => {
    const { a, stick, c, ctx } = mover();
    stick.intent.moveX = 1;
    run(c, ctx, 0.3);
    stick.intent.swing = true;
    c.tick(ctx, SIM.TICK_DT);
    stick.intent.swing = false;
    run(c, ctx, 0.1);
    expect(a.vel.x).toBeCloseTo(PLAYER.RUN_SPEED * PLAYER.SWING_SPEED_MUL, 5);
    run(c, ctx, PLAYER.CONTACT_WINDOW); // past the contact window, still mid-swing
    expect(a.swing.active).toBe(true);
    expect(a.vel.x).toBeCloseTo(PLAYER.RUN_SPEED, 5);
  });

  it('turns to face the ball quickly', () => {
    const { a, c } = mover();
    const ctx = ctxFor(a, new Vector3(3, 1, 3));
    ctx.ballLive = true;
    run(c, ctx, 0.15);
    const target = 0.9 * 0.6; // facing turns up to 0.54 rad toward a ball off to the side
    expect(Math.abs(a.facing)).toBeGreaterThan(target * 0.9);
  });

  it('auto-steps toward a ball passing just out of reach when the swing starts', () => {
    const { a, stick, c } = mover();
    // Ball flying across in front of the player, passing ~1.35 m away.
    const ball = new Vector3(-1.35 - 2, 1.0, 5 - 0.3);
    const ctx = ctxFor(a, ball, new Vector3(10, 0, 0));
    ctx.ballLive = true;
    ctx.lastHitterSide = FAR;
    ctx.bouncesSinceHit = 1;
    // Move the ball to just before its closest approach, then swing.
    ball.x = -0.6;
    ball.z = 5 - 1.35;
    ctx.ballVel.set(10, 0, 0);
    stick.intent.swing = true;
    c.tick(ctx, SIM.TICK_DT);
    stick.intent.swing = false;
    const z0 = 5;
    run(c, ctx, PLAYER.AUTO_STEP_TIME + 0.02);
    const stepped = z0 - a.pos.z;
    expect(stepped).toBeGreaterThan(0.1);
    expect(stepped).toBeLessThanOrEqual(PLAYER.AUTO_STEP + 1e-6);
  });

  it('does not auto-step when the ball is already in reach or far away', () => {
    for (const offset of [0.8, 2.5]) {
      const { a, stick, c } = mover();
      const ctx = ctxFor(a, new Vector3(-0.3, 1, 5 - offset), new Vector3(10, 0, 0));
      ctx.ballLive = true;
      ctx.lastHitterSide = FAR;
      stick.intent.swing = true;
      c.tick(ctx, SIM.TICK_DT);
      stick.intent.swing = false;
      run(c, ctx, 0.2);
      expect(a.pos.z).toBeCloseTo(5, 6);
    }
  });
});

// ---------------------------------------------------------------- aiming

describe('direction-at-hit aiming', () => {
  it('target zones sit AIM.INSET inside the lines', () => {
    const right = aimToWorld(NEAR, SIDE_COLUMN_X, ROW_DEPTH[1]);
    expect(COURT.HALF_WIDTH - Math.abs(right.x)).toBeCloseTo(AIM.INSET);
    expect(COURT.HALF_LENGTH - Math.abs(right.z)).toBeCloseTo(AIM.INSET);
    const short = aimToWorld(NEAR, 0, ROW_DEPTH[-1]);
    expect(Math.abs(short.z) - COURT.KITCHEN_DEPTH).toBeCloseTo(AIM.SHORT_PAST_KITCHEN);
  });

  it('snaps any aim to the 3×3 grid', () => {
    expect(snapAim(0.9, 1.0)).toEqual({ aimX: SIDE_COLUMN_X, aimDepth: ROW_DEPTH[1] });
    expect(snapAim(-0.6, 0.35)).toEqual({ aimX: -SIDE_COLUMN_X, aimDepth: ROW_DEPTH[-1] });
    expect(snapAim(0.1, 0.62)).toEqual({ aimX: 0, aimDepth: ROW_DEPTH[0] });
    expect(snapAim(1.4, 1.3)).toEqual({ aimX: SIDE_COLUMN_X, aimDepth: ROW_DEPTH[1] }); // pulled back inside
  });

  it('movement keys held at the swing pick left/center/right × deep/short', () => {
    expect(directionalAim(1, 0, NEAR, 0)).toEqual({ aimX: SIDE_COLUMN_X, aimDepth: ROW_DEPTH[1] });
    expect(directionalAim(-1, -1, NEAR, 0)).toEqual({ aimX: -SIDE_COLUMN_X, aimDepth: ROW_DEPTH[-1] });
    expect(directionalAim(0, -1, NEAR, 0).aimDepth).toBe(ROW_DEPTH[-1]);
    expect(directionalAim(0.1, 1, NEAR, 0).aimDepth).toBe(ROW_DEPTH[1]);
  });

  it('with nothing held, aims deep and slightly away from the opponent', () => {
    // Opponent on the far side at world x = +1 is on the near hitter's right (aimX > 0).
    const a = directionalAim(0, 0, NEAR, 1);
    expect(a.aimDepth).toBe(ROW_DEPTH[1]);
    expect(a.aimX).toBeCloseTo(-AIM.DEFAULT_AWAY);
    expect(defaultAim(NEAR, -1).aimX).toBeCloseTo(AIM.DEFAULT_AWAY);
    // Same opponent from the far hitter's point of view is on their left.
    expect(defaultAim(FAR, 1).aimX).toBeCloseTo(AIM.DEFAULT_AWAY);
  });

  it('touch swipes need a clear lean and a minimum length, then snap', () => {
    expect(swipeAim(10, -8, NEAR, 0)).toEqual(defaultAim(NEAR, 0)); // too short: a tap
    expect(swipeAim(80, 0, NEAR, 0)).toEqual({ aimX: SIDE_COLUMN_X, aimDepth: ROW_DEPTH[0] });
    expect(swipeAim(20, -80, NEAR, 0)).toEqual({ aimX: 0, aimDepth: ROW_DEPTH[1] }); // mostly up
    expect(swipeAim(-25, 75, NEAR, 0)).toEqual({ aimX: 0, aimDepth: ROW_DEPTH[-1] }); // mostly down
    expect(swipeAim(-60, -60, NEAR, 0)).toEqual({ aimX: -SIDE_COLUMN_X, aimDepth: ROW_DEPTH[1] });
  });

  it('a mouse click on the far court converts back to that zone', () => {
    const p = aimToWorld(NEAR, -SIDE_COLUMN_X, ROW_DEPTH[-1]);
    expect(pointAim(NEAR, p.x + 0.3, p.z - 0.2)).toEqual({ aimX: -SIDE_COLUMN_X, aimDepth: ROW_DEPTH[-1] });
  });
});

// ---------------------------------------------------------------- timing quality and power

const spread = (quality: number, power = 0, y = 0.9) => {
  const rng = new Rng(7);
  const xs: number[] = [];
  for (let i = 0; i < 200; i++) {
    const s = buildStroke(new Vector3(0, y, 5), NEAR, 0, 0.7, rng, { quality, power });
    xs.push(s.landing.x);
  }
  const m = xs.reduce((a, b) => a + b) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

describe('timing quality drives shot error', () => {
  it('sweet-spot timing at a comfortable reach is a perfect contact; late or stretched is worse', () => {
    expect(contactQuality(0.08, 0.6)).toBe(1);
    expect(contactQuality(0.24, 0.6)).toBeLessThan(0.3);
    expect(contactQuality(0.08, 1.0)).toBeCloseTo(0.4);
    expect(contactQuality(0.0, 0.6)).toBeCloseTo(0.75);
  });

  it('well-timed hits are tighter than the old fixed error; late ones are looser', () => {
    expect(aimErrorScale(1, 0)).toBeLessThan(1);
    expect(aimErrorScale(0, 0)).toBeGreaterThan(1);
    expect(spread(1)).toBeLessThan(spread(0) * 0.4);
  });

  it('power adds a little aim error', () => {
    expect(aimErrorScale(0.8, 1)).toBeGreaterThan(aimErrorScale(0.8, 0));
  });
});

describe('power shots', () => {
  const contact = new Vector3(0, 0.95, 5);

  it('a charged shot is faster and flatter than a normal one', () => {
    const normal = buildStroke(contact, NEAR, 0, 0.85, new Rng(3), { quality: 1, power: 0 });
    const power = buildStroke(contact, NEAR, 0, 0.85, new Rng(3), { quality: 1, power: 1 });
    expect(power.velocity.length()).toBeGreaterThan(normal.velocity.length() * 1.3);
    expect(power.velocity.length()).toBeLessThanOrEqual(PHYSICS.MAX_SPEED + 1e-6);
    expect(power.apex).toBeLessThan(normal.apex);
    expect(power.flightTime).toBeLessThan(normal.flightTime);
    expect(power.spin.length()).toBeGreaterThan(normal.spin.length());
  });

  it('below the minimum charge it is a normal shot; overhead it becomes a smash', () => {
    expect(strokeKind(1.0, POWER.MIN - 0.01)).toBe('normal');
    expect(strokeKind(1.0, 0.8)).toBe('power');
    expect(strokeKind(POWER.SMASH_HEIGHT + 0.2, 0.8)).toBe('smash');
    expect(strokeKind(POWER.SMASH_HEIGHT + 0.2, 0)).toBe('normal');
  });

  it('a smash goes steeply down and fast', () => {
    const s = buildStroke(new Vector3(0, 2.0, 3), NEAR, 0, 0.9, new Rng(5), { quality: 1, power: 1 });
    expect(s.velocity.y).toBeLessThan(-1.5);
    expect(s.velocity.length()).toBeGreaterThan(18);
  });

  it('a power shot from below net height finds the net more often', () => {
    const netRate = (power: number) => {
      const rng = new Rng(11);
      const st = createBallState();
      let net = 0;
      for (let i = 0; i < 150; i++) {
        const from = new Vector3(0, 0.35, 4);
        const s = buildStroke(from, NEAR, 0, 0.9, rng, { quality: 0.6, power });
        launchBall(st, from, s.velocity, s.spin);
        if (predictLanding(st)?.hitsNet) net++;
      }
      return net / 150;
    };
    expect(netRate(1)).toBeGreaterThan(netRate(0) + 0.05);
  });

  it('recovery after a power swing is slower', () => {
    const a = new Athlete('p', NEAR, 'P');
    a.startSwing('stroke', 'forehand', 1);
    a.swing.contact = true;
    for (let t = 0; t <= PLAYER.SWING_DURATION + 0.01; t += SIM.TICK_DT) a.updateSwing(SIM.TICK_DT);
    expect(a.swingCooldown).toBeGreaterThan(POWER.RECOVERY - 0.02);
    a.resetSwing();
    a.startSwing('stroke', 'forehand', 0);
    a.swing.contact = true;
    for (let t = 0; t <= PLAYER.SWING_DURATION + 0.01; t += SIM.TICK_DT) a.updateSwing(SIM.TICK_DT);
    expect(a.swingCooldown).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------- hit event

/** Serves; on demand swings with a given charge. */
class Hitter implements InputProvider {
  private intent = emptyIntent();
  swingNow = false;
  power = 0;
  update(ctx: InputContext): void {
    this.intent.swing = false;
    this.intent.power = 0;
    if (ctx.isServing) {
      this.intent.aimX = ctx.serveFromRight ? -0.5 : 0.5;
      this.intent.aimDepth = 0.8;
      this.intent.swing = true;
    } else if (this.swingNow) {
      this.intent.swing = true;
      this.intent.power = this.power;
      this.swingNow = false;
    }
  }
  getIntent(): PlayerIntent {
    return this.intent;
  }
}

describe('swipe control style', () => {
  const SCREEN = 800;

  /** Pointer samples every 1/120 s moving straight up at `pxPerSec`, starting at `t0`. */
  const drag = (tr: SwipeTracker, from: { y: number; t: number }, pxPerSec: number, seconds: number) => {
    let { y, t } = from;
    const dt = 1 / 120;
    for (let k = 0; k < Math.round(seconds / dt); k++) {
      y -= pxPerSec * dt;
      t += dt;
      tr.move(0, y, t);
    }
    return { y, t };
  };

  it('measures the flick at release, not the average over the whole swipe', () => {
    const tr = new SwipeTracker();
    tr.start(0, 0, 0);
    const end = drag(tr, drag(tr, { y: 0, t: 0 }, 200, 0.5), 3000, 0.1);
    expect(tr.flickSpeed()).toBeCloseTo(3000, -2);
    expect(tr.delta().dy).toBeCloseTo(end.y, 6);
  });

  it('a pointer held still after the flick slows the live speed down', () => {
    const tr = new SwipeTracker();
    tr.start(0, 0, 0);
    const end = drag(tr, { y: 0, t: 0 }, 3000, 0.1);
    expect(tr.flickSpeed(end.t + SWIPE.SAMPLE_WINDOW * 2)).toBe(0);
  });

  it('maps speed to power: none when slow, rising, full when fast', () => {
    expect(swipePower(SWIPE.SLOW * SCREEN * 0.9, SCREEN)).toBe(0);
    expect(swipePower(SWIPE.FAST * SCREEN * 1.5, SCREEN)).toBe(1);
    let prev = -1;
    for (let v = SWIPE.SLOW; v <= SWIPE.FAST; v += 0.25) {
      const p = swipePower(v * SCREEN, SCREEN);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('a slow swipe plays a normal shot; a fast one a power shot, or a smash overhead', () => {
    const slow = swipePower(SWIPE.SLOW * SCREEN * 1.2, SCREEN);
    const fast = swipePower(SWIPE.FAST * SCREEN, SCREEN);
    expect(strokeKind(1.0, slow)).toBe('normal');
    expect(strokeKind(1.0, fast)).toBe('power');
    expect(strokeKind(POWER.SMASH_HEIGHT + 0.2, fast)).toBe('smash');
  });
});

describe('hit events carry an explicit power flag', () => {
  for (const [power, expected] of [
    [1, true],
    [0, false],
  ] as const) {
    it(`power ${power} -> power flag ${expected}`, () => {
      const server = new Athlete('s', NEAR, 'S');
      const receiver = new Athlete('r', FAR, 'R');
      const rIn = new Hitter();
      rIn.power = power;
      const rally = new RallyManager([new PlayerController(server, new Hitter()), new PlayerController(receiver, rIn)], new Rng(4));
      const hits: { athlete: string; power: boolean }[] = [];
      rally.bus.on('hit', (e) => hits.push({ athlete: e.athlete.id, power: e.power }));
      rally.startServe(server, true);
      let swung = false;
      for (let i = 0; i < 120 * 4 && rally.phase !== 'dead'; i++) {
        const b = rally.ball.state.pos;
        // After the serve bounces, put the receiver next to the ball and swing.
        if (!swung && rally.phase === 'live' && rally.bouncesSinceHit === 1 && rally.ball.state.vel.y < 0 && b.y < 1.0) {
          receiver.pos.set(b.x + 0.5, 0, b.z - 0.2);
          rIn.swingNow = true;
          swung = true;
        }
        rally.tick(SIM.TICK_DT);
      }
      expect(hits[0]).toEqual({ athlete: 's', power: false });
      expect(hits[1]).toEqual({ athlete: 'r', power: expected });
    });
  }
});
