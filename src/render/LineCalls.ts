import * as THREE from 'three';
import { COURT, type Side } from '../utils/Constants';
import { clamp } from '../utils/MathUtils';
import { labelTexture, ringTexture } from './Textures';

const OUT_POP = 0.28;
const CLOSE_LIFE = 0.8;
const OUT_LABEL_H = 0.7;
const CLOSE_LABEL_H = 0.42;

/** Back-out easing with a little overshoot, for label pop-ins. */
const easeOutBack = (t: number): number => {
  const k = clamp(t, 0, 1) - 1;
  return 1 + k * k * (2.7 * k + 1.7);
};

/**
 * Line-call presentation: a persistent "OUT" mark (ground ring + upright label) at the bounce
 * that ended the rally, and a short "CLOSE!" flash with a line highlight for in-bounds bounces
 * that land near a sideline or baseline. Purely visual; GameManager decides when to show them.
 */
export class LineCalls {
  private outRing: THREE.Mesh;
  private outLabel: THREE.Sprite;
  private outT = OUT_POP;
  private outW: number;
  private strip: THREE.Mesh;
  private stripMat: THREE.MeshBasicMaterial;
  private closeLabel: THREE.Sprite;
  private closeT = CLOSE_LIFE;
  private closeW: number;
  private closeY = 0;

  constructor(scene: THREE.Scene) {
    this.outRing = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, 0.62),
      new THREE.MeshBasicMaterial({ map: ringTexture(), color: 0xff4a3a, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    this.outRing.rotation.x = -Math.PI / 2;
    this.outRing.renderOrder = 3;

    const outTex = labelTexture('OUT', '#ff5a4a');
    this.outW = OUT_LABEL_H * (outTex.userData.aspect as number);
    this.outLabel = makeLabel(outTex);

    this.stripMat = new THREE.MeshBasicMaterial({
      color: 0xfff3a0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.strip = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.stripMat);
    this.strip.rotation.x = -Math.PI / 2;
    this.strip.renderOrder = 3;

    const closeTex = labelTexture('CLOSE!', '#ffe14d');
    this.closeW = CLOSE_LABEL_H * (closeTex.userData.aspect as number);
    this.closeLabel = makeLabel(closeTex);

    this.clear();
    scene.add(this.outRing, this.outLabel, this.strip, this.closeLabel);
  }

  /** Marks the out bounce at (x, z) until clear(). */
  showOut(x: number, z: number): void {
    this.outRing.position.set(x, 0.014, z);
    this.outLabel.position.set(x, 0.05, z);
    this.outRing.visible = this.outLabel.visible = true;
    this.outT = 0;
  }

  /** In-bounds bounce at (x, z) just inside a line. `viewSide` is the side the camera is on. */
  showClose(x: number, z: number, viewSide: Side): void {
    const dSide = Math.hypot(Math.abs(x) - COURT.HALF_WIDTH, Math.max(0, Math.abs(z) - COURT.HALF_LENGTH));
    const dBase = Math.hypot(Math.abs(z) - COURT.HALF_LENGTH, Math.max(0, Math.abs(x) - COURT.HALF_WIDTH));
    const w = COURT.LINE_WIDTH * 2.2;
    if (dSide <= dBase) {
      this.strip.position.set(Math.sign(x) * COURT.HALF_WIDTH, 0.015, clamp(z, -COURT.HALF_LENGTH, COURT.HALF_LENGTH));
      this.strip.scale.set(w, 1.6, 1);
    } else {
      this.strip.position.set(clamp(x, -COURT.HALF_WIDTH, COURT.HALF_WIDTH), 0.015, Math.sign(z) * COURT.HALF_LENGTH);
      this.strip.scale.set(1.6, w, 1);
    }
    // Float the label a little toward the camera so it doesn't sit on top of the mark.
    this.closeLabel.position.set(x, 0.25, z + viewSide * 0.3);
    this.closeY = 0.25;
    this.strip.visible = this.closeLabel.visible = true;
    this.closeT = 0;
  }

  clear(): void {
    this.outRing.visible = this.outLabel.visible = false;
    this.strip.visible = this.closeLabel.visible = false;
    this.outT = OUT_POP;
    this.closeT = CLOSE_LIFE;
  }

  update(dt: number): void {
    if (this.outLabel.visible) {
      this.outT = Math.min(OUT_POP, this.outT + dt);
      const s = easeOutBack(this.outT / OUT_POP);
      this.outLabel.scale.set(this.outW * s, OUT_LABEL_H * s, 1);
      this.outRing.scale.setScalar(0.4 + 0.6 * s);
    }
    if (this.closeLabel.visible) {
      this.closeT += dt;
      const k = this.closeT / CLOSE_LIFE;
      if (k >= 1) {
        this.strip.visible = this.closeLabel.visible = false;
        return;
      }
      const s = easeOutBack(this.closeT / 0.2);
      this.closeLabel.scale.set(this.closeW * s, CLOSE_LABEL_H * s, 1);
      this.closeLabel.position.y = this.closeY + k * 0.35;
      const fade = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      (this.closeLabel.material as THREE.SpriteMaterial).opacity = fade;
      // Line highlight: quick double blink, then fade.
      this.stripMat.opacity = (0.55 + 0.45 * Math.cos(this.closeT * 28)) * (1 - k);
    }
  }
}

function makeLabel(map: THREE.Texture): THREE.Sprite {
  // Always on top: a call must stay readable behind the net or a player.
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, depthWrite: false }));
  s.center.set(0.5, 0);
  s.renderOrder = 6;
  return s;
}
