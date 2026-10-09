import * as THREE from 'three';
import type { Athlete } from '../players/Athlete';
import { PLAYER } from '../utils/Constants';
import { clamp, damp, lerp } from '../utils/MathUtils';
import { buildPaddle, type PaddleLook } from './PaddleModel';
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

const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

/** What GameManager needs from a player view; implemented by the primitive and skinned models. */
export interface AthleteRig {
  readonly root: THREE.Group;
  update(a: Athlete, dt: number): void;
  setMarkerVisible(v: boolean): void;
}

/**
 * Procedural swing pose shared by both player models: right-arm yaw/pitch around the body
 * (Euler YXZ, arm hanging along -Y at rest) plus a torso twist. Pitch reaches for the ball's
 * contact height given the model's shoulder height and arm (+paddle) reach.
 */
export class SwingPose {
  armYaw = -0.4;
  armPitch = 0.6;
  torsoTwist = 0;

  update(a: Athlete, dt: number, shoulderY: number, reach: number): void {
    const sw = a.swing;
    let yaw = -0.45;
    let pitch = 0.75;
    let twist = 0;
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
        if (sw.hand === 'forehand') {
          yaw = lerp(-2.0, 1.0, k);
          twist = lerp(-0.55, 0.45, k);
        } else {
          yaw = lerp(1.7, -1.3, k);
          twist = lerp(0.6, -0.4, k);
        }
        pitch = reachPitch + Math.sin(k * Math.PI) * 0.15 + (k > 0.6 ? (k - 0.6) * 0.8 : 0);
      }
      this.armYaw = yaw;
      this.armPitch = pitch;
      this.torsoTwist = twist;
    } else {
      this.armYaw = damp(this.armYaw, yaw, 10, dt);
      this.armPitch = damp(this.armPitch, pitch, 10, dt);
      this.torsoTwist = damp(this.torsoTwist, twist, 10, dt);
    }
  }
}

/** Soft contact shadow plus optional ground ring marker under a player. */
export function addGroundDecals(root: THREE.Group, markerColor?: string): THREE.Mesh | null {
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 1.1),
    new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, opacity: 0.55, depthWrite: false }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.007;
  root.add(blob);
  if (!markerColor) return null;
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.5, 32),
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
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private head = new THREE.Group();
  private marker: THREE.Mesh | null = null;
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
    pad.scale.setScalar(1.15);
    holder.add(pad);
    this.armR.add(holder);

    this.body.add(this.torso);
    this.root.add(this.body);

    this.marker = addGroundDecals(this.root, markerColor);
    scene.add(this.root);
  }

  update(a: Athlete, dt: number): void {
    this.root.position.set(a.pos.x, 0, a.pos.z);
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
    this.body.position.y = -this.crouch + bob;
    this.lean = damp(this.lean, clamp(fwd * 0.05, -0.15, 0.25), 10, dt);
    this.torso.rotation.x = -this.lean - this.crouch * 0.8;

    this.armL.rotation.x = 0.35 + swingL * 0.5 * fwdShare;
    this.armL.rotation.z = -0.25;

    this.animateSwing(a, dt);
  }

  private animateSwing(a: Athlete, dt: number): void {
    const pose = this.pose;
    pose.update(a, dt, SHOULDER_Y - this.crouch, ARM_REACH);
    this.armR.rotation.y = pose.armYaw - pose.torsoTwist;
    this.armR.rotation.x = pose.armPitch;
    this.torso.rotation.y = pose.torsoTwist;
  }

  setMarkerVisible(v: boolean): void {
    if (this.marker) this.marker.visible = v;
  }
}
