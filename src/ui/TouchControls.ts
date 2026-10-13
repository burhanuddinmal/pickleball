const JOY_RADIUS = 55;

/**
 * Mobile controls: a floating joystick on the left half of the screen, and a swing area on the
 * right half. Touch down starts charging, lifting the finger hits: a quick tap is a normal shot at
 * the default target, holding charges a power shot, and the swipe direction picks the target zone
 * (sideways = across the court, up = deep, down = short).
 */
export class TouchControls {
  active = false;
  readonly joystick = { x: 0, y: 0 };
  /** Live swipe vector (px) while the swing finger is down, else null. */
  swipe: { dx: number; dy: number } | null = null;
  private layer: HTMLDivElement;
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private joyId: number | null = null;
  private joyOrigin = { x: 0, y: 0 };
  private swipeId: number | null = null;
  private swipeStart = { x: 0, y: 0 };
  private pressCbs: (() => void)[] = [];
  private releaseCbs: ((dx: number, dy: number) => void)[] = [];

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
    hint.textContent = 'TAP to hit · HOLD for power · SWIPE to aim';
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

  onPress(cb: () => void): void {
    this.pressCbs.push(cb);
  }

  /** Called when the swing finger lifts, with the swipe vector (px, screen space). */
  onRelease(cb: (dx: number, dy: number) => void): void {
    this.releaseCbs.push(cb);
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
    this.swipe = { dx: 0, dy: 0 };
    for (const cb of this.pressCbs) cb();
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
    } else if (e.pointerId === this.swipeId && this.swipe) {
      this.swipe.dx = e.clientX - this.swipeStart.x;
      this.swipe.dy = e.clientY - this.swipeStart.y;
    }
  };

  private up = (e: PointerEvent): void => {
    if (e.pointerId === this.joyId) {
      this.joyId = null;
      this.joystick.x = 0;
      this.joystick.y = 0;
      this.base.classList.add('hidden');
    } else if (e.pointerId === this.swipeId) {
      const dx = e.clientX - this.swipeStart.x;
      const dy = e.clientY - this.swipeStart.y;
      this.swipeId = null;
      this.swipe = null;
      for (const cb of this.releaseCbs) cb(dx, dy);
    }
  };
}
