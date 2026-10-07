import { Vector3 } from 'three';
import { createBallState } from '../physics/BallPhysics';
import { samplePath, type PathSample } from '../physics/Trajectory';
import { COURT, PLAYER } from '../utils/Constants';
import { clamp, Rng } from '../utils/MathUtils';
import { emptyIntent, type InputContext, type InputProvider, type PlayerIntent } from './InputProvider';

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';

export interface AIProfile {
  /** Seconds before the AI reacts to a new shot. */
  reaction: number;
  /** Multiplier on max run speed. */
  speed: number;
  /** Std-dev of aim error in normalized aim units. */
  aimError: number;
  /** How far inside the lines the AI aims (normalized). */
  safety: number;
  /** Probability of a mistimed / mis-read ball on a difficult shot. */
  whiff: number;
  serveDelay: number;
}

export const AI_PROFILES: Record<Difficulty, AIProfile> = {
  easy: { reaction: 0.34, speed: 0.72, aimError: 0.22, safety: 0.3, whiff: 0.12, serveDelay: 1.4 },
  medium: { reaction: 0.24, speed: 0.86, aimError: 0.14, safety: 0.22, whiff: 0.06, serveDelay: 1.1 },
  hard: { reaction: 0.16, speed: 0.97, aimError: 0.09, safety: 0.15, whiff: 0.03, serveDelay: 0.9 },
  expert: { reaction: 0.1, speed: 1.05, aimError: 0.06, safety: 0.1, whiff: 0.012, serveDelay: 0.8 },
};

interface InterceptPlan {
  stand: Vector3;
  contact: PathSample;
  /** Hit only after this many bounces since the opponent's contact. */
  bounces: number;
  feasible: boolean;
}

const HIT_OFFSET = 0.55;
const COMFORT_MIN = 0.35;
const COMFORT_MAX = 1.5;

/**
 * AI opponent. Observes only what a human could see (ball position/velocity, player positions)
 * and predicts the ball with the same physics. It produces a PlayerIntent like any other input.
 */
export class AIController implements InputProvider {
  private intent = emptyIntent();
  private rng: Rng;
  private plan: InterceptPlan | null = null;
  private planShotId = -1;
  private replanTimer = 0;
  private reactTimer = 0;
  private serveTimer = 0;
  private wasServing = false;
  private shotId = 0;
  private willWhiff = false;
  private readonly predictState = createBallState();
  /** Exposed for the debug overlay. */
  readonly debugTarget = new Vector3();

  constructor(
    public profile: AIProfile,
    seed = 1234,
  ) {
    this.rng = new Rng(seed);
  }

  update(ctx: InputContext, dt: number): void {
    const i = this.intent;
    i.swing = false;
    i.sprint = false;

    if (ctx.isServing) {
      this.updateServe(ctx, dt);
      return;
    }
    this.wasServing = false;

    this.shotId = ctx.shotIndex;
    const incoming = ctx.ballLive && ctx.lastHitterSide !== null && ctx.lastHitterSide !== ctx.side;
    if (!incoming) {
      this.plan = null;
      this.moveToward(ctx, this.homePosition(ctx), 0.3);
      return;
    }

    if (this.planShotId !== this.shotId) {
      this.planShotId = this.shotId;
      this.reactTimer = this.profile.reaction * this.rng.range(0.8, 1.25);
      this.plan = null;
      this.replanTimer = 0;
      this.willWhiff = this.rng.chance(this.profile.whiff);
    }

    if (this.reactTimer > 0) {
      this.reactTimer -= dt;
      return; // still reading the shot: keep current intent
    }

    this.replanTimer -= dt;
    if (!this.plan || this.replanTimer <= 0) {
      this.plan = this.planIntercept(ctx);
      this.replanTimer = 0.2;
    }
    if (!this.plan) {
      this.moveToward(ctx, this.homePosition(ctx), 0.3);
      return;
    }

    this.debugTarget.copy(this.plan.stand);
    const timeLeft = this.plan.contact.t;
    const dist = Math.hypot(this.plan.stand.x - ctx.selfPos.x, this.plan.stand.z - ctx.selfPos.z);
    this.intent.sprint = dist / (PLAYER.RUN_SPEED * this.profile.speed) > timeLeft * 0.8;
    this.moveToward(ctx, this.plan.stand, 0.08);

    // Swing as soon as the ball is reachable and the planned bounce count is satisfied.
    const b = ctx.ballPos;
    const onMySide = b.z * ctx.side > -0.05;
    const horiz = Math.hypot(b.x - ctx.selfPos.x, b.z - ctx.selfPos.z);
    const bouncesOk = ctx.bouncesSinceHit >= this.plan.bounces;
    const approaching = ctx.ballVel.z * ctx.side > 0 || ctx.bouncesSinceHit > 0;
    if (onMySide && bouncesOk && approaching && horiz < PLAYER.REACH * 0.92 && b.y > PLAYER.REACH_MIN_H && b.y < PLAYER.REACH_MAX_H) {
      if (!this.willWhiff) {
        this.chooseAim(ctx);
        i.swing = true;
      }
    }
  }

