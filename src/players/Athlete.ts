import { Vector3 } from 'three';
import { PLAYER, POWER, type Side } from '../utils/Constants';

export type StrokeHand = 'forehand' | 'backhand';
export type SwingKind = 'serve' | 'stroke';

export interface SwingState {
  active: boolean;
  kind: SwingKind;
  hand: StrokeHand;
  /** Seconds since the swing started. */
  t: number;
  /** True once this swing has struck the ball (one contact per swing). */
  contact: boolean;
  /** Height of the ball at contact (drives the visual swing plane). */
  contactHeight: number;
  /** Charge 0..1 this swing was released with (0 = normal shot). */
  power: number;
}

/** Pure gameplay data for one player. Rendering reads this; it never writes it. */
export class Athlete {
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  /** Yaw in radians; 0 faces -z (from the near side toward the net). */
  facing = 0;
  readonly swing: SwingState = {
    active: false,
    kind: 'stroke',
    hand: 'forehand',
    t: 0,
    contact: false,
    contactHeight: 1,
    power: 0,
  };
  holdingBall = false;
  /** Time since the last swing ended, used for a short recovery cooldown. */
  swingCooldown = 0;

  constructor(
    readonly id: string,
    public side: Side,
    readonly name: string,
  ) {}

  startSwing(kind: SwingKind, hand: StrokeHand, power = 0): boolean {
    if (this.swing.active || this.swingCooldown > 0) return false;
    Object.assign(this.swing, { active: true, kind, hand, t: 0, contact: false, power });
    return true;
  }

  updateSwing(dt: number): void {
    if (this.swingCooldown > 0) this.swingCooldown = Math.max(0, this.swingCooldown - dt);
    if (!this.swing.active) return;
    this.swing.t += dt;
    if (this.swing.t >= PLAYER.SWING_DURATION) {
      this.swing.active = false;
      // Power swings take longer to recover from.
      const powered = this.swing.power >= POWER.MIN;
      this.swingCooldown = this.swing.contact ? (powered ? POWER.RECOVERY : 0.02) : powered ? POWER.RECOVERY : 0.08;
    }
  }

  /** True while the paddle is in the part of the swing that can meet the ball. */
  get inContactWindow(): boolean {
    return this.swing.active && !this.swing.contact && this.swing.kind === 'stroke' && this.swing.t <= PLAYER.CONTACT_WINDOW;
  }

  /** Which side of the body a world-space point is on, from this player's perspective. */
  handFor(worldX: number): StrokeHand {
    return (worldX - this.pos.x) * this.side >= 0 ? 'forehand' : 'backhand';
  }

  /** Default facing: toward the net. */
  get netYaw(): number {
    return this.side === 1 ? 0 : Math.PI;
  }

  resetSwing(): void {
    this.swing.active = false;
    this.swing.contact = false;
    this.swingCooldown = 0;
  }
}
