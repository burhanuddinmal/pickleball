import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Athlete } from '../players/Athlete';
import { PLAYER } from '../utils/Constants';
import { clamp, damp } from '../utils/MathUtils';
import { cloneAthlete, findBones, type BoneKey } from './AthleteModel';
import { addGroundDecals, SwingPose, type AthleteLook, type AthleteRig } from './AthleteView';
import { buildPaddle, type PaddleLook } from './PaddleModel';

/** Rendered height of the (big-headed) Quaternius character, in metres. */
const MODEL_HEIGHT = 2.0;
const PADDLE_SCALE = 1.3;
/** Paddle centre measured from the butt of the handle (see PaddleModel), before scaling. */
const PADDLE_CENTER = 0.13 + 0.27 / 2;

const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Rigged GLB player. Legs and idle sway come from the Idle/Run clips; the swing pose
 * (SwingPose, shared with the primitive model) is written onto the torso and right-arm bones
 * after the mixer runs, so it overrides the clip on those bones. Front faces -Z like the
 * primitive model; reads Athlete state only.
 */
export class SkinnedAthleteView implements AthleteRig {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private model: THREE.Object3D;
  private bones: Record<BoneKey, THREE.Bone>;
  private mixer: THREE.AnimationMixer;
  private idle: THREE.AnimationAction;
  private run: THREE.AnimationAction;
  private holder = new THREE.Group();
  private marker: THREE.Mesh | null;
  private pose = new SwingPose();
  private shoulderY: number;
  private reach: number;
  private lean = 0;

  // Scratch objects reused every frame.
  private bodyQ = new THREE.Quaternion();
  private torsoQ = new THREE.Quaternion();
  private armQ = new THREE.Quaternion();
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private qc = new THREE.Quaternion();
  private qd = new THREE.Quaternion();
  private dir = new THREE.Vector3();
  private va = new THREE.Vector3();
  private vb = new THREE.Vector3();
  private euler = new THREE.Euler();

  constructor(scene: THREE.Scene, gltf: GLTF, look: AthleteLook, paddle: PaddleLook, markerColor?: string) {
    this.model = cloneAthlete(gltf, look);
    this.bones = findBones(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    const clip = (name: string) => {
      const c = THREE.AnimationClip.findByName(gltf.animations, name);
      if (!c) throw new Error(`Athlete model is missing clip "${name}"`);
      return this.mixer.clipAction(c);
    };
    this.idle = clip('Idle').play();
    this.run = clip('Run').play();
    this.run.setEffectiveWeight(0);

    // The GLB faces +Z and is ~3 units tall: turn it around and scale to MODEL_HEIGHT.
    this.mixer.update(0);
    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model, true);
    this.model.scale.setScalar(MODEL_HEIGHT / (box.max.y - box.min.y));
    this.model.position.y = -box.min.y * this.model.scale.y;
    this.model.rotation.y = Math.PI;
    this.body.add(this.model);
    this.root.add(this.body);
    this.root.updateMatrixWorld(true);

    // Swing reach: shoulder height and shoulder→fist length, plus the paddle out to its centre.
    const { upperArmR, lowerArmR, fistR } = this.bones;
    const shoulder = upperArmR.getWorldPosition(new THREE.Vector3());
    const elbow = lowerArmR.getWorldPosition(new THREE.Vector3());
    const fist = fistR.getWorldPosition(new THREE.Vector3());
    this.shoulderY = shoulder.y;
    this.reach = shoulder.distanceTo(elbow) + elbow.distanceTo(fist) + PADDLE_CENTER * PADDLE_SCALE;

    // Same paddle mounting as the primitive model's hand, in the arm's frame.
    const mount = new THREE.Group();
    mount.rotateZ(Math.PI);
    mount.rotateY(Math.PI / 2);
    mount.rotateX(-0.25);
    const pad = buildPaddle(paddle);
    pad.scale.setScalar(PADDLE_SCALE);
    mount.add(pad);
    this.holder.add(mount);
    this.body.add(this.holder);

    this.marker = addGroundDecals(this.root, markerColor);
    scene.add(this.root);
  }

