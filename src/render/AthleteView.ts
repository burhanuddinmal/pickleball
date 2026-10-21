import * as THREE from 'three';
import type { Athlete } from '../players/Athlete';
import { PLAYER } from '../utils/Constants';
import { clamp, damp, lerp } from '../utils/MathUtils';
import { buildPaddle, PADDLE_FACE_CENTER, type PaddleLook } from './PaddleModel';
import { blobTexture } from './Textures';

export interface AthleteLook {
  shirt: string;
  shorts: string;
  skin: string;
  hair: string;
  shoes: string;
  band: string;
}

export const HERO_LOOK: AthleteLook = { shirt: '#ff5a4e', shorts: '#23324a', skin: '#e7b48f', hair: '#3b2a20', shoes: '#ffffff', band: '#ffd23f' };
export const RIVAL_LOOK: AthleteLook = { shirt: '#30c4a2', shorts: '#2b2b38', skin: '#a8714f', hair: '#16110e', shoes: '#f4f4f4', band: '#7a5cff' };

const SHOULDER_Y = 1.45;
const ARM_REACH = 0.86;
/** The primitive body is built ~1.85 m tall; scale it to the shared player height. */
const BODY_SCALE = PLAYER.MODEL_HEIGHT / 1.85;

const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

export type Reaction = 'win' | 'lose' | null;

/** What GameManager needs from a player view; implemented by the primitive and skinned models. */
export interface AthleteRig {
  readonly root: THREE.Group;
  /** Empty at the centre of the paddle face (for swoosh trails and whiff puffs). */
  readonly paddleTip: THREE.Object3D;
  update(a: Athlete, dt: number): void;
  setMarkerVisible(v: boolean): void;
  /** Pulses the ground ring (e.g. while it's this player's turn to hit). */
  setMarkerPulse(v: boolean): void;
  /** Point-end body language; null returns to normal play. */
  react(kind: Reaction): void;
  /** Paddle contact this swing; power contacts hold the follow-through. */
  onHit(intensity: number, power?: boolean): void;
}

/** Share of the swing spent on the extra wind-up (pull back and dip) before the stroke. */
const WINDUP = 0.15;
/** Seconds a power stroke holds its finish before relaxing. */
const FOLLOW_HOLD = 0.22;

/**
 * Procedural swing pose shared by both player models: right-arm yaw/pitch around the body
 * (Euler YXZ, arm hanging along -Y at rest) plus a torso twist. Pitch reaches for the ball's
 * contact height given the model's shoulder height and arm (+paddle) reach. A reaction pose
 * (win / lose) blends over everything at the end of a point; `bodyLift`, `torsoBend`, `headDrop`
 * and `dip` are extra offsets the rigs apply to the body.
 */
export class SwingPose {
  armYaw = -0.4;
  armPitch = 0.6;
  torsoTwist = 0;
  /** Vertical body offset (m): the win hop. */
  bodyLift = 0;
  /** Extra forward bend of the torso (radians). */
  torsoBend = 0;
  /** Head nod forward (radians), for rigs with a head pivot. */
  headDrop = 0;
  /** Extra crouch (m) during the wind-up. */
  dip = 0;
  private reaction: Reaction = null;
  /** Pose being shown or faded out (stays set after react(null)). */
  private shown: 'win' | 'lose' = 'win';
  private reactK = 0;
  private reactT = 0;
  private power = false;
  private hold = 0;
  private wasActive = false;

  react(kind: Reaction): void {
    if (kind !== this.reaction) this.reactT = 0;
    this.reaction = kind;
    if (kind) this.shown = kind;
  }

  onHit(intensity: number, power = intensity > 0.75): void {
    this.power = power;
  }

