import { Vector3 } from 'three';
import { BallPhysics } from '../physics/BallPhysics';
import { buildServe, buildStroke, contactQuality, strokeKind, type StrokeKind } from '../gameplay/ShotSystem';
import {
  judgeBounce,
  judgeContact,
  judgeMomentum,
  judgeRest,
  judgeServeLanding,
  judgeServePosition,
  isInsideCourt,
  sideOfZ,
  type RallyOutcome,
} from '../gameplay/RuleManager';
import type { Athlete, StrokeHand, SwingKind } from '../players/Athlete';
import type { InputContext } from '../players/InputProvider';
import { FREE_BOUNDS, type PlayerController } from '../players/PlayerController';
import { COURT, PLAYER, SIM, type Side } from '../utils/Constants';
import { EventBus } from '../utils/EventBus';
import { Rng, sideToWorld } from '../utils/MathUtils';

export type RallyPhase = 'serve' | 'live' | 'dead';

export interface RallyEvents extends Record<string, unknown> {
  hit: {
    athlete: Athlete;
    pos: Vector3;
    speed: number;
    kind: SwingKind;
    hand: StrokeHand;
    shotIndex: number;
    /** True for a charged power shot or smash (drives the power hit effects). */
    power: boolean;
    stroke: StrokeKind;
  };
  bounce: { pos: Vector3; speed: number; inBounds: boolean };
  net: { pos: Vector3; tape: boolean };
  rallyEnd: { outcome: RallyOutcome; shots: number };
  serveStart: { server: Athlete; fromRight: boolean };
  swing: { athlete: Athlete };
  /** A swing finished; `contact` is false for a whiff. */
  swingEnd: { athlete: Athlete; kind: SwingKind; contact: boolean };
}

/** Hard safety limit: a rally (or a held serve by the AI) can never run forever. */
const MAX_RALLY_TIME = 60;
const SERVE_DEPTH = COURT.HALF_LENGTH + 0.45;
/** Server bounds keep the feet clear of the baseline, centerline and sideline. */
const SERVE_MARGIN = PLAYER.FOOT_RADIUS + 0.02;

/**
 * Runs a single rally: serve, live ball, paddle contacts and rally-ending judgement.
 * Who serves next and scoring belong to the match layer; this class only reports outcomes.
 */
export class RallyManager {
  readonly ball = new BallPhysics();
  readonly bus = new EventBus<RallyEvents>();
  phase: RallyPhase = 'dead';
  server!: Athlete;
  serveFromRight = true;
  lastHitter: Athlete | null = null;
  bouncesSinceHit = 0;
  shotIndex = 0;
  rallyTime = 0;
  outcome: RallyOutcome | null = null;
  time = 0;
  private ctx = new Map<PlayerController, InputContext>();
  /** Rally time of each player's last volley, for the kitchen momentum rule. */
  private lastVolleyAt = new Map<Athlete, number>();
  private readonly hand = new Vector3();

  constructor(
    readonly players: [PlayerController, PlayerController],
    private rng = new Rng(42),
  ) {
    for (const c of players) this.ctx.set(c, this.createCtx(c));
  }

  controllerFor(a: Athlete): PlayerController {
    return this.players[0].athlete === a ? this.players[0] : this.players[1];
  }

  opponentOf(a: Athlete): Athlete {
    return this.players[0].athlete === a ? this.players[1].athlete : this.players[0].athlete;
  }

  /** Positions both players and gives the ball to the server. */
  startServe(server: Athlete, fromRight: boolean): void {
    this.server = server;
    this.serveFromRight = fromRight;
    this.phase = 'serve';
    this.lastHitter = null;
    this.bouncesSinceHit = 0;
    this.shotIndex = 0;
    this.rallyTime = 0;
    this.outcome = null;
    this.lastVolleyAt.clear();

    const lateral = fromRight ? PLAYER.SERVE_LATERAL : -PLAYER.SERVE_LATERAL;
    for (const c of this.players) {
      const a = c.athlete;
      c.reset();
      const isServer = a === server;
      // Receiver stands in the diagonal court, which is also on *their* right when the server is on the right.
      const p = sideToWorld(a.side, lateral, isServer ? SERVE_DEPTH : PLAYER.RECEIVE_DEPTH);
      a.pos.set(p.x, 0, p.z);
      a.facing = a.netYaw;
      a.holdingBall = isServer;
      c.bounds = isServer
        ? {
            minLateral: fromRight ? SERVE_MARGIN : -COURT.HALF_WIDTH + SERVE_MARGIN,
            maxLateral: fromRight ? COURT.HALF_WIDTH - SERVE_MARGIN : -SERVE_MARGIN,
            minDepth: COURT.HALF_LENGTH + SERVE_MARGIN,
            maxDepth: COURT.HALF_LENGTH + PLAYER.BACK_ROOM,
          }
        : FREE_BOUNDS;
    }
    this.ball.hold(this.handPosition(server, PLAYER.SERVE_HOLD_HEIGHT));
    this.bus.emit('serveStart', { server, fromRight });
  }

