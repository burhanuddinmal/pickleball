import * as THREE from 'three';
import { COURT } from '../utils/Constants';
import { clamp, damp, lerp } from '../utils/MathUtils';

export interface CameraFocus {
  player: THREE.Vector3;
  ball: THREE.Vector3;
  ballLive: boolean;
  /** +1 when the followed player is on the near side. */
  side: 1 | -1;
}

/** Fixed downward tilt (radians); portrait is steeper so the long court fits the tall screen. */
const PITCH_LANDSCAPE = THREE.MathUtils.degToRad(32);
const PITCH_PORTRAIT = THREE.MathUtils.degToRad(50);
/** Fraction of the half-FOV the court may fill, leaving a margin at the frame edges. */
const EDGE_MARGIN = 0.9;
const WIDTH_MARGIN = 0.95;
/** How much of the player's lateral position the camera follows. */
const FOLLOW_X = 0.3;
/** Shared smoothing rate for all position axes, so the camera glides as one unit. */
const FOLLOW_RATE = 3;
/** Opponent height kept in frame on the far baseline. */
const OPPONENT_HEIGHT = 1.8;
/** Trauma shake: decay per second and peak rotation (radians) at full trauma. */
const TRAUMA_DECAY = 1.6;
const SHAKE_PITCH = THREE.MathUtils.degToRad(2.2);
const SHAKE_YAW = THREE.MathUtils.degToRad(2.2);
const SHAKE_ROLL = THREE.MathUtils.degToRad(3);
/** FOV punch recovery rate (1/s). */
const PUNCH_RATE = 7;
/** Point-end push-in: share of the way toward the focus point, and extra lateral follow. */
const POINT_PUSH = 0.15;
const POINT_SHIFT = 0.3;
/**
 * Match-over orbit: radius, height, look-at height (m; low, so the winner sits above the
 * bottom-anchored match-over panel), angular speed (rad/s), ease-in rate.
 */
const ORBIT_RADIUS = 5;
const ORBIT_HEIGHT = 1.9;
const ORBIT_LOOK_Y = 0.35;
const ORBIT_SPEED = 0.22;
const ORBIT_EASE = 1.6;

/** Smooth pseudo-noise in about [-1, 1]: sum of sines at unrelated frequencies. */
const noise = (t: number, seed: number): number =>
  (Math.sin(t * 17.3 + seed) + Math.sin(t * 29.1 + seed * 2.7) * 0.6 + Math.sin(t * 7.9 + seed * 4.1) * 0.4) / 2;

/**
 * Third-person broadcast-style camera behind the local player. Orientation is fixed (constant
 * pitch, looking straight down the court); only the position moves. Height and distance are
 * solved each frame so the court from the player's own baseline (or feet, if behind it) to the
 * far baseline and opponent always fits the frame. Impact "kick" is a short positional offset,
 * "trauma" a decaying rotational shake, and "punch" a brief FOV narrowing. Two presentation
 * modes sit on top: a point-end push-in toward a focus point, and a slow orbit around the match
 * winner (which takes over orientation too).
 */
export class CameraRig {
  private pos = new THREE.Vector3(0, 6, COURT.HALF_LENGTH + 8);
  private tPos = new THREE.Vector3();
  private side: 1 | -1 = 1;
  private kick = 0;
  private trauma = 0;
  private fovPunch = 0;
  private time = 0;
  /** FOV from setAspect(); punch is applied on top so framing never drifts. */
  private baseFov = 50;
  private aspect = 1.6;
  private pointFocus = new THREE.Vector3();
  private hasPointFocus = false;
  private orbitCenter = new THREE.Vector3();
  private orbiting = false;
  /** Orbit in polar coordinates about the winner, eased toward the goal so the camera swings around them rather than through them. */
  private orbitAngle = 0;
  private orbitGoal = 0;
  private orbitR = 0;
  private orbitH = 0;
  private orbitQ = new THREE.Quaternion();
  private lookM = new THREE.Matrix4();
  private lookAt = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  /** Kicks, trauma shake and FOV punch; off under reduce-effects (which also stills the orbit). */
  shakeEnabled = true;