  update(a: Athlete, dt: number, shoulderY: number, reach: number): void {
    const sw = a.swing;
    let yaw = -0.45;
    let pitch = 0.75;
    let twist = 0;
    this.dip = 0;
    if (sw.active && !this.wasActive) this.power = false;
    if (!sw.active && this.wasActive) this.hold = this.power ? FOLLOW_HOLD : 0;
    this.wasActive = sw.active;
    if (sw.active) {
      const p = sw.t / PLAYER.SWING_DURATION;
      if (sw.kind === 'serve') {
        const k = easeOut((p - 0.1) / 0.6);
        yaw = -0.3;
        pitch = lerp(-0.9, 1.7, k);
        twist = lerp(-0.25, 0.3, k);
      } else {
        const h = sw.contact ? sw.contactHeight : 1.0;
        const reachPitch = Math.acos(clamp((shoulderY - h) / reach, -0.95, 0.97));
        const k = easeOut(p / 0.7);
        // Anticipation: pull further back and dip before the stroke comes through.
        const wind = p < WINDUP ? Math.sin((p / WINDUP) * Math.PI) : 0;
        // Power strokes carry a little further through.
        const extra = this.power ? 0.3 * k : 0;
        if (sw.hand === 'forehand') {
          yaw = lerp(-2.0, 1.0 + extra, k) - 0.45 * wind;
          twist = lerp(-0.55, 0.45 + extra * 0.5, k) - 0.2 * wind;
        } else {
          yaw = lerp(1.7, -1.3 - extra, k) + 0.45 * wind;
          twist = lerp(0.6, -0.4 - extra * 0.5, k) + 0.2 * wind;
        }
        this.dip = 0.06 * wind;
        pitch = reachPitch + Math.sin(k * Math.PI) * 0.15 + (k > 0.6 ? (k - 0.6) * 0.8 : 0);
      }
      this.armYaw = yaw;
      this.armPitch = pitch;
      this.torsoTwist = twist;
    } else if (this.hold > 0) {
      this.hold -= dt; // freeze the finish of a power stroke
    } else {
      this.armYaw = damp(this.armYaw, yaw, 10, dt);
      this.armPitch = damp(this.armPitch, pitch, 10, dt);
      this.torsoTwist = damp(this.torsoTwist, twist, 10, dt);
    }
    this.applyReaction(dt);
  }

  /** Blends the win / lose pose over the play pose. */
  private applyReaction(dt: number): void {
    this.reactT += dt;
    this.reactK = damp(this.reactK, this.reaction ? 1 : 0, this.reaction ? 7 : 5, dt);
    const k = this.reactK;
    if (k < 1e-3) {
      this.bodyLift = this.torsoBend = this.headDrop = 0;
      return;
    }
    const t = this.reactT;
    let yaw: number, pitch: number, twist: number, lift: number, bend: number, head: number;
    if (this.shown === 'lose') {
      // Head and shoulders drop, paddle arm hangs.
      yaw = -0.15;
      pitch = 0.12;
      twist = 0;
      lift = 0;
      bend = 0.32;
      head = 0.4;
    } else {
      // Paddle overhead with a little pump, plus two hops.
      yaw = -0.25;
      pitch = 2.85 + Math.sin(t * 9) * 0.12;
      twist = 0.1;
      lift = t < 0.7 ? Math.abs(Math.sin((t / 0.35) * Math.PI)) * (t < 0.35 ? 0.13 : 0.07) : 0;
      bend = -0.08;
      head = -0.15;
    }
    if (this.reaction === null) lift = 0;
    this.armYaw = lerp(this.armYaw, yaw, k);
    this.armPitch = lerp(this.armPitch, pitch, k);
    this.torsoTwist = lerp(this.torsoTwist, twist, k);
    this.bodyLift = lift * k;
    this.torsoBend = bend * k;
    this.headDrop = head * k;
  }
}

/** Gentle scale/opacity pulse for a player's ground ring. */
export class MarkerPulse {
  private k = 0;
  private t = 0;
  active = false;
  private readonly baseOpacity: number;

  constructor(private readonly marker: THREE.Mesh | null) {
    this.baseOpacity = marker ? (marker.material as THREE.MeshBasicMaterial).opacity : 0;
  }