  tick(dt: number): void {
    this.time += dt;
    if (this.phase !== 'dead') this.rallyTime += dt;

    for (const c of this.players) {
      const ctx = this.updateCtx(c);
      const sw = c.athlete.swing;
      const wasSwinging = sw.active;
      if (c.tick(ctx, dt)) this.bus.emit('swing', { athlete: c.athlete });
      else if (wasSwinging && !sw.active) this.bus.emit('swingEnd', { athlete: c.athlete, kind: sw.kind, contact: sw.contact });
    }

    if (this.phase === 'serve') {
      this.updateServe();
      return;
    }

    const substeps = Math.round(dt / (SIM.TICK_DT / 2));
    for (const e of this.ball.advance(substeps)) {
      if (e.type === 'bounce') {
        this.bouncesSinceHit++;
        this.bus.emit('bounce', { pos: e.pos, speed: e.speed, inBounds: isInsideCourt(e.pos.x, e.pos.z) });
        if (this.phase === 'live' && this.lastHitter) {
          const serveBounce = this.shotIndex === 1 && this.bouncesSinceHit === 1;
          const o = serveBounce
            ? judgeServeLanding(this.lastHitter.side, this.serveFromRight, e.pos)
            : judgeBounce(this.lastHitter.side, this.bouncesSinceHit, e.pos);
          if (o) this.end(o);
        }
      } else if (e.type === 'net') {
        this.bus.emit('net', { pos: e.pos, tape: e.tape });
      } else if (e.type === 'rest' && this.phase === 'live') {
        this.end(judgeRest(this.lastHitter?.side ?? null, e.pos));
      }
    }

    if (this.phase === 'live') this.checkContacts();
    if (this.phase === 'live') this.checkMomentum();
    if (this.phase === 'live') this.checkSafety();
  }

  private updateServe(): void {
    const s = this.server;
    const sw = s.swing;
    if (sw.active && sw.kind === 'serve') {
      // Drop the ball from the hand toward the contact height during the backswing.
      const k = Math.min(1, sw.t / PLAYER.SERVE_CONTACT_DELAY);
      this.ball.hold(this.handPosition(s, PLAYER.SERVE_HOLD_HEIGHT + (PLAYER.SERVE_CONTACT_HEIGHT - PLAYER.SERVE_HOLD_HEIGHT) * k));
      if (sw.t >= PLAYER.SERVE_CONTACT_DELAY && !sw.contact) {
        const aim = this.controllerFor(s).swingAim;
        const contact = this.ball.state.pos.clone();
        const sol = buildServe(contact, s.side, this.serveFromRight, aim.aimX, aim.aimDepth);
        sw.contact = true;
        sw.contactHeight = contact.y;
        s.holdingBall = false;
        this.controllerFor(s).bounds = FREE_BOUNDS;
        this.ball.launch(contact, sol.velocity, sol.spin);
        this.phase = 'live';
        this.registerHit(s, 'serve', 'forehand', 'normal');
        const foot = judgeServePosition(s.side, this.serveFromRight, s.pos);
        if (foot) this.end(foot);
      }
    } else {
      this.ball.hold(this.handPosition(s, PLAYER.SERVE_HOLD_HEIGHT));
      if (this.rallyTime > MAX_RALLY_TIME) this.rallyTime = 0;
    }
  }

