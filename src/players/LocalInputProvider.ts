import { directionalAim, pointAim, swipeAim, type Aim } from '../gameplay/Aim';
import { PLAYER, POWER } from '../utils/Constants';
import { clamp } from '../utils/MathUtils';
import type { TouchControls } from '../ui/TouchControls';
import { emptyIntent, type InputContext, type InputProvider, type PlayerIntent } from './InputProvider';

export type GroundPicker = (clientX: number, clientY: number) => { x: number; z: number } | null;

type AimSource = 'keys' | 'mouse' | 'touch';

/**
 * Keyboard + mouse + touch input for the local human player.
 *   WASD / arrows: move   Shift: sprint
 *   Space / left mouse / right-side touch: hold to charge, release to hit (a tap is a normal shot)
 *   Aim is direction-at-hit: the movement keys held when the swing starts pick the target zone
 *   (left / center / right × deep / short); nothing held = safe deep target away from the opponent.
 *   Mouse: the click / release point picks the zone. Touch: the swipe direction picks it.
 */
export class LocalInputProvider implements InputProvider {
  private keys = new Set<string>();
  private intent = emptyIntent();
  private pointer: { x: number; y: number } | null = null;
  private side: 1 | -1 = 1;
  /** Swing button state: held time, and a release waiting for the next tick. */
  private holding = false;
  private holdT = 0;
  private releaseQueued = false;
  private aimSource: AimSource = 'keys';
  /** Mouse / touch aim captured at release, applied on the swing tick. */
  private releaseAim: { kind: 'mouse'; x: number; y: number } | { kind: 'touch'; dx: number; dy: number } | null = null;
  enabled = true;

  constructor(
    private canvas: HTMLElement,
    private pickGround: GroundPicker,
    private touch: TouchControls | null,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    touch?.onPress(() => this.press('touch'));
    touch?.onRelease((dx, dy) => {
      this.releaseAim = { kind: 'touch', dx, dy };
      this.release();
    });
  }

  private press(source: AimSource): void {
    if (!this.enabled || this.holding) return;
    this.holding = true;
    this.holdT = 0;
    this.aimSource = source;
    this.releaseAim = null;
  }

  private release(): void {
    if (!this.holding) return;
    this.holding = false;
    this.releaseQueued = true;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    this.keys.add(e.code);
    if (e.code === 'Space') {
      if (!e.repeat) this.press('keys');
      e.preventDefault();
    }
    if (e.code.startsWith('Arrow')) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    if (e.code === 'Space' && this.aimSource === 'keys') this.release();
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.release();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') this.pointer = { x: e.clientX, y: e.clientY };
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled || e.pointerType !== 'mouse' || e.button !== 0) return;
    this.pointer = { x: e.clientX, y: e.clientY };
    this.press('mouse');
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || this.aimSource !== 'mouse') return;
    this.releaseAim = { kind: 'mouse', x: e.clientX, y: e.clientY };
    this.release();
  };

  update(ctx: InputContext, dt: number): void {
    this.side = ctx.side;
    const i = this.intent;
    const k = this.keys;
    let mx = 0;
    let my = 0;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) my += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) my -= 1;

    if (this.touch?.active) {
      const j = this.touch.joystick;
      if (Math.hypot(j.x, j.y) > 0.12) {
        mx = j.x;
        my = j.y;
      }
    }
    // The camera sits behind the near side; flip screen-relative input for the far side.
    i.moveX = mx * this.side;
    i.moveY = my * this.side;
    i.sprint = k.has('ShiftLeft') || k.has('ShiftRight');

    if (this.holding) {
      this.holdT += dt;
      // Never let a held charge miss the ball: release automatically as it arrives.
      if (this.holdT >= POWER.TAP_TIME && this.ballArriving(ctx)) this.release();
    }
    const charge = clamp(this.holdT / POWER.CHARGE_TIME, 0, 1);
    const aim = this.currentAim(ctx);
    i.aimX = aim.aimX;
    i.aimDepth = aim.aimDepth;
    i.charging = this.enabled && this.holding;

    i.swing = this.enabled && this.releaseQueued;
    // A short tap is a normal shot; a hold releases with its charge.
    i.power = i.swing ? (this.holdT < POWER.TAP_TIME ? 0 : charge) : i.charging ? charge : 0;
    if (this.releaseQueued) {
      this.releaseQueued = false;
      this.holdT = 0;
    }
  }

  /** True when the incoming ball is about to reach the player's paddle. */
  private ballArriving(ctx: InputContext): boolean {
    if (!ctx.ballLive || ctx.lastHitterSide === ctx.side) return false;
    const b = ctx.ballPos;
    if (b.y < PLAYER.REACH_MIN_H || b.y > PLAYER.REACH_MAX_H || b.z * ctx.side < -0.1) return false;
    return Math.hypot(b.x - ctx.selfPos.x, b.z - ctx.selfPos.z) < PLAYER.REACH + 0.15;
  }

  /** Aim for the current tick from the active source (a preview while charging). */
  private currentAim(ctx: InputContext): Aim {
    const ra = this.releaseAim;
    if (ra?.kind === 'touch') return swipeAim(ra.dx * this.side, ra.dy, this.side, ctx.opponentPos.x);
    if (this.aimSource === 'touch' && this.touch) {
      const s = this.touch.swipe;
      if (s) return swipeAim(s.dx * this.side, s.dy, this.side, ctx.opponentPos.x);
    }
    if (this.aimSource === 'mouse') {
      const pt = ra?.kind === 'mouse' ? ra : this.pointer;
      const p = pt && this.pickGround(pt.x, pt.y);
      // Only a point on the opponent's side of the net counts as a target.
      if (p && p.z * this.side < 0) return pointAim(this.side, p.x, p.z);
    }
    return directionalAim(this.intent.moveX, this.intent.moveY, this.side, ctx.opponentPos.x);
  }

  getIntent(): PlayerIntent {
    return this.intent;
  }

  reset(): void {
    this.holding = false;
    this.holdT = 0;
    this.releaseQueued = false;
    this.releaseAim = null;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
  }
}