  update(dt: number): void {
    if (!this.marker) return;
    this.t += dt;
    this.k = damp(this.k, this.active ? 1 : 0, 8, dt);
    const w = (0.5 + 0.5 * Math.sin(this.t * 7)) * this.k;
    this.marker.scale.setScalar(1 + 0.18 * w);
    (this.marker.material as THREE.MeshBasicMaterial).opacity = this.baseOpacity + (1 - this.baseOpacity) * w;
  }
}

/** Soft contact shadow plus optional ground ring marker under a player. */
export function addGroundDecals(root: THREE.Group, markerColor?: string): THREE.Mesh | null {
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(0.95, 0.95),
    new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, opacity: 0.55, depthWrite: false }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.007;
  root.add(blob);
  if (!markerColor) return null;
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.36, 0.43, 32),
    new THREE.MeshBasicMaterial({ color: markerColor, transparent: true, opacity: 0.75, depthWrite: false }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.009;
  root.add(marker);
  return marker;
}

/**
 * Stylized low-poly player built from primitives with procedural animation (run cycle,
 * side shuffle, ready crouch, forehand/backhand/serve swings). Reads Athlete state only.
 * Front of the model faces -Z. Fallback when the GLB player model fails to load.
 */
export class PrimitiveAthleteView implements AthleteRig {
  readonly root = new THREE.Group();
  readonly paddleTip = new THREE.Object3D();
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private head = new THREE.Group();
  private marker: THREE.Mesh | null = null;
  private markerPulse: MarkerPulse;
  private stride = 0;
  private crouch = 0;
  private lean = 0;
  private pose = new SwingPose();

