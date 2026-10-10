import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface CrowdLayoutOptions {
  /** Half width of the fenced area; bleacher rows start just outside it. */
  fx: number;
  /** Half length of the fenced area; rows run along z. */
  fz: number;
  rows: number;
  /** Depth (x) of one bleacher step. */
  rowDepth: number;
  /** Height of the step top for row 0; each row above adds 2× this (matches the step blocks). */
  rowRise: number;
  /** Centre-to-centre spacing between neighbouring seats along a row. */
  seatPitch: number;
  /** Widest footprint of one spectator (shoulders/arms, incl. slight yaw) at scale 1. */
  personWidth: number;
  /** Fraction of seats filled, 0..1. */
  occupancy: number;
}

export interface CrowdSeat {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  side: 1 | -1;
  row: number;
}

export const CROWD_LAYOUT_DEFAULTS = { rows: 5, rowDepth: 1.1, rowRise: 0.45, seatPitch: 0.6, personWidth: 0.5 };

/** Distance from the hip origin to the back of the shins (model units), so the shins hang just past the step edge. */
const SHIN_BACK = 0.25;

/** Centre x of bleacher row `r` on side `s`; must match the step blocks in Environment. */
export function rowCenterX(fx: number, s: number, r: number, rowDepth: number): number {
  return s * (fx + 1.2 + r * rowDepth);
}

/**
 * Assigns spectators to a fixed grid of seats so nobody overlaps: every seat is used at most once and
 * per-person jitter is bounded by the free space left between neighbours at their scale.
 */
export function layoutCrowdSeats(o: CrowdLayoutOptions, rand: () => number = Math.random): CrowdSeat[] {
  const len = o.fz * 1.5;
  const perRow = Math.floor(len / o.seatPitch);
  const slots: { s: 1 | -1; r: number; z: number }[] = [];
  for (const s of [1, -1] as const) {
    for (let r = 0; r < o.rows; r++) {
      // Odd rows are staggered by half a seat (and lose one seat to stay inside the step).
      const odd = r % 2 === 1;
      const n = odd ? perRow - 1 : perRow;
      for (let i = 0; i < n; i++) slots.push({ s, r, z: -len / 2 + o.seatPitch * (i + 0.5 + (odd ? 0.5 : 0)) });
    }
  }
  // Fisher–Yates, then take the first N: unique seats with natural gaps.
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const count = Math.round(slots.length * Math.min(1, Math.max(0, o.occupancy)));
  const seats: CrowdSeat[] = [];
  for (let k = 0; k < count; k++) {
    const { s, r, z: z0 } = slots[k];
    const scale = 0.92 + rand() * 0.16;
    const maxJitter = Math.max(0, (o.seatPitch - o.personWidth * scale) / 2);
    const z = z0 + (rand() * 2 - 1) * maxJitter;
    // Sit at the front edge of the step, facing the court, turned slightly toward the net.
    const x = rowCenterX(o.fx, s, r, o.rowDepth) - s * (o.rowDepth / 2 - SHIN_BACK * scale);
    const toNet = -s * 0.15 * (z / (len / 2));
    const yaw = -s * (Math.PI / 2) + toNet + (rand() * 2 - 1) * 0.05;
    seats.push({ x, y: o.rowRise * (1 + r * 2), z, yaw, scale, side: s, row: r });
  }
  return seats;
}

const PART = { SKIN: 0, SHIRT: 1, PANTS: 2, HAIR: 3 };
const SHOULDER = { x: 0.19, y: 0.42 };
const ARM_REST = -0.6;

/** Seated low-poly spectator (~170 tris) facing +Z with the origin at the hips on the seat. */
export function buildSpectatorGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (geo: THREE.BufferGeometry, part: number, arm = 0) => {
    geo.deleteAttribute('uv');
    const n = geo.getAttribute('position').count;
    geo.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(n).fill(part), 1));
    geo.setAttribute('aArm', new THREE.Float32BufferAttribute(new Array(n).fill(arm), 1));
    parts.push(geo);
  };
  add(new THREE.CylinderGeometry(0.16, 0.13, 0.42, 6).scale(1, 1, 0.7).translate(0, 0.24, 0), PART.SHIRT);
  add(new THREE.SphereGeometry(0.1, 6, 4).translate(0, 0.56, 0.01), PART.SKIN);
  add(new THREE.BoxGeometry(0.2, 0.07, 0.2).translate(0, 0.64, -0.01), PART.HAIR);
  for (const side of [1, -1]) {
    add(
      new THREE.BoxGeometry(0.08, 0.36, 0.09).translate(0, -0.18, 0).rotateX(ARM_REST).translate(side * SHOULDER.x, SHOULDER.y, 0),
      PART.SHIRT,
      side,
    );
    add(new THREE.BoxGeometry(0.13, 0.13, 0.42).translate(side * 0.075, 0.065, 0.17), PART.PANTS);
    add(new THREE.BoxGeometry(0.11, 0.42, 0.12).translate(side * 0.075, -0.15, 0.32), PART.PANTS);
  }
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('[Crowd] failed to merge spectator geometry');
  return merged;
}

const SHIRTS = [0xe85d4a, 0xf2c14e, 0x4fb3bf, 0xffffff, 0x7a5cff, 0x2e2e38, 0x5cc96b, 0xff8fb1];
const SKINS = [0xf1c7a5, 0xe0ac84, 0xc68b62, 0x9c6a45, 0x6e4a32, 0x4a3122];
const PANTS = [0x2b3a55, 0x3b3b42, 0x5a4a3a, 0x1e2a3a, 0x7d8a99, 0xc9b79c];
const HAIR = [0x1c1612, 0x3b2a1e, 0x6b4a2b, 0xb8925a, 0x8a8a8a, 0xd8442e];

