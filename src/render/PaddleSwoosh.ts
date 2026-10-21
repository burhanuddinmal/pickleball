import * as THREE from 'three';
import type { Athlete } from '../players/Athlete';
import { PLAYER } from '../utils/Constants';
import { clamp } from '../utils/MathUtils';
import type { AthleteRig } from './AthleteView';
import { RibbonTrail } from './RibbonTrail';

const POINTS = 12;
/** Ribbon half-width (m) at the peak of the swing. */
const WIDTH = 0.1;
/** Minimum tip travel (m) before a new point is recorded, so hit-stop freezes the ribbon. */
const MIN_STEP = 0.004;

/** Ribbon behind the paddle face while a swing is active, swelling and fading with its progress. */
export class PaddleSwoosh {
  private trail = new RibbonTrail(POINTS);
  private readonly color: THREE.Color;
  private readonly tip = new THREE.Vector3();
  private readonly last = new THREE.Vector3();

  constructor(scene: THREE.Scene, color: THREE.ColorRepresentation) {
    this.color = new THREE.Color(color);
    scene.add(this.trail.mesh);
  }

  /** Call after the rig has been updated for this frame. */
  update(a: Athlete, rig: AthleteRig, camera: THREE.Camera): void {
    const sw = a.swing;
    if (!sw.active) {
      if (this.trail.length) this.trail.reset();
      return;
    }
    rig.paddleTip.getWorldPosition(this.tip);
    if (this.trail.length === 0 || this.tip.distanceToSquared(this.last) > MIN_STEP * MIN_STEP) {
      this.trail.push(this.tip);
      this.last.copy(this.tip);
    }
    const env = Math.sin(Math.PI * clamp(sw.t / PLAYER.SWING_DURATION, 0, 1));
    const show = this.trail.length > 2 && env > 0.02;
    this.trail.mesh.visible = show;
    if (show) this.trail.build(camera, WIDTH * (0.35 + 0.65 * env), this.color, 0.85 * env);
  }
}