  constructor(scene: THREE.Scene, look: AthleteLook, paddle: PaddleLook, markerColor?: string) {
    const mat = (c: string, r = 0.75) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
    const shirt = mat(look.shirt, 0.7);
    const skin = mat(look.skin, 0.6);
    const shorts = mat(look.shorts);
    const shoes = mat(look.shoes, 0.5);
    const cast = (m: THREE.Mesh) => ((m.castShadow = true), m);

    // Legs (pivot at hip).
    for (const [leg, x] of [[this.legL, -0.11], [this.legR, 0.11]] as const) {
      leg.position.set(x, 0.9, 0);
      const thigh = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.36, 3, 8), skin));
      thigh.position.y = -0.24;
      const shin = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.36, 3, 8), skin));
      shin.position.y = -0.62;
      const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.072, 0.08, 8), mat('#ffffff'));
      sock.position.y = -0.76;
      const shoe = cast(new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.08, 0.26), shoes));
      shoe.position.set(0, -0.86, -0.05);
      leg.add(thigh, shin, sock, shoe);
      this.body.add(leg);
    }

    const hips = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.2, 0.26, 12), shorts));
    hips.position.y = 0.92;
    this.body.add(hips);

    // Torso (pivot at waist so it can twist into swings).
    this.torso.position.y = 1.0;
    const chest = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.34, 4, 12), shirt));
    chest.position.y = 0.26;
    chest.scale.set(1.08, 1, 0.78);
    this.torso.add(chest);
    const number = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), mat(look.band, 0.5));
    number.position.set(0, 0.32, 0.165);
    this.torso.add(number);

    this.head.position.y = SHOULDER_Y - 1.0 + 0.27;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 8), skin);
    neck.position.y = -0.12;
    const skull = cast(new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), skin));
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.147, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(look.hair, 0.9));
    hair.rotation.x = 0.25;
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.142, 0.022, 6, 20), mat(look.band, 0.5));
    band.rotation.x = Math.PI / 2 + 0.2;
    band.position.y = 0.04;
    const eyeMat = mat('#1a1a1a', 0.3);
    for (const x of [-0.05, 0.05]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 6), eyeMat);
      eye.position.set(x, 0.02, -0.13);
      this.head.add(eye);
    }
    this.head.add(neck, skull, hair, band);
    this.torso.add(this.head);

    // Arms (pivot at shoulder). Euler order YXZ: yaw around the body, then raise/lower.
    for (const [arm, x] of [[this.armL, -0.27], [this.armR, 0.27]] as const) {
      arm.position.set(x, SHOULDER_Y - 1.0, 0);
      arm.rotation.order = 'YXZ';
      const sleeve = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.12, 3, 8), shirt));
      sleeve.position.y = -0.08;
      const upper = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.42, 3, 8), skin));
      upper.position.y = -0.28;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), skin);
      hand.position.y = -0.55;
      arm.add(sleeve, upper, hand);
      this.torso.add(arm);
    }
    const holder = new THREE.Group();
    holder.position.y = -0.56;
    holder.rotateZ(Math.PI);
    holder.rotateY(Math.PI / 2);
    holder.rotateX(-0.25);
    const pad = buildPaddle(paddle);
    pad.scale.setScalar(PLAYER.PADDLE_SCALE / BODY_SCALE);
    this.paddleTip.position.y = PADDLE_FACE_CENTER;
    pad.add(this.paddleTip);
    holder.add(pad);
    this.armR.add(holder);

    this.body.add(this.torso);
    this.body.scale.setScalar(BODY_SCALE);
    this.root.add(this.body);

    this.marker = addGroundDecals(this.root, markerColor);
    this.markerPulse = new MarkerPulse(this.marker);
    scene.add(this.root);
  }

  update(a: Athlete, dt: number): void {
    this.root.position.set(a.pos.x, 0, a.pos.z);
    this.markerPulse.update(dt);
    this.body.rotation.y = a.facing;

    // Velocity in the body's local frame (forward = -Z in model space).
    const sin = Math.sin(a.facing);
    const cos = Math.cos(a.facing);
    const fwd = -a.vel.x * sin - a.vel.z * cos;
    const side = a.vel.x * cos - a.vel.z * sin;
    const speed = Math.hypot(a.vel.x, a.vel.z);
    const run = clamp(speed / PLAYER.RUN_SPEED, 0, 1.3);

    this.stride += speed * dt * 3.1;
    const swingL = Math.sin(this.stride) * run;
    const fwdShare = speed > 0.05 ? fwd / speed : 0;
    const sideShare = speed > 0.05 ? side / speed : 0;
    this.legL.rotation.x = swingL * 0.75 * fwdShare;
    this.legR.rotation.x = -swingL * 0.75 * fwdShare;
    this.legL.rotation.z = Math.max(0, swingL) * 0.35 * sideShare - 0.05;
    this.legR.rotation.z = Math.min(0, swingL) * 0.35 * sideShare + 0.05;

    // Ready crouch; deeper for low balls during a swing.
    let crouchTarget = 0.06 + run * 0.04;
    if (a.swing.active && a.swing.kind === 'stroke') crouchTarget += clamp(0.75 - a.swing.contactHeight, 0, 0.3);
    this.crouch = damp(this.crouch, crouchTarget, 14, dt);
    const bob = Math.abs(Math.cos(this.stride)) * 0.05 * run;
    this.lean = damp(this.lean, clamp(fwd * 0.05, -0.15, 0.25), 10, dt);

    this.armL.rotation.x = 0.35 + swingL * 0.5 * fwdShare;
    this.armL.rotation.z = -0.25;

    const pose = this.pose;
    pose.update(a, dt, SHOULDER_Y * BODY_SCALE - this.crouch, ARM_REACH * BODY_SCALE);
    this.armR.rotation.y = pose.armYaw - pose.torsoTwist;
    this.armR.rotation.x = pose.armPitch;
    this.torso.rotation.y = pose.torsoTwist;
    this.body.position.y = -this.crouch - pose.dip + bob + pose.bodyLift;
    this.torso.rotation.x = -this.lean - (this.crouch + pose.dip) * 0.8 - pose.torsoBend;
    this.head.rotation.x = -pose.headDrop;
  }

  setMarkerVisible(v: boolean): void {
    if (this.marker) this.marker.visible = v;
  }

  setMarkerPulse(v: boolean): void {
    this.markerPulse.active = v;
  }

  react(kind: Reaction): void {
    this.pose.react(kind);
  }

  onHit(intensity: number, power?: boolean): void {
    this.pose.onHit(intensity, power);
  }
}