  private updateServe(ctx: InputContext, dt: number): void {
    const i = this.intent;
    i.moveX = 0;
    i.moveY = 0;
    if (!this.wasServing) {
      this.wasServing = true;
      this.serveTimer = this.profile.serveDelay * this.rng.range(0.9, 1.3);
    }
    this.serveTimer -= dt;
    if (this.serveTimer <= 0) {
      // Diagonal service court: serving from the right means landing on the hitter's left.
      const dir = ctx.serveFromRight ? -1 : 1;
      i.aimX = dir * clamp(this.rng.range(0.25, 0.75) + this.rng.gauss() * this.profile.aimError * 0.5, 0.05, 1);
      i.aimDepth = clamp(this.rng.range(0.65, 0.9) + this.rng.gauss() * this.profile.aimError * 0.5, 0.2, 1.05);
      i.swing = true;
      this.serveTimer = 999;
    }
  }

  private planIntercept(ctx: InputContext): InterceptPlan | null {
    const s = this.predictState;
    s.pos.copy(ctx.ballPos);
    s.vel.copy(ctx.ballVel);
    // Spin is not directly observable; the AI reads the ball as flat (a natural source of misreads).
    s.spin.set(0, 0, 0);
    s.rolling = false;
    s.atRest = false;
    s.bounceCount = 0;
    const path = samplePath(s, 3.5, 1 / 60, 2 - ctx.bouncesSinceHit);
    if (path.length === 0) return null;

    const speed = PLAYER.RUN_SPEED * this.profile.speed * 1.1;
    const minBounces = ctx.isReceiving || ctx.mustLetBounce ? 1 : 0;
    let best: InterceptPlan | null = null;
    let bestLateness = Infinity;

    for (const pass of [0, 1]) {
      for (const p of path) {
        const totalBounces = p.bounces + ctx.bouncesSinceHit;
        if (totalBounces > 1 || totalBounces < minBounces) continue;
        if (p.pos.z * ctx.side < 0.2) continue;
        const comfy = p.pos.y >= COMFORT_MIN && p.pos.y <= COMFORT_MAX;
        if (pass === 0 && (!comfy || totalBounces === 0)) continue;
        if (p.pos.y < PLAYER.REACH_MIN_H + 0.1 || p.pos.y > PLAYER.REACH_MAX_H - 0.1) continue;

        const stand = this.standPoint(ctx, p.pos);
        const dist = Math.hypot(stand.x - ctx.selfPos.x, stand.z - ctx.selfPos.z);
        const need = Math.max(0, dist - 0.25) / speed;
        const lateness = need - p.t;
        if (lateness <= 0) {
          return { stand, contact: p, bounces: totalBounces > 0 ? 1 : 0, feasible: true };
        }
        if (lateness < bestLateness) {
          bestLateness = lateness;
          best = { stand, contact: p, bounces: totalBounces > 0 ? 1 : 0, feasible: false };
        }
      }
    }
    return best;
  }

  /** Where to stand so the ball arrives at a comfortable forehand/backhand distance. */
  private standPoint(ctx: InputContext, ball: Vector3): Vector3 {
    const fore = ball.x - HIT_OFFSET * ctx.side;
    const back = ball.x + HIT_OFFSET * ctx.side;
    const x = Math.abs(fore - ctx.selfPos.x) <= Math.abs(back - ctx.selfPos.x) + 0.4 ? fore : back;
    const z = ball.z + ctx.side * 0.2;
    return new Vector3(x, 0, z);
  }

  private homePosition(ctx: InputContext): Vector3 {
    const shade = clamp(ctx.ballPos.x * 0.35, -1.2, 1.2);
    return new Vector3(shade, 0, ctx.side * (COURT.HALF_LENGTH - 0.4));
  }

  private chooseAim(ctx: InputContext): void {
    const i = this.intent;
    const p = this.profile;
    // Aim away from the opponent; opponent position in this hitter's aim space.
    const oppAim = ctx.opponentPos.x / (COURT.HALF_WIDTH * ctx.side);
    const awaySign = oppAim >= 0 ? -1 : 1;
    const lateral = this.rng.chance(0.75) ? awaySign * this.rng.range(0.3, 0.85) : this.rng.range(-0.5, 0.5);
    const maxX = 1 - p.safety;
    i.aimX = clamp(lateral, -maxX, maxX) + this.rng.gauss() * p.aimError;
    const depth = this.rng.chance(0.15) ? this.rng.range(0.25, 0.4) : this.rng.range(0.6, 1 - p.safety * 0.6);
    i.aimDepth = depth + this.rng.gauss() * p.aimError;
  }

  private moveToward(ctx: InputContext, target: Vector3, deadZone: number): void {
    const dx = target.x - ctx.selfPos.x;
    const dz = target.z - ctx.selfPos.z;
    const d = Math.hypot(dx, dz);
    const i = this.intent;
    if (d < deadZone) {
      i.moveX = 0;
      i.moveY = 0;
      return;
    }
    const k = clamp(d / 0.5, 0, 1) * this.profile.speed / d;
    // World -> side-relative (see PlayerController): moveX = wx * side, moveY = -wz * side.
    i.moveX = dx * k * ctx.side;
    i.moveY = -dz * k * ctx.side;
  }

  getIntent(): PlayerIntent {
    return this.intent;
  }

  reset(): void {
    this.plan = null;
    this.wasServing = false;
    this.intent.swing = false;
  }
}
