import { clamp } from '../utils/MathUtils';

const JOY_RADIUS = 55;
const SWIPE_FIRE_PX = 42;

/**
 * Mobile controls: a floating joystick on the left half of the screen, and a swing area on the
 * right half. Tap = swing at the default target; swipe = swing aimed in the swipe direction
 * (left/right = across the court, up = deeper).
 */
export class TouchControls {
  active = false;
  readonly joystick = { x: 0, y: 0 };
  readonly aim = { x: 0, depth: 0.72 };
  private layer: HTMLDivElement;
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private joyId: number | null = null;
  private joyOrigin = { x: 0, y: 0 };
  private swipeId: number | null = null;
  private swipeStart = { x: 0, y: 0 };
  private fired = false;
  private swingCbs: (() => void)[] = [];

  constructor(parent: HTMLElement) {
    this.layer = document.createElement('div');
    this.layer.className = 'touch-layer hidden';
    const left = document.createElement('div');
    left.className = 'touch-zone';
    const right = document.createElement('div');
    right.className = 'touch-zone';
    this.layer.append(left, right);
    this.base = document.createElement('div');
    this.base.className = 'joy-base hidden';
    this.knob = document.createElement('div');
    this.knob.className = 'joy-knob';
    this.base.appendChild(this.knob);
    const hint = document.createElement('div');
    hint.className = 'swipe-hint';
    hint.textContent = 'TAP or SWIPE to hit';
    this.layer.append(this.base, hint);
    parent.appendChild(this.layer);

    left.addEventListener('pointerdown', this.joyDown);
    right.addEventListener('pointerdown', this.swipeDown);
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    window.addEventListener('pointercancel', this.up);

    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    if (coarse && navigator.maxTouchPoints > 0) this.activate();
    window.addEventListener('touchstart', () => this.activate(), { once: true, passive: true });
  }

  activate(): void {
    this.active = true;
  }

  /** Show/hide the touch layer (hidden during menus). */
  setVisible(v: boolean): void {
    this.layer.classList.toggle('hidden', !(v && this.active));
  }

  onSwing(cb: () => void): void {
    this.swingCbs.push(cb);
  }

  private joyDown = (e: PointerEvent): void => {
    if (this.joyId !== null) return;
    this.joyId = e.pointerId;
    this.joyOrigin = { x: e.clientX, y: e.clientY };
    this.base.style.left = `${e.clientX}px`;
    this.base.style.top = `${e.clientY}px`;
    this.base.classList.remove('hidden');
    this.knob.style.transform = '';
  };

  private swipeDown = (e: PointerEvent): void => {
    if (this.swipeId !== null) return;
    this.swipeId = e.pointerId;
    this.swipeStart = { x: e.clientX, y: e.clientY };
    this.fired = false;
  };

  private move = (e: PointerEvent): void => {
    if (e.pointerId === this.joyId) {
      let dx = e.clientX - this.joyOrigin.x;
      let dy = e.clientY - this.joyOrigin.y;
      const d = Math.hypot(dx, dy);
      if (d > JOY_RADIUS) {
        dx = (dx / d) * JOY_RADIUS;
        dy = (dy / d) * JOY_RADIUS;
      }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.joystick.x = dx / JOY_RADIUS;
      this.joystick.y = -dy / JOY_RADIUS;
    } else if (e.pointerId === this.swipeId && !this.fired) {
      const dx = e.clientX - this.swipeStart.x;
      const dy = e.clientY - this.swipeStart.y;
      if (Math.hypot(dx, dy) >= SWIPE_FIRE_PX) this.fire(dx, dy);
    }
  };

  private up = (e: PointerEvent): void => {
    if (e.pointerId === this.joyId) {
      this.joyId = null;
      this.joystick.x = 0;
      this.joystick.y = 0;
      this.base.classList.add('hidden');
    } else if (e.pointerId === this.swipeId) {
      if (!this.fired) this.fire(0, 0);
      this.swipeId = null;
    }
  };

  private fire(dx: number, dy: number): void {
    this.fired = true;
    const len = Math.hypot(dx, dy);
    if (len < 10) {
      this.aim.x = 0;
      this.aim.depth = 0.72;
    } else {
      this.aim.x = clamp((dx / len) * 1.4, -1, 1);
      this.aim.depth = clamp(0.5 + (-dy / len) * 0.42, 0.18, 0.95);
    }
    for (const cb of this.swingCbs) cb();
  }
}