/** Gasp envelope: lean-in time and relax time (s). */
const GASP_IN = 0.12;
const GASP_OUT = 0.9;

/**
 * Instanced low-poly crowd: one draw call. Colours per body part come from per-vertex part ids and
 * per-instance palettes; idle bobbing (faster and bigger with rally tension), the post-point cheer
 * and the forward-lean gasp run entirely in the vertex shader.
 */
export class Crowd {
  readonly mesh: THREE.InstancedMesh;
  private uniforms = { uTime: { value: 0 }, uCheer: { value: 0 }, uTension: { value: 0 }, uBob: { value: 0 }, uLean: { value: 0 } };
  private tension = 0;
  private gaspT = Infinity;

  constructor(seats: CrowdSeat[], rand: () => number = Math.random) {
    const n = seats.length;
    const geo = buildSpectatorGeometry();
    const skin = new Float32Array(n * 3);
    const pants = new Float32Array(n * 3);
    const hair = new Float32Array(n * 3);
    const phase = new Float32Array(n);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.name = 'crowd';

    const pick = (list: number[]) => list[Math.floor(rand() * list.length)];
    const c = new THREE.Color();
    const mtx = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    seats.forEach((st, i) => {
      mtx.compose(pos.set(st.x, st.y, st.z), quat.setFromAxisAngle(up, st.yaw), scl.setScalar(st.scale));
      this.mesh.setMatrixAt(i, mtx);
      this.mesh.setColorAt(i, c.setHex(pick(SHIRTS)));
      c.setHex(pick(SKINS)).toArray(skin, i * 3);
      c.setHex(pick(PANTS)).toArray(pants, i * 3);
      c.setHex(pick(HAIR)).toArray(hair, i * 3);
      phase[i] = rand() * Math.PI * 2;
    });
    geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));
    geo.setAttribute('aPants', new THREE.InstancedBufferAttribute(pants, 3));
    geo.setAttribute('aHair', new THREE.InstancedBufferAttribute(hair, 3));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));

    mat.customProgramCacheKey = () => 'crowd';
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime;
          uniform float uCheer;
          uniform float uTension;
          uniform float uBob;
          uniform float uLean;
          attribute float aPart;
          attribute float aArm;
          attribute float aPhase;
          attribute vec3 aSkin;
          attribute vec3 aPants;
          attribute vec3 aHair;`,
        )
        .replace(
          '#include <color_vertex>',
          `vColor = vec4(1.0);
          #ifdef USE_INSTANCING_COLOR
            vec3 shirt = instanceColor.rgb;
          #else
            vec3 shirt = vec3(1.0);
          #endif
          vColor.rgb = aPart < 0.5 ? aSkin : aPart < 1.5 ? shirt : aPart < 2.5 ? aPants : aHair;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float cheer = clamp(uCheer * 1.3, 0.0, 1.0);
          if (aArm != 0.0) {
            // Raise arms from the lap to overhead, with a little wave.
            float ang = -(${(Math.PI + ARM_REST).toFixed(4)}) * cheer * (0.8 + 0.2 * sin(uTime * 9.0 + aPhase + aArm));
            vec3 pivot = vec3(aArm * ${SHOULDER.x.toFixed(3)}, ${SHOULDER.y.toFixed(3)}, 0.0);
            vec3 d = transformed - pivot;
            float cs = cos(ang), sn = sin(ang);
            transformed = pivot + vec3(d.x, d.y * cs - d.z * sn, d.y * sn + d.z * cs);
          }
          if (aPart != ${PART.PANTS.toFixed(1)}) {
            // Gasp: upper body leans toward the court about the hips (model faces +Z).
            float lean = uLean * (0.28 + 0.1 * sin(aPhase * 3.0));
            float lc = cos(lean), ls = sin(lean);
            vec3 d = transformed - vec3(0.0, 0.05, 0.0);
            transformed = vec3(0.0, 0.05, 0.0) + vec3(d.x, d.y * lc - d.z * ls, d.y * ls + d.z * lc);
          }
          // uBob is the idle bob phase, advanced faster as rally tension rises.
          transformed.y += sin(uBob + aPhase) * (0.012 + 0.022 * uTension) + cheer * max(0.0, sin(uTime * 10.0 + aPhase)) * 0.08;`,
        );
    };
  }

  update(dt: number): void {
    const u = this.uniforms;
    u.uTime.value += dt;
    u.uCheer.value = Math.max(0, u.uCheer.value - dt / 1.5);
    u.uTension.value += (this.tension - u.uTension.value) * (1 - Math.exp(-2 * dt));
    u.uBob.value += dt * (2 + 4 * u.uTension.value);
    this.gaspT += dt;
    const g = this.gaspT;
    u.uLean.value = g < GASP_IN ? g / GASP_IN : g < GASP_IN + GASP_OUT ? 1 - (g - GASP_IN) / GASP_OUT : 0;
  }

  /** Rally tension 0..1 (eased): restless, quicker bobbing as a rally goes long. */
  setTension(v: number): void {
    this.tension = Math.min(1, Math.max(0, v));
  }

  /** Collective intake of breath: a quick lean toward the court (net cords, close calls). */
  gasp(): void {
    this.gaspT = 0;
  }

  /** Celebrate a point; strength 0..1. Decays back to idle over ~1.5 s. */
  cheer(strength: number): void {
    this.uniforms.uCheer.value = Math.max(this.uniforms.uCheer.value, strength);
  }
}
