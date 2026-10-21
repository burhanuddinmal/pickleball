import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export type GraphicsQuality = 'low' | 'medium' | 'high';

export function detectQuality(): GraphicsQuality {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (mobile) return cores >= 6 ? 'medium' : 'low';
  return cores >= 4 ? 'high' : 'medium';
}

/**
 * Bloom on 'high' only. The threshold is on linear scene radiance, above lit diffuse surfaces, so
 * only emissive and additive things glow: the ball rim, lamps, hit flashes, the tape flash.
 */
const BLOOM = { strength: 0.55, radius: 0.35, threshold: 0.95 };

/** Owns the WebGL renderer, scene, base lighting, optional bloom and resize handling. */
export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private resizeListeners: ((w: number, h: number) => void)[] = [];
  private composer: EffectComposer | null = null;

  constructor(
    private container: HTMLElement,
    public quality: GraphicsQuality,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: quality !== 'low', powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('game-canvas');

    this.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x4a6b3a, 1.1);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff3e0, 2.3);
    this.sun.position.set(-8, 18, 6);
    this.sun.target.position.set(0, 0, 0);
    this.scene.add(this.sun, this.sun.target);
    const sc = this.sun.shadow.camera;
    sc.left = -9;
    sc.right = 9;
    sc.top = 12;
    sc.bottom = -12;
    sc.near = 1;
    sc.far = 50;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;

    this.applyQuality(quality);
    window.addEventListener('resize', this.resize);
    window.visualViewport?.addEventListener('resize', this.resize);
    this.resize();
  }

  applyQuality(q: GraphicsQuality): void {
    this.quality = q;
    const maxRatio = q === 'high' ? 2 : q === 'medium' ? 1.5 : 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxRatio));
    this.renderer.shadowMap.enabled = q !== 'low';
    this.renderer.shadowMap.type = q === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.sun.castShadow = q !== 'low';
    const size = q === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.setBloom(q === 'high');
    this.resize();
  }

  private setBloom(on: boolean): void {
    if (!on) {
      this.composer?.dispose();
      this.composer = null;
      return;
    }
    if (this.composer) return;
    // Multisampled HDR target so the composited frame keeps its antialiasing.
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    const c = new EffectComposer(this.renderer, rt);
    c.addPass(new RenderPass(this.scene, this.camera));
    c.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold));
    c.addPass(new OutputPass()); // tone mapping + sRGB, which the renderer skips for render targets
    this.composer = c;
  }

  onResize(fn: (w: number, h: number) => void): void {
    this.resizeListeners.push(fn);
    fn(this.width, this.height);
  }

  get width(): number {
    return this.container.clientWidth || window.innerWidth;
  }

  get height(): number {
    return this.container.clientHeight || window.innerHeight;
  }

  private resize = (): void => {
    const w = this.width;
    const h = this.height;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    for (const fn of this.resizeListeners) fn(w, h);
  };

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