  constructor(private camera: THREE.PerspectiveCamera) {}

  /** 0 = tall portrait phone, 1 = landscape; tablets blend between the two framings. */
  private get landscapeBlend(): number {
    return clamp((this.aspect - 0.6) / 0.7, 0, 1);
  }

  private get pitch(): number {
    return lerp(PITCH_PORTRAIT, PITCH_LANDSCAPE, this.landscapeBlend);
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    // Landscape keeps ~62deg horizontal view; portrait uses a fixed tall vertical FOV.
    const hfov = THREE.MathUtils.degToRad(62);
    const landscapeV = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / aspect)), 42, 70);
    this.baseFov = lerp(66, landscapeV, this.landscapeBlend);
    this.applyFov();
    this.apply();
  }

  impulse(strength: number): void {
    if (this.shakeEnabled) this.kick = Math.min(1, this.kick + strength);
  }

  /** Adds rotational shake (0..1); the visible shake is trauma², so small hits stay subtle. */
  shake(amount: number): void {
    if (this.shakeEnabled) this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Briefly narrows the FOV by `deg`, damped back to the base FOV. */
  punch(deg: number): void {
    if (this.shakeEnabled) this.fovPunch = Math.max(this.fovPunch, deg);
  }

  /** Point-end push-in toward `pos` (ground point); null returns to normal framing. */
  setPointFocus(pos: THREE.Vector3 | null): void {
    this.hasPointFocus = !!pos;
    if (pos) this.pointFocus.copy(pos);
  }

  /**
   * Slow orbit around `center` (the match winner's feet), sweeping across their front; `side` is
   * the winner's court side (they face the net). Null ends it.
   */
  orbit(center: THREE.Vector3 | null, side: 1 | -1 = 1): void {
    if (!center) {
      this.orbiting = false;
      return;
    }
    this.orbitCenter.set(center.x, 0, center.z);
    if (!this.orbiting) {
      // Glide in from the current view; the sweep starts a little to one side of their front.
      const p = this.camera.position;
      this.orbitAngle = Math.atan2(p.x - center.x, p.z - center.z);
      this.orbitGoal = (side === 1 ? Math.PI : 0) - 0.8;
      // Swing around whichever way is shorter.
      while (this.orbitGoal - this.orbitAngle > Math.PI) this.orbitGoal -= Math.PI * 2;
      while (this.orbitGoal - this.orbitAngle < -Math.PI) this.orbitGoal += Math.PI * 2;
      this.orbitR = Math.hypot(p.x - center.x, p.z - center.z);
      this.orbitH = p.y;
      this.orbitQ.copy(this.camera.quaternion);
    }
    this.orbiting = true;
  }

  /** Instantly place the camera (used at the start of each point). */
  snap(f: CameraFocus): void {
    this.orbiting = false;
    this.side = f.side;
    this.computeTarget(f);
    this.pos.copy(this.tPos);
    this.apply();
  }

  update(f: CameraFocus, dt: number): void {
    this.side = f.side;
    this.time += dt;
    if (this.orbiting) {
      this.updateOrbit(dt);
      return;
    }
    this.computeTarget(f);
    if (this.hasPointFocus) {
      // Along the line to the focus (it keeps its place on screen and grows), plus a lateral drift.
      this.tPos.lerp(this.pointFocus, POINT_PUSH);
      this.tPos.x += (this.pointFocus.x - this.tPos.x) * POINT_SHIFT;
    }
    this.pos.x = damp(this.pos.x, this.tPos.x, FOLLOW_RATE, dt);
    this.pos.y = damp(this.pos.y, this.tPos.y, FOLLOW_RATE, dt);
    this.pos.z = damp(this.pos.z, this.tPos.z, FOLLOW_RATE, dt);
    this.kick = Math.max(0, this.kick - dt * 4);
    this.trauma = Math.max(0, this.trauma - dt * TRAUMA_DECAY);
    if (this.fovPunch > 0) {
      this.fovPunch = this.fovPunch < 0.01 ? 0 : damp(this.fovPunch, 0, PUNCH_RATE, dt);
      this.applyFov();
    }
    this.apply();
  }

  /**
   * Solves camera height H and distance from the net Zc for the fixed pitch θ:
   *   near point on the bottom edge:      H = a (Zc - zn),            a = tan(θ + h)
   *   far baseline + opponent on the top: H - OPP = b (Zc + HALF),    b = tan(θ - h)
   * then backs off along the view axis if the near baseline corners don't fit horizontally.
   */
  private computeTarget(f: CameraFocus): void {
    const s = f.side;
    const theta = this.pitch;
    const vHalf = THREE.MathUtils.degToRad(this.baseFov) / 2;
    const h = vHalf * EDGE_MARGIN;
    const a = Math.tan(Math.min(theta + h, THREE.MathUtils.degToRad(85)));
    const b = Math.tan(theta - h);

    const depth = f.player.z * s; // player's distance from the net
    const zn = Math.max(depth + 0.8, COURT.HALF_LENGTH + 0.4);
    let zc = (a * zn + b * COURT.HALF_LENGTH + OPPONENT_HEIGHT) / (a - b);
    let height = a * (zc - zn);
    const x = f.player.x * FOLLOW_X;

    // Width: distance along the view axis to the near baseline vs. what its corners need.
    const sin = Math.sin(theta);
    const cos = Math.cos(theta);
    const along = height * sin + (zc - COURT.HALF_LENGTH) * cos;
    const tanH = Math.tan(vHalf) * this.aspect * WIDTH_MARGIN;
    const need = (COURT.HALF_WIDTH + Math.abs(x)) / tanH;
    if (along < need) {
      height += (need - along) * sin;
      zc += (need - along) * cos;
    }

    this.tPos.set(x, height, s * zc);
  }

  private updateOrbit(dt: number): void {
    const c = this.orbitCenter;
    if (this.shakeEnabled) this.orbitGoal += ORBIT_SPEED * dt;
    this.orbitAngle = damp(this.orbitAngle, this.orbitGoal, ORBIT_EASE, dt);
    this.orbitR = damp(this.orbitR, ORBIT_RADIUS, ORBIT_EASE, dt);
    this.orbitH = damp(this.orbitH, ORBIT_HEIGHT, ORBIT_EASE, dt);
    this.camera.position.set(c.x + Math.sin(this.orbitAngle) * this.orbitR, this.orbitH, c.z + Math.cos(this.orbitAngle) * this.orbitR);
    this.lookAt.set(c.x, ORBIT_LOOK_Y, c.z);
    this.lookM.lookAt(this.camera.position, this.lookAt, this.camera.up);
    this.orbitQ.slerp(this.tmpQ.setFromRotationMatrix(this.lookM), 1 - Math.exp(-ORBIT_EASE * 2.5 * dt));
    this.camera.quaternion.copy(this.orbitQ);
    this.fovPunch = 0;
    this.applyFov();
  }

  private applyFov(): void {
    this.camera.fov = this.baseFov - this.fovPunch;
    this.camera.updateProjectionMatrix();
  }

  private apply(): void {
    const k = this.kick * this.kick;
    this.camera.position.set(this.pos.x, this.pos.y - k * 0.25, this.pos.z - k * 0.6 * this.side);
    // Looking straight down the court toward the net, tilted down by the fixed pitch, plus shake.
    const s = this.trauma * this.trauma;
    const t = this.time;
    this.camera.rotation.set(
      -this.pitch + s * SHAKE_PITCH * noise(t, 1.3),
      (this.side === 1 ? 0 : Math.PI) + s * SHAKE_YAW * noise(t, 5.7),
      s * SHAKE_ROLL * noise(t, 9.2),
      'YXZ',
    );
  }
}