  private checkContacts(): void {
    const b = this.ball.state.pos;
    for (const c of this.players) {
      const a = c.athlete;
      if (!a.inContactWindow || this.lastHitter === a) continue;
      if (b.z * a.side < -0.15) continue; // can't reach over the net
      if (b.y < PLAYER.REACH_MIN_H || b.y > PLAYER.REACH_MAX_H) continue;

      const reach = Math.hypot(b.x - a.pos.x, b.z - a.pos.z);
      if (reach > PLAYER.REACH) continue;

      const verdict = judgeContact({ hitterSide: a.side, shotIndex: this.shotIndex, bouncesSinceHit: this.bouncesSinceHit, hitterPos: a.pos });
      const volley = this.bouncesSinceHit === 0;
      const aim = c.swingAim;
      const contact = b.clone();
      const quality = contactQuality(a.swing.t, reach / PLAYER.REACH);
      const sol = buildStroke(contact, a.side, aim.aimX, aim.aimDepth, this.rng, { quality, power: aim.power });
      a.swing.contact = true;
      a.swing.contactHeight = contact.y;
      a.swing.hand = a.handFor(contact.x);
      this.ball.launch(contact, sol.velocity, sol.spin);
      this.registerHit(a, 'stroke', a.swing.hand, strokeKind(contact.y, aim.power));
      if (volley) this.lastVolleyAt.set(a, this.rallyTime);
      if (verdict) this.end(verdict);
      return;
    }
  }

  /** Kitchen momentum: a volleyer carried into the kitchen during the follow-through faults. */
  private checkMomentum(): void {
    for (const c of this.players) {
      const a = c.athlete;
      const at = this.lastVolleyAt.get(a);
      if (at === undefined) continue;
      const o = judgeMomentum(a.side, a.pos, this.rallyTime - at);
      if (o) {
        this.end(o);
        return;
      }
    }
  }

  private registerHit(a: Athlete, kind: SwingKind, hand: StrokeHand, stroke: StrokeKind): void {
    this.lastHitter = a;
    this.bouncesSinceHit = 0;
    this.shotIndex++;
    this.bus.emit('hit', {
      athlete: a,
      pos: this.ball.state.pos.clone(),
      speed: this.ball.state.vel.length(),
      kind,
      hand,
      shotIndex: this.shotIndex,
      power: stroke !== 'normal',
      stroke,
    });
  }

  private checkSafety(): void {
    const p = this.ball.state.pos;
    const lost = Math.abs(p.x) > 30 || Math.abs(p.z) > 40 || p.y < -1 || !Number.isFinite(p.x + p.y + p.z);
    if (lost && this.lastHitter) {
      this.end(judgeRest(this.lastHitter.side, p));
    } else if (lost || this.rallyTime > MAX_RALLY_TIME) {
      this.end({ winner: null, reason: 'BALL_STUCK', faultBy: null });
    }
  }

  private end(outcome: RallyOutcome): void {
    if (this.phase === 'dead') return; // exactly one outcome per rally
    this.phase = 'dead';
    this.outcome = outcome;
    this.bus.emit('rallyEnd', { outcome, shots: this.shotIndex });
  }

  /** Forces the rally to end without a winner (used by restart / debug). */
  abort(): void {
    this.end({ winner: null, reason: 'BALL_STUCK', faultBy: null });
  }

  private handPosition(a: Athlete, height: number): Vector3 {
    // In front of the body, on the paddle (right-hand) side.
    return this.hand.set(a.pos.x + a.side * 0.32, height, a.pos.z - a.side * 0.28);
  }

  private createCtx(c: PlayerController): InputContext {
    return {
      side: c.athlete.side,
      selfPos: c.athlete.pos,
      opponentPos: this.opponentOf(c.athlete).pos,
      ballPos: this.ball.state.pos,
      ballVel: this.ball.state.vel,
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

  private updateCtx(c: PlayerController): InputContext {
    const ctx = this.ctx.get(c)!;
    const a = c.athlete;
    const hitterSide: Side | null = this.lastHitter?.side ?? null;
    ctx.side = a.side;
    ctx.ballLive = this.phase === 'live';
    ctx.lastHitterSide = hitterSide;
    ctx.bouncesSinceHit = this.bouncesSinceHit;
    ctx.shotIndex = this.shotIndex;
    // Two-bounce rule: the return of serve and the third shot must bounce first.
    ctx.mustLetBounce = ctx.ballLive && this.shotIndex <= 2 && hitterSide !== a.side;
    ctx.isServing = this.phase === 'serve' && a === this.server;
    ctx.isReceiving = ctx.ballLive && this.shotIndex === 1 && a !== this.server;
    ctx.serveFromRight = this.serveFromRight;
    ctx.time = this.time;
    return ctx;
  }

  /** Side the ball is currently on. */
  get ballSide(): Side {
    return sideOfZ(this.ball.state.pos.z);
  }
}