  update(a: Athlete, dt: number): void {
    this.root.position.set(a.pos.x, 0, a.pos.z);
    this.body.rotation.y = a.facing;

    const sin = Math.sin(a.facing);
    const cos = Math.cos(a.facing);
    const fwd = -a.vel.x * sin - a.vel.z * cos;
    const speed = Math.hypot(a.vel.x, a.vel.z);
    const run = clamp(speed / PLAYER.RUN_SPEED, 0, 1.3);

    // Locomotion clips: blend Idle→Run by speed; play Run backwards when backpedalling.
    const runWeight = clamp(run * 2, 0, 1);
    this.run.setEffectiveWeight(runWeight);
    this.idle.setEffectiveWeight(1 - runWeight);
    this.run.timeScale = (fwd < -0.3 * speed ? -1 : 1) * clamp(run, 0.6, 1.3);
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);

    this.pose.update(a, dt, this.shoulderY, this.reach);
    this.lean = damp(this.lean, clamp(fwd * 0.05, -0.15, 0.25), 10, dt);
    const { torsoTwist, armYaw, armPitch } = this.pose;
    this.body.getWorldQuaternion(this.bodyQ);

    // Torso: lean + twist about the body's axes, on top of the clip.
    this.torsoQ.setFromEuler(this.euler.set(-this.lean, torsoTwist, 0, 'XYZ'));
    this.rotateBoneInBody(this.bones.torso, this.torsoQ);
    this.bones.torso.updateMatrixWorld(true);

    // Right arm: same frame as the primitive arm (child of the torso, hanging along -Y).
    this.armQ.setFromEuler(this.euler.set(armPitch, armYaw - torsoTwist, 0, 'YXZ'));
    this.armQ.premultiply(this.torsoQ);
    this.dir.copy(DOWN).applyQuaternion(this.armQ).applyQuaternion(this.bodyQ);
    this.aimBone(this.bones.upperArmR, this.bones.lowerArmR, this.dir);
    this.aimBone(this.bones.lowerArmR, this.bones.fistR, this.dir);

    // Paddle follows the fist position with the primitive model's hand orientation.
    this.holder.position.copy(this.body.worldToLocal(this.bones.fistR.getWorldPosition(this.va)));
    this.holder.quaternion.copy(this.armQ);
  }

  setMarkerVisible(v: boolean): void {
    if (this.marker) this.marker.visible = v;
  }

  /** Applies a rotation expressed in the body's frame to a bone's current (animated) pose. */
  private rotateBoneInBody(bone: THREE.Bone, q: THREE.Quaternion): void {
    // World-space delta: B · q · B⁻¹, with B the body's world rotation.
    this.qc.copy(this.bodyQ).multiply(q).multiply(this.qd.copy(this.bodyQ).invert());
    this.applyWorldDelta(bone, this.qc);
  }

  /** Rotates `bone` (minimal arc) so the direction to `child` points along world `dir`. */
  private aimBone(bone: THREE.Bone, child: THREE.Object3D, dir: THREE.Vector3): void {
    bone.getWorldPosition(this.va);
    child.getWorldPosition(this.vb);
    this.qc.setFromUnitVectors(this.vb.sub(this.va).normalize(), dir);
    this.applyWorldDelta(bone, this.qc);
    bone.updateMatrixWorld(true);
  }

  /** world' = delta · world  →  local' = P⁻¹ · delta · P · local, with P the parent's world rotation. */
  private applyWorldDelta(bone: THREE.Bone, delta: THREE.Quaternion): void {
    bone.parent!.getWorldQuaternion(this.qa);
    this.qb.copy(this.qa).invert().multiply(delta).multiply(this.qa);
    bone.quaternion.premultiply(this.qb);
  }
}
