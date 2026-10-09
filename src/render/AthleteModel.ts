import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AthleteLook } from './AthleteView';

/** Quaternius "Casual_Male" (Ultimate Animated Character Pack), trimmed to Idle + Run. */
export const ATHLETE_MODEL_URL = `${import.meta.env.BASE_URL}models/athlete.glb`;

/** Logical bone → node name in the GLB (three.js strips the dots, e.g. "UpperArm.R" → "UpperArmR"). */
export const BONES = {
  hips: 'Hips',
  torso: 'Torso',
  upperArmR: 'UpperArmR',
  lowerArmR: 'LowerArmR',
  fistR: 'FistR',
} as const;

export type BoneKey = keyof typeof BONES;

/** GLB material name → AthleteLook colour. Unlisted materials (Belt, Face) keep their own colour. */
const MATERIAL_LOOK: Record<string, keyof AthleteLook> = {
  Skin: 'skin',
  Shirt: 'shirt',
  Pants: 'shorts',
  Hair: 'hair',
};

export function loadAthleteModel(url: string, onProgress?: (p: number) => void): Promise<GLTF> {
  return new GLTFLoader().loadAsync(url, (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  });
}

/** Independent copy (own skeleton + materials) tinted to the given look. */
export function cloneAthlete(gltf: GLTF, look: AthleteLook): THREE.Object3D {
  const root = cloneSkinned(gltf.scene);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    // Bind-pose bounds don't follow the animation; never cull the player.
    mesh.frustumCulled = false;
    const src = mesh.material as THREE.MeshStandardMaterial;
    const mat = src.clone();
    const key = MATERIAL_LOOK[src.name];
    if (key) mat.color.set(look[key]);
    mesh.material = mat;
  });
  return root;
}

export function findBones(root: THREE.Object3D): Record<BoneKey, THREE.Bone> {
  const out = {} as Record<BoneKey, THREE.Bone>;
  for (const key of Object.keys(BONES) as BoneKey[]) {
    const bone = root.getObjectByName(BONES[key]);
    if (!bone) throw new Error(`Athlete model is missing bone "${BONES[key]}"`);
    out[key] = bone as THREE.Bone;
  }
  return out;
}
