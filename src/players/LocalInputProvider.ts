import { COURT } from '../utils/Constants';
import { clamp } from '../utils/MathUtils';
import type { TouchControls } from '../ui/TouchControls';
import { emptyIntent, type InputContext, type InputProvider, type PlayerIntent } from './InputProvider';

export type GroundPicker = (clientX: number, clientY: number) => { x: number; z: number } | null;

/**
 * Keyboard + mouse + touch input for the local human player.
 *   WASD / arrows: move   Shift: sprint   Space / left click: swing
 *   Mouse over the opponent's court: aim
 *   Touch: left joystick moves, right side tap = swing, swipe = swing + aim
 */
export class LocalInputProvider implements InputProvider {
  private keys = new Set<string>();
  private swingQueued = false;
  private intent = emptyIntent();
  private pointer: { x: number; y: number } | null = null;
  private side: 1 | -1 = 1;
  enabled = true;

  constructor(
    private canvas: HTMLElement,
    private pickGround: GroundPicker,
    private touch: TouchControls | null,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    touch?.onSwing(() => (this.swingQueued = true));
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    this.keys.add(e.code);
    if (e.code === 'Space' && !e.repeat) {
      this.swingQueued = true;
      e.preventDefault();
    }
    if (e.code.startsWith('Arrow')) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') this.pointer = { x: e.clientX, y: e.clientY };
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.enabled || e.pointerType !== 'mouse' || e.button !== 0) return;
    this.pointer = { x: e.clientX, y: e.clientY };
    this.swingQueued = true;
  };

  update(ctx: InputContext): void {
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

    this.updateAim(i);
    i.swing = this.enabled && this.swingQueued;
    this.swingQueued = false;
  }

  private updateAim(i: PlayerIntent): void {
    if (this.touch?.active) {
      const a = this.touch.aim;
      i.aimX = a.x;
      i.aimDepth = a.depth;
      return;
    }
    if (!this.pointer) return;
    const p = this.pickGround(this.pointer.x, this.pointer.y);
    if (!p) return;
    // Convert the world point into the hitter's aim space (see aimToWorld).
    i.aimX = clamp(p.x / (COURT.HALF_WIDTH * this.side), -1, 1);
    i.aimDepth = clamp((-p.z * this.side) / COURT.HALF_LENGTH, 0.12, 1);
  }

  getIntent(): PlayerIntent {
    return this.intent;
  }

  reset(): void {
    this.swingQueued = false;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
  }
}
