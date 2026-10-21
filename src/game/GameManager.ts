import * as THREE from 'three';
import { AudioManager } from '../audio/AudioManager';
import { buildCourt } from '../court/Court';
import type { Crowd } from '../court/Crowd';
import { buildEnvironment, OUTDOOR_THEME, type Ambient } from '../court/Environment';
import { NetView } from '../court/Net';
import { clampServeAim } from '../gameplay/ShotSystem';
import type { ControlStyle } from '../gameplay/Swipe';
import {
  applyRallyResult,
  distanceToNearestLine,
  hasGamePoint,
  MATCH_TARGETS,
  matchWinner,
  newScore,
  SCORING_MODES,
  scoreFor,
  sideOfZ,
  type MatchTarget,
  type RallyOutcome,
  type ScoreState,
  type ScoringMode,
} from '../gameplay/RuleManager';
import { copyBallState, createBallState } from '../physics/BallPhysics';
import { predictLanding } from '../physics/Trajectory';
import { AIController, AI_PROFILES, type Difficulty } from '../players/AIController';
import { Athlete } from '../players/Athlete';
import { LocalInputProvider } from '../players/LocalInputProvider';
import { PlayerController } from '../players/PlayerController';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HERO_LOOK, PrimitiveAthleteView, RIVAL_LOOK, type AthleteLook, type AthleteRig } from '../render/AthleteView';
import { BallView } from '../render/BallView';
import { CameraRig } from '../render/CameraRig';
import { Effects } from '../render/Effects';
import { Indicators, type AimMarker, type LandingMarker } from '../render/Indicators';
import { LineCalls } from '../render/LineCalls';
import { PaddleSwoosh } from '../render/PaddleSwoosh';
import { RIVAL_PADDLE, STARTER_PADDLE, type PaddleLook } from '../render/PaddleModel';
import { detectQuality, SceneManager } from '../render/SceneManager';
import { SkinnedAthleteView } from '../render/SkinnedAthleteView';
import { HUD } from '../ui/HUD';
import { SwipeTrail } from '../ui/SwipeTrail';
import { TouchControls } from '../ui/TouchControls';
import { FAR, NEAR, PLAYER, POWER, SIM } from '../utils/Constants';
import { aimToWorld, Rng } from '../utils/MathUtils';
import { GameStateId, GameStateMachine } from './GameState';
import { HitStop } from './HitStop';
import { RallyManager } from './RallyManager';
import { platform } from '../platforms';
import { AdManager, DEFAULT_INTERSTITIAL_POLICY } from './AdManager';

const POINT_PAUSE = 1.9;
/** In-bounds first bounces this close (m) to a sideline or baseline get a "CLOSE!" call. */
const CLOSE_CALL_DIST = 0.1;
/** Rally-milestone callouts, one every 5 shots (the last repeats). */
const MILESTONE_EVERY = 5;
const MILESTONE_CALLS = ['HOT RALLY!', 'ON FIRE!', 'UNSTOPPABLE!', 'LEGENDARY!'];
/** Point-ending slow motion: real duration (s) and time scale; and the rally length that earns it. */
const SLOWMO = { seconds: 0.6, scale: 0.35, minShots: 10 };
/** Footwork dust: velocity change (m/s) against a lagged velocity that counts as a hard push-off. */
const FOOT_KICK = 2.6;
const FOOT_COOLDOWN = 0.35;
/** Title-screen demo: pause (s) between demo points, and how loud its sounds are under the menu music. */
const DEMO_POINT_PAUSE = 1.6;
const DEMO_SFX_GAIN = 0.45;
const SECOND_CHANCE_LABEL = '▶ WATCH AD: REPLAY MATCH POINT';
const DIFFICULTIES = Object.keys(AI_PROFILES) as Difficulty[];
/** Menu art cut from the sheets in public/assets/images by scripts/extract-menu-assets.py. */
const UI_ART = `${import.meta.env.BASE_URL}assets/ui/`;
/** Debug overlay and freeze-frame keys are dev-build only. */
const DEV = import.meta.env.DEV;

/** Dev only: `?adcooldown=0` lets every match-over break show an interstitial. */
const AD_POLICY =
  DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('adcooldown') === '0'
    ? { minMatches: 1, minIntervalMs: 0 }
    : DEFAULT_INTERSTITIAL_POLICY;

/** Moves larger than this (m) in one tick are teleports (serve reset): snap instead of blending. */
const SNAP_DIST = 1;

/** Sim state at the start of the latest tick, for render interpolation. */
interface PrevPose {
  pos: THREE.Vector3;
  facing: number;
}

/** Per-athlete state for footwork dust detection. */
interface Footwork {
  /** Lagged (smoothed) velocity; the gap to the real velocity measures how hard they're changing. */
  lag: THREE.Vector3;
  cooldown: number;
}

/**
 * Composition root and main loop. Wires simulation (RallyManager), presentation (views, camera,
 * HUD, audio) and flow (GameStateMachine) together without any of them knowing about each other.
 */
export class GameManager {
  readonly fsm = new GameStateMachine();
  readonly audio = new AudioManager();
  private sceneMgr: SceneManager;
  private cameraRig: CameraRig;
  private hero: Athlete;
  private rival: Athlete;
  private heroCtl: PlayerController;
  private rivalCtl: PlayerController;
  private ai: AIController;
  /** Title-screen demo: these AIs play both sides behind the menu. */
  private demoHero = new AIController(AI_PROFILES.hard, (Date.now() & 0xffff) + 2);
  private demoRival = new AIController(AI_PROFILES.hard, (Date.now() & 0xffff) + 3);
  private demoTimer = 0;
  private local: LocalInputProvider;
  private touch: TouchControls;
  private rally: RallyManager;
  private ballView: BallView;
  private heroView: AthleteRig;
  private rivalView: AthleteRig;
  private indicators: Indicators;
  private effects: Effects;
  private netView: NetView;
  private lineCalls: LineCalls;
  private heroSwoosh: PaddleSwoosh;
  private rivalSwoosh: PaddleSwoosh;
  private hitStop = new HitStop();
  private crowd: Crowd | null;
  private ambient: Ambient | null;
  private hud: HUD;
  private swipeTrail: SwipeTrail;
  private uiRoot: HTMLElement;
  private overlays: { title: HTMLElement; pause: HTMLElement; matchOver: HTMLElement };
  private ads: AdManager;
  /** The player's mute setting before an ad muted everything; restored afterwards. */
  private mutedBeforeAd = false;
  /** Score before the latest rally, for the rewarded "replay match point". */
  private scoreBeforeRally: ScoreState = newScore(NEAR);
  /** Stats as they were before the match-over tally, restored if the match is rescued. */
  private statsBeforeEnd = { matchesPlayed: 0, matchesWon: 0, bestRally: 0, winStreak: 0, bestStreak: 0 };
  /** The rewarded second chance is offered once per match. */
  private secondChanceUsed = false;
  /** Open title-screen dialog ("settings" / "howto"), if any. */
  private menuModal: HTMLElement | null = null;

  private accumulator = 0;
  /**
   * Render interpolation: views draw these mirrors, blended between the previous and current
   * 120 Hz sim tick by `alpha` (the accumulator fraction), so motion is smooth at any frame rate.
   */
  private alpha = 1;
  private heroR = new Athlete('hero', NEAR, 'You');
  private rivalR = new Athlete('rival', FAR, 'CPU');
  private prevPose = new Map<Athlete, PrevPose>();
  private prevBall = new THREE.Vector3();
  private ballR = createBallState();
  private lastFrame = 0;
  private pointTimer = 0;
  private landing: { x: number; z: number } | null = null;
  /** Rally (sim) time the landing was predicted at, and the predicted flight time to it. */
  private landingAt = 0;
  private landingFlight = 1;
  /** Where the ball last touched the court (for the OUT mark). */
  private lastBounce = new THREE.Vector3();
  /** Match score, server and service court (see RuleManager scoring). */
  private score: ScoreState = newScore(NEAR);
  /** Side-out (traditional) by default; rally scoring is a menu option. */
  private scoring: ScoringMode = 'sideout';
  /** Bumped on each serve so a late "+1" flyer can't overwrite a newer score. */
  private pointSeq = 0;
  /** Longest rally this match, and the stored best when the match began ("NEW BEST RALLY!"). */
  private matchBestRally = 0;
  private bestAtMatchStart = 0;
  private footwork = new Map<Athlete, Footwork>();
  private target: MatchTarget = 11;
  private difficulty: Difficulty = 'medium';
  private stats = { matchesPlayed: 0, matchesWon: 0, bestRally: 0, winStreak: 0, bestStreak: 0 };
  /** Platform-saved free-form data, kept so saving one key doesn't drop the others. */
  private customData: Record<string, unknown> = {};
  /** "Reduce effects": no camera kicks, hit-stop, flashes or HUD pops. */
  private reducedFx = false;
  private controlStyle: ControlStyle = 'charge';
  private debug = false;
  /** Debug freeze: halts simulation and animation without opening the pause menu. */
  private frozen = false;
  private stepTicks = 0;
  private fps = 60;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ndc = new THREE.Vector2();
  private hitPoint = new THREE.Vector3();
  private tipPos = new THREE.Vector3();
  private scratch = new THREE.Vector3();

  private get tally(): { hero: number; rival: number } {
    return { hero: scoreFor(this.score, this.hero.side), rival: scoreFor(this.score, this.rival.side) };
  }

  private get nextServer(): Athlete {
    return this.score.server === this.hero.side ? this.hero : this.rival;
  }

  private get nextFromRight(): boolean {
    return this.score.fromRight;
  }

  /** Who wins the game with the next rally, if anyone (side-out: only the server can). */
  private gamePointHolder(): 'hero' | 'rival' | null {
    if (hasGamePoint(this.score, this.hero.side, this.target, this.scoring)) return 'hero';
    if (hasGamePoint(this.score, this.rival.side, this.target, this.scoring)) return 'rival';
    return null;
  }

  /** `athleteModel` is the rigged player GLB; null falls back to the primitive players. */
  constructor(gameRoot: HTMLElement, uiRoot: HTMLElement, onProgress: (p: number) => void, athleteModel: GLTF | null = null) {
    this.uiRoot = uiRoot;
    this.sceneMgr = new SceneManager(gameRoot, detectQuality());
    const { scene, camera } = this.sceneMgr;
    onProgress(0.2);

    ({ crowd: this.crowd, ambient: this.ambient } = buildEnvironment(scene, OUTDOOR_THEME, this.sceneMgr.quality));
    this.netView = new NetView();
    scene.add(buildCourt(), this.netView.root);
    onProgress(0.5);

    this.hero = new Athlete('hero', NEAR, 'You');
    this.rival = new Athlete('rival', FAR, 'CPU');
    for (const a of [this.hero, this.rival]) {
      this.footwork.set(a, { lag: new THREE.Vector3(), cooldown: 0 });
      this.prevPose.set(a, { pos: new THREE.Vector3(), facing: 0 });
    }
    this.touch = new TouchControls(uiRoot);
    this.local = new LocalInputProvider(this.sceneMgr.renderer.domElement, this.pickGround, this.touch);
    this.ai = new AIController(AI_PROFILES.medium, (Date.now() & 0xffff) + 1);
    this.heroCtl = new PlayerController(this.hero, this.local);
    this.rivalCtl = new PlayerController(this.rival, this.ai);
    this.rally = new RallyManager([this.heroCtl, this.rivalCtl], new Rng(Date.now() & 0xffffff));

    this.ballView = new BallView(scene);
    const athleteView = (look: AthleteLook, paddle: PaddleLook, marker?: string): AthleteRig =>
      athleteModel
        ? new SkinnedAthleteView(scene, athleteModel, look, paddle, marker)
        : new PrimitiveAthleteView(scene, look, paddle, marker);
    this.heroView = athleteView(HERO_LOOK, STARTER_PADDLE, '#ffd23f');
    this.rivalView = athleteView(RIVAL_LOOK, RIVAL_PADDLE);
    this.indicators = new Indicators(scene);
    this.effects = new Effects(scene, this.sceneMgr.quality);
    this.lineCalls = new LineCalls(scene);
    this.heroSwoosh = new PaddleSwoosh(scene, 0xffe14d);
    this.rivalSwoosh = new PaddleSwoosh(scene, 0x41e2ba);
    this.cameraRig = new CameraRig(camera);
    this.sceneMgr.onResize((w, h) => this.cameraRig.setAspect(w / h));
    onProgress(0.8);

    this.hud = new HUD(uiRoot, 'You', 'CPU');
    this.swipeTrail = new SwipeTrail(this.hud.root);
    this.local.swipeFx = this.swipeTrail;
    this.touch.swipeFx = this.swipeTrail;
    this.ads = new AdManager(
      platform,
      {
        onAdStart: () => this.onAdStart(),
        onAdEnd: () => this.onAdEnd(),
        onBannerSize: (h) => document.documentElement.style.setProperty('--ad-banner-h', `${h}px`),
      },
      AD_POLICY,
    );
    this.overlays = this.buildOverlays();
    this.setTarget(this.target, false);
    this.setScoring(this.scoring, false);
    this.setDifficulty(this.difficulty, false);
    this.setReducedEffects(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, false);
    this.syncVolumeSliders();
    this.updateMuteBtns();
    this.updateControlBtns();
    this.renderStats();
    this.bindRallyEvents();
    this.bindGlobalInput();
    this.bindPlatformEvents();
    this.fsm.onChange((to) => this.onStateChange(to));

    // A demo rally plays on the court behind the title screen.
    this.setDemoInputs(true);
    this.serveDemo();
    this.cameraRig.snap(this.cameraFocus());
    onProgress(1);
  }

  async init(): Promise<void> {
    try {
      const saved = await platform.loadProgress();
      if (saved) {
        if (saved.target && (MATCH_TARGETS as readonly number[]).includes(saved.target as MatchTarget)) {
          this.setTarget(saved.target as MatchTarget, false);
        }
        if (saved.matchesPlayed !== undefined) this.stats.matchesPlayed = saved.matchesPlayed;
        if (saved.matchesWon !== undefined) this.stats.matchesWon = saved.matchesWon;
        if (saved.bestRally !== undefined) this.stats.bestRally = saved.bestRally;
        if (saved.winStreak !== undefined) this.stats.winStreak = saved.winStreak;
        if (saved.bestStreak !== undefined) this.stats.bestStreak = saved.bestStreak;
        if (saved.difficulty && saved.difficulty in AI_PROFILES) this.setDifficulty(saved.difficulty as Difficulty, false);
        if (saved.customData) this.customData = { ...saved.customData };
        const { scoring } = this.customData;
        if (scoring === 'sideout' || scoring === 'rally') this.setScoring(scoring, false);
        if (typeof this.customData.reducedEffects === 'boolean') this.setReducedEffects(this.customData.reducedEffects, false);
        const { controlStyle } = this.customData;
        if (controlStyle === 'charge' || controlStyle === 'swipe') this.setControlStyle(controlStyle, false);
        const { musicVolume, sfxVolume } = this.customData;
        if (typeof musicVolume === 'number') this.audio.setBgmVolume(musicVolume);
        if (typeof sfxVolume === 'number') this.audio.setSfxVolume(sfxVolume);
        this.syncVolumeSliders();
        this.renderStats();
      }
    } catch (err) {
      console.warn('[GameManager] Failed to load progress from platform:', err);
    }
  }

  /** Merges `patch` into the platform-saved free-form data. */
  private saveCustom(patch: Record<string, unknown>): void {
    this.customData = { ...this.customData, ...patch };
    void platform.saveProgress({ customData: this.customData });
  }

  /** Toggles motion-heavy effects (camera kicks and shake, hit-stop, flashes, HUD pops). */
  setReducedEffects(v: boolean, persist = true): void {
    this.reducedFx = v;
    this.cameraRig.shakeEnabled = !v;
    this.hitStop.enabled = !v;
    if (v) this.hitStop.clear();
    this.effects.flashEnabled = !v;
    this.netView.flashEnabled = !v;
    this.swipeTrail.reduced = v;
    this.uiRoot.classList.toggle('reduce-fx', v);
    this.updateFxBtns();
    if (persist) this.saveCustom({ reducedEffects: v });
  }

  /** Hold-to-charge power, or power from swipe speed (mouse drag / touch swipe). */
  setControlStyle(style: ControlStyle, persist = true): void {
    this.controlStyle = style;
    this.local.style = style;
    this.local.reset();
    this.touch.setStyle(style);
    this.updateControlBtns();
    if (persist) this.saveCustom({ controlStyle: style });
  }

  /** Sets the CPU opponent's skill (picked on the title screen). */
  setDifficulty(d: Difficulty, persist = true): void {
    this.difficulty = d;
    this.ai.profile = AI_PROFILES[d];
    if (persist) void platform.saveProgress({ difficulty: d });
    for (const b of this.overlays.title.querySelectorAll<HTMLElement>('[data-difficulty]')) {
      b.classList.toggle('selected', b.dataset.difficulty === d);
    }
  }

  start(): void {
    this.fsm.go(GameStateId.MAIN_MENU);
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- loop

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    // A fullscreen ad owns the screen: no simulation or rendering underneath it.
    if (this.ads.isAdActive) {
      this.lastFrame = now;
      return;
    }
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;

    const st = this.fsm.state;
    const simulating = st === GameStateId.SERVING || st === GameStateId.RALLY || st === GameStateId.POINT_END || st === GameStateId.MAIN_MENU;
    // World time: slowed by hit-stop while simulating; camera and HUD keep real time.
    let worldDt = dt;
    if (simulating && this.frozen) {
      // Frozen: only advance when a single-step was requested.
      this.accumulator = 0;
      while (this.stepTicks > 0) {
        this.capturePrev();
        this.tick(SIM.TICK_DT);
        this.stepTicks--;
      }
      this.alpha = 1;
    } else if (simulating) {
      const wasStopped = this.hitStop.active;
      worldDt = this.hitStop.scale(dt);
      this.accumulator += worldDt;
      let ticks = 0;
      let showLatest = false;
      while (this.accumulator >= SIM.TICK_DT && ticks < SIM.MAX_TICKS_PER_FRAME) {
        this.capturePrev();
        this.tick(SIM.TICK_DT);
        this.accumulator -= SIM.TICK_DT;
        ticks++;
        // A hit-stop that starts mid-frame drops the rest of this frame so the freeze is crisp.
        if (!wasStopped && this.hitStop.active) {
          this.accumulator = 0;
          showLatest = true; // freeze on the contact itself, not the tick before it
          break;
        }
      }
      if (ticks === SIM.MAX_TICKS_PER_FRAME) {
        this.accumulator = 0; // drop time rather than spiral
        showLatest = true;
      }
      this.alpha = showLatest ? 1 : Math.min(1, this.accumulator / SIM.TICK_DT);
    } else {
      this.alpha = 1;
    }
    this.interpolate();
    this.render(this.frozen ? 0 : worldDt, this.frozen ? 0 : dt);
  };

  private tick(dt: number): void {
    this.rally.tick(dt);
    // Title-screen demo: the next demo point starts a moment after the last one ended.
    if (this.fsm.state === GameStateId.MAIN_MENU) {
      if (this.rally.phase === 'dead' && (this.demoTimer -= dt) <= 0) this.serveDemo();
      return;
    }
    if (this.fsm.state === GameStateId.POINT_END) {
      this.pointTimer -= dt;
      if (this.pointTimer <= 0) this.afterPoint();
    }
  }

  /** Records the sim state before a tick so the frame can blend toward the state after it. */
  private capturePrev(): void {
    for (const a of [this.hero, this.rival]) {
      const p = this.prevPose.get(a)!;
      p.pos.copy(a.pos);
      p.facing = a.facing;
    }
    this.prevBall.copy(this.rally.ball.state.pos);
  }

  /** Fills the render mirrors with the sim state blended by `alpha` between the last two ticks. */
  private interpolate(): void {
    const k = this.alpha;
    for (const [a, m] of [
      [this.hero, this.heroR],
      [this.rival, this.rivalR],
    ] as const) {
      const p = this.prevPose.get(a)!;
      const t = p.pos.distanceTo(a.pos) > SNAP_DIST ? 1 : k;
      m.side = a.side;
      m.pos.lerpVectors(p.pos, a.pos, t);
      m.vel.copy(a.vel);
      let d = a.facing - p.facing;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      m.facing = p.facing + d * t;
      Object.assign(m.swing, a.swing);
      m.holdingBall = a.holdingBall;
    }
    const b = this.rally.ball.state;
    copyBallState(b, this.ballR);
    if (this.prevBall.distanceTo(b.pos) <= SNAP_DIST) this.ballR.pos.lerpVectors(this.prevBall, b.pos, k);
  }

  /** `worldDt` drives everything in the scene (slowed by hit-stop); `dt` is real frame time. */
  private render(worldDt: number, dt: number): void {
    const r = this.rally;
    const { camera, renderer } = this.sceneMgr;
    this.heroView.update(this.heroR, worldDt);
    this.rivalView.update(this.rivalR, worldDt);
    this.ballView.update(this.ballR, worldDt, camera);
    this.heroSwoosh.update(this.heroR, this.heroView, camera);
    this.rivalSwoosh.update(this.rivalR, this.rivalView, camera);
    this.netView.update(worldDt);
    this.lineCalls.update(worldDt);
    this.crowd?.update(worldDt);
    this.ambient?.update(worldDt);
    this.updateFootwork(this.hero, this.heroR, worldDt);
    this.updateFootwork(this.rival, this.rivalR, worldDt);
    this.heroView.setMarkerPulse(r.phase === 'live' && r.lastHitter !== this.hero && this.fsm.state !== GameStateId.MAIN_MENU);
    this.cameraRig.update(this.cameraFocus(true), dt);
    this.effects.update(worldDt, camera, renderer.domElement.height);
    this.updateIndicators(dt);
    this.updateChargeMeter();
    this.updateHint();
    this.hud.update(dt);
    if (this.debug || this.frozen) this.hud.setDebug(this.debugText());
    this.sceneMgr.render();
  }

  /** `interpolated` uses the render mirrors (per frame); snaps use the raw sim state. */
  private cameraFocus(interpolated = false) {
    const r = this.rally;
    const player = interpolated ? this.heroR.pos : this.hero.pos;
    const ball = interpolated ? this.ballR.pos : r.ball.state.pos;
    return { player, ball, ballLive: r.phase === 'live', side: this.hero.side };
  }

  // ---------------------------------------------------------------- flow

  private beginServe(): void {
    this.hud.hideBanner();
    this.ballView.resetTrail();
    this.lineCalls.clear();
    this.clearPointMoments();
    this.pointSeq++;
    this.rally.startServe(this.nextServer, this.nextFromRight);
    this.fsm.go(GameStateId.SERVING);
    this.hud.setScores(this.tally.hero, this.tally.rival, this.nextServer === this.hero);
    this.hud.setRally(0);
    platform.onGameplayStart();
  }

  /** Resets everything the point-end presentation set up (poses, camera push-in, rally heat). */
  private clearPointMoments(): void {
    this.landing = null;
    this.heroView.react(null);
    this.rivalView.react(null);
    this.cameraRig.setPointFocus(null);
    this.hud.setRallyHeat(0);
    this.crowd?.setTension(0);
  }

  private afterPoint(): void {
    const w = matchWinner(this.tally.hero, this.tally.rival, this.target);
    if (w) this.endMatch(w === 'a');
    else this.beginServe();
  }

  private endMatch(heroWon: boolean): void {
    const el = this.overlays.matchOver;
    el.querySelector('.result')!.textContent = heroWon ? 'YOU WIN!' : 'CPU WINS';
    el.querySelector('.result')!.classList.toggle('win', heroWon);
    this.countUpFinal(el.querySelector('.final')!, this.tally.hero, this.tally.rival);
    const mode = this.scoring === 'sideout' ? 'side-out' : 'rally scoring';
    el.querySelector('.sub')!.textContent = `Game to ${this.target} · win by 2 · ${mode} · ${this.difficulty.toUpperCase()} CPU`;
    const best = el.querySelector<HTMLElement>('.best-rally')!;
    const newBest = this.matchBestRally > this.bestAtMatchStart && this.matchBestRally >= 4;
    best.classList.toggle('hidden', !newBest);
    best.textContent = `NEW BEST RALLY! ${this.matchBestRally} SHOTS`;

    // Celebrate behind the overlay: orbit the winner; confetti when it's the player.
    const winner = heroWon ? this.hero : this.rival;
    this.cameraRig.setPointFocus(null);
    this.cameraRig.orbit(winner.pos, winner.side);
    if (heroWon) this.effects.confetti(winner.pos);
    this.hud.setHint('');
    this.hud.hideBanner();
    this.audio.play(heroWon ? 'pointWon' : 'pointLost');
    const chance = el.querySelector<HTMLButtonElement>('[data-a="chance"]')!;
    chance.classList.toggle('hidden', heroWon || this.secondChanceUsed || !this.ads.rewardedAvailable);
    chance.disabled = false;
    chance.textContent = SECOND_CHANCE_LABEL;
    this.fsm.go(GameStateId.MATCH_OVER);

    platform.onGameplayStop();
    void platform.submitScore(this.tally.hero);
    this.statsBeforeEnd = { ...this.stats };
    this.stats.matchesPlayed = (this.stats.matchesPlayed ?? 0) + 1;
    if (heroWon) this.stats.matchesWon = (this.stats.matchesWon ?? 0) + 1;
    this.stats.winStreak = heroWon ? this.stats.winStreak + 1 : 0;
    this.stats.bestStreak = Math.max(this.stats.bestStreak, this.stats.winStreak);
    void platform.saveProgress(this.stats);
    this.renderStats();
  }

  private newMatch(): void {
    this.score = newScore(this.hero.side);
    this.matchBestRally = 0;
    this.secondChanceUsed = false;
    this.bestAtMatchStart = this.stats.bestRally;
    this.hud.setTarget(this.target);
    this.hud.setGamePoint(null);
    this.effects.clearConfetti();
    this.hitStop.clear();
    this.beginServe();
    this.cameraRig.snap(this.cameraFocus()); // also ends the match-over orbit
  }

  private goToMenu(): void {
    platform.onGameplayStop();
    this.hud.hideBanner();
    this.hud.setGamePoint(null);
    this.fsm.go(GameStateId.MAIN_MENU);
    this.effects.clearConfetti();
    this.hitStop.clear();
    this.setDemoInputs(true);
    this.serveDemo();
    this.renderStats();
    this.cameraRig.snap(this.cameraFocus());
  }

  /** Title-screen demo: the demo AIs take over both players (`false` hands them back). */
  private setDemoInputs(on: boolean): void {
    this.heroCtl.input = on ? this.demoHero : this.local;
    this.rivalCtl.input = on ? this.demoRival : this.ai;
  }

  /** Starts the next demo point behind the title screen (random server and court). */
  private serveDemo(): void {
    this.ballView.resetTrail();
    this.lineCalls.clear();
    this.clearPointMoments();
    this.rally.startServe(Math.random() < 0.5 ? this.hero : this.rival, Math.random() < 0.5);
  }

  /** Career numbers on the title screen; hidden until there is something to show. */
  private renderStats(): void {
    const el = this.overlays.title.querySelector<HTMLElement>('.menu-stats')!;
    const { matchesPlayed: played, matchesWon: won, bestRally, winStreak, bestStreak } = this.stats;
    el.classList.toggle('hidden', played === 0 && bestRally === 0);
    const tile = (icon: string, label: string, value: string | number, note = '') =>
      `<div class="stat"><img class="stat-icon" src="${UI_ART}icon-${icon}.png" alt="" /><div class="stat-value">${value}</div><div class="stat-label">${label}${note ? ` <small>${note}</small>` : ''}</div></div>`;
    el.innerHTML = [
      tile('wins', 'RECORD', `${won}–${played - won}`),
      tile('winrate', 'WIN RATE', played ? `${Math.round((won / played) * 100)}%` : '–'),
      tile('rally', 'BEST RALLY', bestRally),
      tile('streak', 'STREAK', winStreak, bestStreak > winStreak ? `best ${bestStreak}` : ''),
    ].join('');
  }

  private setTarget(t: MatchTarget, persist = true): void {
    this.target = t;
    if (persist) {
      void platform.saveProgress({ target: t });
    }
    for (const b of this.overlays.title.querySelectorAll<HTMLElement>('[data-target]')) {
      b.classList.toggle('selected', Number(b.dataset.target) === t);
    }
  }

  /** Side-out or rally scoring (title screen); takes effect from the next match. */
  private setScoring(m: ScoringMode, persist = true): void {
    this.scoring = m;
    if (persist) this.saveCustom({ scoring: m });
    for (const b of this.overlays.title.querySelectorAll<HTMLElement>('[data-scoring]')) {
      b.classList.toggle('selected', b.dataset.scoring === m);
    }
  }

  private onStateChange(to: GameStateId): void {
    const inMatch = to !== GameStateId.MAIN_MENU && to !== GameStateId.LOADING;
    this.hud.setVisible(inMatch);
    this.touch.setVisible(inMatch && to !== GameStateId.PAUSED && to !== GameStateId.MATCH_OVER);
    this.local.enabled = to === GameStateId.SERVING || to === GameStateId.RALLY || to === GameStateId.POINT_END;
    this.overlays.title.classList.toggle('hidden', to !== GameStateId.MAIN_MENU);
    this.overlays.pause.classList.toggle('hidden', to !== GameStateId.PAUSED);
    this.overlays.matchOver.classList.toggle('hidden', to !== GameStateId.MATCH_OVER);
    if (to !== GameStateId.MAIN_MENU) this.closeMenuModal();
    // Banner on the menus only: it would cover the court and touch controls during play.
    this.ads.setBanner(to === GameStateId.MAIN_MENU || to === GameStateId.PAUSED || to === GameStateId.MATCH_OVER);
    if (to === GameStateId.PAUSED) {
      this.accumulator = 0;
      this.updateMuteBtns();
    }

    switch (to) {
      case GameStateId.MAIN_MENU:
        this.audio.setDucked(false);
        this.audio.playBgm('menu');
        break;
      case GameStateId.SERVING:
      case GameStateId.RALLY:
      case GameStateId.POINT_END:
        this.audio.setDucked(false);
        this.audio.playBgm('match');
        break;
      case GameStateId.PAUSED:
        this.audio.setDucked(true);
        break;
      case GameStateId.MATCH_OVER:
        this.audio.setDucked(false);
        this.audio.playBgm('menu');
        break;
    }
  }

  private onRallyEnd(outcome: RallyOutcome, shots: number): void {
    const heroWon = outcome.winner === this.hero.side;
    const prev = { ...this.tally };
    const wasGamePoint = this.gamePointHolder() !== null;
    const prevServer = this.score.server;
    this.scoreBeforeRally = this.score;
    if (outcome.winner !== null) this.score = applyRallyResult(this.score, outcome.winner, this.scoring);
    const scored = prev.hero !== this.tally.hero || prev.rival !== this.tally.rival;
    const sideOut = outcome.winner !== null && !scored && this.score.server !== prevServer;
    // "+1" flies from where the point ended into the winner's score, which updates on arrival.
    const fly = scored && !this.reducedFx && this.toScreen(this.rally.ball.state.pos, this.scratch);
    this.hud.setScores(fly ? prev.hero : this.tally.hero, fly ? prev.rival : this.tally.rival, null);
    if (fly) {
      const seq = this.pointSeq;
      this.hud.flyPoint(heroWon ? 'hero' : 'rival', this.scratch.x, this.scratch.y, () => {
        if (seq === this.pointSeq) this.hud.setScores(this.tally.hero, this.tally.rival, null);
      });
    }
    const [big, detail] = this.describeOutcome(outcome, heroWon, shots);
    const { hero, rival } = this.tally;
    const w = matchWinner(hero, rival, this.target);
    const small = w
      ? w === 'a'
        ? 'GAME — you win the match!'
        : 'GAME — CPU wins the match'
      : sideOut
        ? `${detail} · SIDE OUT — ${heroWon ? 'your serve' : 'CPU to serve'}`
        : detail;
    this.hud.setGamePoint(w ? null : this.gamePointHolder());
    const slam = outcome.reason === 'MISS' && heroWon;
    this.hud.showBanner(big, small, outcome.winner === null ? 'neutral' : heroWon ? 'good' : 'bad', POINT_PAUSE - 0.2, slam);
    const lineCall = outcome.reason === 'OUT_OF_BOUNDS' || outcome.reason === 'SERVE_IN_KITCHEN' || outcome.reason === 'SERVE_WRONG_COURT';
    if (lineCall) this.lineCalls.showOut(this.lastBounce.x, this.lastBounce.z);
    if (outcome.winner !== null) {
      this.audio.play(heroWon ? 'pointWon' : 'pointLost');
      this.crowd?.cheer(heroWon ? 1 : 0.6);
      this.hud.edgeGlow(heroWon ? 'good' : 'bad');
      this.heroView.react(heroWon ? 'win' : 'lose');
      this.rivalView.react(heroWon ? 'lose' : 'win');
      // Push in on the OUT mark, otherwise on the point's winner.
      this.cameraRig.setPointFocus(lineCall ? this.lastBounce : (heroWon ? this.hero : this.rival).pos);
      if (wasGamePoint || shots >= SLOWMO.minShots) this.hitStop.slowMo(SLOWMO.seconds, SLOWMO.scale);
    }
    this.pointTimer = POINT_PAUSE;
    this.fsm.go(GameStateId.POINT_END);
  }

  private describeOutcome(o: RallyOutcome, heroWon: boolean, shots: number): [string, string] {
    const heroFault = o.faultBy === this.hero.side;
    const rallyNote = shots >= 6 ? ` · ${shots}-shot rally` : '';
    switch (o.reason) {
      case 'OUT_OF_BOUNDS':
        return ['OUT!', (heroFault ? 'Your shot landed out' : 'CPU hit it out') + rallyNote];
      case 'NET':
        return ['NET!', (heroFault ? "Your shot didn't clear the net" : 'CPU found the net') + rallyNote];
      case 'MISS':
        return heroWon ? ['WINNER!', 'Unreturnable' + rallyNote] : ['MISSED', 'The ball bounced twice' + rallyNote];
      case 'BALL_STUCK':
        return ['REPLAY', 'Point will be replayed'];
      case 'SERVE_IN_KITCHEN':
        return ['FAULT!', heroFault ? 'Your serve landed in the kitchen' : 'CPU served into the kitchen'];
      case 'SERVE_WRONG_COURT':
        return ['FAULT!', heroFault ? 'Serve must land in the diagonal court' : 'CPU served into the wrong court'];
      case 'TWO_BOUNCE_VIOLATION':
        return ['FAULT!', (heroFault ? 'Let it bounce' : 'CPU volleyed too early') + ' · two-bounce rule'];
      case 'KITCHEN_VOLLEY':
        return ['KITCHEN!', (heroFault ? 'You volleyed in the kitchen' : 'CPU volleyed in the kitchen') + rallyNote];
      case 'FOOT_FAULT':
        return ['FOOT FAULT!', heroFault ? 'Serve from behind the baseline' : 'CPU stepped on the line'];
    }
  }

  // ---------------------------------------------------------------- events

  private bindRallyEvents(): void {
    const bus = this.rally.bus;
    // Behind the title screen the demo keeps sounds (quieter), particles and the crowd, but none
    // of the camera / time / HUD feedback, haptics or stats.
    const demo = () => this.fsm.state === GameStateId.MAIN_MENU;
    const gain = () => (demo() ? DEMO_SFX_GAIN : 1);
    bus.on('hit', (e) => {
      const pan = e.pos.x / 6;
      const intensity = Math.min(1, e.speed / 22);
      const power = e.power;
      (e.athlete === this.hero ? this.heroView : this.rivalView).onHit(intensity, power);
      this.audio.play(e.kind === 'serve' ? 'serve' : power ? 'powerHit' : intensity < 0.35 ? 'softHit' : 'hit', intensity, pan, gain());
      const vel = this.rally.ball.state.vel;
      this.effects.hitBurst(e.pos, vel, intensity);
      this.ballView.onHit(vel, intensity);
      this.ballView.resetTrail();
      if (demo()) {
        this.crowd?.setTension(e.shotIndex / 15);
        return;
      }
      // Kick on every hero contact (felt in the hands), and on any power shot.
      const kick = Math.max(power ? 0.45 : 0, e.athlete === this.hero ? 0.2 + 0.2 * intensity : 0);
      if (kick > 0) this.cameraRig.impulse(kick);
      if (e.kind === 'stroke') this.hitStop.trigger(power ? 0.07 : intensity > 0.45 ? 0.04 : 0);
      if (e.kind === 'stroke' && power) this.cameraRig.punch(1.5);
      if (e.athlete === this.hero && platform.capabilities.haptics) {
        platform.vibrate?.(power ? 35 : 15);
      }
      if (this.fsm.state === GameStateId.SERVING) this.fsm.go(GameStateId.RALLY);
      this.hud.setRally(e.shotIndex);
      this.rallyMilestone(e.shotIndex);
      // Landing assist for balls coming toward the hero.
      if (e.athlete !== this.hero) {
        const p = predictLanding(this.rally.ball.state);
        this.landing = p && !p.hitsNet ? { x: p.point.x, z: p.point.z } : null;
        if (p) {
          this.landingAt = this.rally.time;
          this.landingFlight = Math.max(0.05, p.time);
        }
      } else {
        this.landing = null;
      }
    });
    bus.on('bounce', (e) => {
      this.audio.play('bounce', Math.min(1, e.speed / 8), e.pos.x / 6, gain());
      this.effects.bounceBurst(e.pos, e.speed, e.inBounds);
      this.ballView.onBounce(e.speed);
      this.landing = null;
      this.lastBounce.copy(e.pos);
      // Close call: a good first bounce on the receiver's side that only just caught a line.
      const r = this.rally;
      if (
        e.inBounds &&
        r.phase === 'live' &&
        r.bouncesSinceHit === 1 &&
        r.lastHitter &&
        sideOfZ(e.pos.z) !== r.lastHitter.side &&
        distanceToNearestLine(e.pos.x, e.pos.z) < CLOSE_CALL_DIST
      ) {
        this.lineCalls.showClose(e.pos.x, e.pos.z, this.hero.side);
        this.crowd?.gasp();
      }
    });
    bus.on('net', (e) => {
      this.audio.play('net', 0.6, e.pos.x / 6, gain());
      this.netView.onHit(e.pos.x, e.tape);
      this.effects.netPuff(e.pos, e.tape);
      if (e.tape && !demo()) {
        this.cameraRig.impulse(0.25);
        this.cameraRig.shake(0.35);
        this.crowd?.gasp();
      }
    });
    bus.on('swingEnd', (e) => {
      if (e.contact) return;
      const rig = e.athlete === this.hero ? this.heroView : this.rivalView;
      this.effects.whiffPuff(rig.paddleTip.getWorldPosition(this.tipPos));
    });
    bus.on('rallyEnd', (e) => {
      if (demo()) {
        const { winner } = e.outcome;
        if (winner !== null) {
          this.crowd?.cheer(0.5);
          this.heroView.react(winner === this.hero.side ? 'win' : 'lose');
          this.rivalView.react(winner === this.rival.side ? 'win' : 'lose');
        }
        this.demoTimer = DEMO_POINT_PAUSE;
        return;
      }
      this.stats.bestRally = Math.max(this.stats.bestRally, e.shots);
      this.matchBestRally = Math.max(this.matchBestRally, e.shots);
      this.onRallyEnd(e.outcome, e.shots);
    });
  }

  private bindGlobalInput(): void {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.menuModal) {
        this.closeMenuModal();
        return;
      }
      if (e.code === 'Escape' || e.code === 'KeyP') this.togglePause();
      if (e.code === 'KeyM' && !e.repeat) {
        this.audio.setMuted(!this.audio.muted);
        this.updateMuteBtns();
      }
      if (DEV && (e.code === 'Backquote' || e.code === 'F3')) {
        this.debug = !this.debug;
        if (!this.debug && !this.frozen) this.hud.setDebug(null);
        e.preventDefault();
      }
      if (DEV && e.code === 'KeyF' && !e.repeat) {
        this.frozen = !this.frozen;
        this.stepTicks = 0;
        if (!this.frozen && !this.debug) this.hud.setDebug(null);
      }
      if (DEV && e.code === 'Period' && this.frozen) this.stepTicks++;
      if (this.fsm.state === GameStateId.MAIN_MENU) {
        // A focused control handles its own keys (Space/Enter click a button, arrows move a slider).
        const t = e.target as HTMLElement;
        if (this.menuModal || t.closest?.('button, input')) return;
        if (e.code === 'Space' || e.code === 'Enter') this.startPlaying();
        const idx = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
        if (idx >= 0) this.menuPick(() => this.setTarget(MATCH_TARGETS[idx]));
        const step = e.code === 'ArrowLeft' ? -1 : e.code === 'ArrowRight' ? 1 : 0;
        const d = DIFFICULTIES[DIFFICULTIES.indexOf(this.difficulty) + step];
        if (step && d) this.menuPick(() => this.setDifficulty(d));
      } else if (this.fsm.state === GameStateId.MATCH_OVER && (e.code === 'Space' || e.code === 'Enter')) {
        void this.leaveMatchOver(() => this.newMatch());
      }
    });
    this.hud.pauseButton.addEventListener('click', () => this.togglePause());
  }

  private bindPlatformEvents(): void {
    platform.onPause(() => {
      if (!this.fsm.isPaused) this.fsm.pause();
    });
    platform.onResume(() => {
      // Game remains paused when returning from background so user can resume when ready
    });
    platform.onBackButton?.(() => {
      if (this.fsm.state === GameStateId.SERVING || this.fsm.state === GameStateId.RALLY) {
        this.togglePause();
      } else if (this.fsm.state === GameStateId.PAUSED) {
        this.goToMenu();
      } else if (this.fsm.state === GameStateId.MATCH_OVER) {
        void this.leaveMatchOver(() => this.goToMenu());
      } else if (this.fsm.state === GameStateId.MAIN_MENU) {
        if (this.menuModal) this.closeMenuModal();
        else platform.exitApp?.();
      }
    });
  }

  private togglePause(): void {
    const st = this.fsm.state;
    const inPlay = st === GameStateId.SERVING || st === GameStateId.RALLY || st === GameStateId.POINT_END;
    if (!inPlay && !this.fsm.isPaused) return; // nothing to pause on the menus
    if (this.fsm.isPaused) {
      this.fsm.resume();
      this.lastFrame = performance.now();
      platform.onGameplayStart();
    } else {
      this.fsm.pause();
      platform.onGameplayStop();
    }
    this.audio.play('click');
  }

  /** Mute and effects toggles live in both the pause menu and the title-screen settings. */
  private updateMuteBtns(): void {
    for (const btn of this.uiRoot.querySelectorAll<HTMLElement>('[data-a="mute"]')) {
      btn.textContent = this.audio.muted ? 'UNMUTE AUDIO' : 'MUTE AUDIO';
      btn.classList.toggle('is-off', this.audio.muted);
    }
  }

  private updateFxBtns(): void {
    for (const btn of this.uiRoot.querySelectorAll<HTMLElement>('[data-a="fx"]')) {
      btn.textContent = this.reducedFx ? 'EFFECTS: REDUCED' : 'EFFECTS: FULL';
      btn.classList.toggle('is-off', this.reducedFx);
    }
  }

  private updateControlBtns(): void {
    for (const btn of this.uiRoot.querySelectorAll<HTMLElement>('[data-a="controls"]')) {
      btn.textContent = this.controlStyle === 'swipe' ? 'CONTROLS: SWIPE' : 'CONTROLS: AIM & CHARGE';
      btn.classList.toggle('is-swipe', this.controlStyle === 'swipe');
    }
  }

  private syncVolumeSliders(): void {
    const set = (name: string, v: number) => {
      const input = this.overlays.title.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (input) {
        input.value = String(Math.round(v * 100));
        input.style.setProperty('--fill', `${input.value}%`);
      }
    };
    set('music', this.audio.bgmVolume);
    set('sfx', this.audio.sfxVolume);
  }

  /** A title-screen pick: unlock audio (first gesture), apply, click. */
  private menuPick(apply: () => void): void {
    this.audio.unlock();
    apply();
    this.audio.play('click');
  }

  private openMenuModal(name: string): void {
    this.closeMenuModal();
    const modal = this.overlays.title.querySelector<HTMLElement>(`[data-modal="${name}"]`);
    if (!modal) return;
    if (name === 'howto') {
      modal.querySelector<HTMLImageElement>('.howto-art')!.src = `${UI_ART}howto-${this.touch.active ? 'touch' : 'keyboard'}.jpg`;
      this.renderHowTo(modal.querySelector('.howto-body')!);
    }
    if (name === 'settings') this.updatePrivacyBtn();
    modal.classList.remove('hidden');
    this.menuModal = modal;
    modal.querySelector<HTMLElement>('[data-a="close"]')?.focus({ preventScroll: true });
  }

  private closeMenuModal(): void {
    this.menuModal?.classList.add('hidden');
    this.menuModal = null;
  }

  /** Controls for the device in use (touch or keyboard + mouse), then the basic rules. */
  private renderHowTo(el: HTMLElement): void {
    const row = (keys: string, what: string) => `<div class="howto-row"><div class="howto-keys">${keys}</div><div>${what}</div></div>`;
    const kbd = (k: string) => `<span class="kbd">${k}</span>`;
    const swipe = this.controlStyle === 'swipe';
    const controls = this.touch.active
      ? swipe
        ? [
            row('Left thumb', 'Drag anywhere on the left half to move'),
            row('Right side', 'Swipe to hit: sideways for the corners, up for deep, down for short'),
            row('Speed', 'Swipe faster for more power (overhead = smash) · a tap is a safe shot'),
            row('II', 'Pause (top right)'),
          ]
        : [
          row('Left thumb', 'Drag anywhere on the left half to move'),
          row('Right side', 'Tap to hit · hold, then lift, for a power shot (overhead = smash)'),
          row('Swipe', 'Aim: sideways for the corners, up for deep, down for short'),
            row('II', 'Pause (top right)'),
          ]
      : [
          row(`${kbd('W A S D')} ${kbd('↑ ← ↓ →')}`, 'Move'),
          row(kbd('SHIFT'), 'Sprint'),
          ...(swipe
            ? [
                row('Mouse', 'Hold the left button, flick and let go to hit: sideways for the corners, up for deep, down for short'),
                row('Speed', 'Flick faster for more power (overhead = smash) · a click is a safe shot'),
                row(kbd('SPACE'), 'Tap to hit · hold and release for a power shot'),
              ]
            : [
                row(`${kbd('SPACE')} ${kbd('CLICK')}`, 'Tap to hit · hold and release for a power shot (overhead = smash)'),
                row('Aim', `Hold a direction as you swing: ${kbd('A')}/${kbd('D')} corners, ${kbd('W')} deep, ${kbd('S')} short. Nothing held = safe deep shot`),
                row('Mouse', 'Or click a spot on the far court to aim there'),
              ]),
          row(`${kbd('ESC')} ${kbd('P')}`, 'Pause'),
          row(kbd('M'), 'Mute'),
        ];
    el.innerHTML = `
      <div class="howto-head">CONTROLS</div>${controls.join('')}
      <div class="howto-head">RULES</div>
      <ul class="howto-rules">
        <li>Serve underhand from behind the baseline, diagonally into the opposite service court. It must clear the kitchen: landing in it or on its line is a fault. A serve that clips the net and lands in is good.</li>
        <li>Two-bounce rule: the return of serve and the third shot must both bounce before they are hit.</li>
        <li>No volleys in the kitchen: you can't hit the ball out of the air while touching the kitchen or its line, or step in from the momentum of a volley. Balls that bounce in the kitchen can be played from it.</li>
        <li>You lose the rally if your shot lands out, hits the net, or you let the ball bounce twice. Balls on the line are in.</li>
        <li>${
          this.scoring === 'sideout'
            ? 'Side-out scoring: only the server scores. Lose the rally on your serve and the serve passes over.'
            : 'Rally scoring: every rally scores, and the winner serves next.'
        } Serve from the right on an even score, the left on an odd one.</li>
        <li>First to the target score wins, but you must win by 2.</li>
      </ul>`;
  }

  private startPlaying(): void {
    if (this.fsm.state !== GameStateId.MAIN_MENU) return;
    this.audio.unlock();
    this.audio.play('click');
    this.setDemoInputs(false);
    this.newMatch();
  }

  // ---------------------------------------------------------------- ads

  private onAdStart(): void {
    this.mutedBeforeAd = this.audio.muted;
    this.audio.setMuted(true);
    // Placements are breaks only, but a portal can start an ad on its own: never leave play running.
    const st = this.fsm.state;
    if (st === GameStateId.SERVING || st === GameStateId.RALLY || st === GameStateId.POINT_END) this.fsm.pause();
  }

  private onAdEnd(): void {
    this.audio.setMuted(this.mutedBeforeAd);
    this.updateMuteBtns();
    this.accumulator = 0;
    this.lastFrame = performance.now();
  }

  /** Leaving the match-over screen is the one interstitial break; `next` runs once the ad is done. */
  private async leaveMatchOver(next: () => void): Promise<void> {
    if (this.fsm.state !== GameStateId.MATCH_OVER || this.ads.busy) return;
    this.ads.matchFinished();
    await this.ads.interstitialAtBreak();
    if (this.fsm.state === GameStateId.MATCH_OVER) next();
  }

  /** Rewarded: undo the CPU's match-winning rally and replay match point. */
  private async secondChance(btn: HTMLButtonElement): Promise<void> {
    if (this.fsm.state !== GameStateId.MATCH_OVER || this.ads.busy || this.secondChanceUsed) return;
    btn.disabled = true;
    const earned = await this.ads.rewarded();
    if (this.fsm.state !== GameStateId.MATCH_OVER) return;
    if (!earned) {
      btn.textContent = 'NO AD AVAILABLE — TRY LATER';
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = SECOND_CHANCE_LABEL;
      }, 2500);
      return;
    }
    this.secondChanceUsed = true;
    this.stats = { ...this.statsBeforeEnd };
    void platform.saveProgress(this.stats);
    this.renderStats();
    this.score = this.scoreBeforeRally;
    this.effects.clearConfetti();
    this.hud.setGamePoint(this.gamePointHolder());
    this.beginServe();
    this.cameraRig.snap(this.cameraFocus()); // also ends the match-over orbit
    this.hud.callout('SECOND CHANCE!', 2);
  }

  private async openPrivacyOptions(): Promise<void> {
    try {
      await platform.showPrivacyOptions?.();
    } catch (err) {
      console.warn('[GameManager] privacy options failed:', err);
    }
    this.updatePrivacyBtn();
  }

  private updatePrivacyBtn(): void {
    const btn = this.overlays.title.querySelector<HTMLElement>('[data-a="privacy"]');
    btn?.classList.toggle('hidden', !platform.privacyOptionsRequired?.());
  }

  private buildOverlays() {
    const title = document.createElement('div');
    title.className = 'overlay title';
    // Top: logo and career stats. The court between stays clear for the demo rally. Bottom: match
    // setup, PLAY and the secondary buttons.
    title.innerHTML = `
      <div class="menu-top">
        <img class="logo-img" src="${UI_ART}logo.png" alt="Pickle Smash" />
        <div class="menu-stats hidden"></div>
      </div>
      <div class="menu-bottom">
        <div class="menu-card">
          <div class="pick">
            <div class="pick-label">OPPONENT</div>
            <div class="seg">
              ${DIFFICULTIES.map((d) => `<button class="seg-opt" data-difficulty="${d}">${d.toUpperCase()}</button>`).join('')}
            </div>
          </div>
          <div class="pick">
            <div class="pick-label">GAME TO <small>(win by 2)</small></div>
            <div class="seg">
              ${MATCH_TARGETS.map((t) => `<button class="seg-opt" data-target="${t}">${t}</button>`).join('')}
            </div>
          </div>
          <div class="pick">
            <div class="pick-label">SCORING</div>
            <div class="seg">
              ${SCORING_MODES.map((m) => `<button class="seg-opt" data-scoring="${m}">${m === 'sideout' ? 'SIDE-OUT' : 'RALLY'}</button>`).join('')}
            </div>
          </div>
        </div>
        <button class="tap art-btn" data-a="play">PLAY</button>
        <div class="menu-links">
          <button class="art-btn btn-howto" data-a="howto">HOW TO PLAY</button>
          <button class="art-btn btn-settings" data-a="settings">SETTINGS</button>
        </div>
        <div class="kbd-hint">
          <span class="kbd">ENTER</span> play &nbsp;·&nbsp; <span class="kbd">← →</span> opponent &nbsp;·&nbsp;
          <span class="kbd">1</span><span class="kbd">2</span><span class="kbd">3</span> game length
        </div>
      </div>
      <div class="menu-modal dim hidden" data-modal="howto">
        <div class="panel howto">
          <div class="logo panel-title">HOW TO PLAY</div>
          <img class="howto-art" alt="" />
          <div class="howto-body"></div>
          <button class="art-btn btn-got-it" data-a="close">GOT IT</button>
        </div>
      </div>
      <div class="menu-modal dim hidden" data-modal="settings">
        <div class="panel">
          <div class="logo panel-title">SETTINGS</div>
          <label class="slider">MUSIC <input type="range" name="music" min="0" max="100" step="5" /></label>
          <label class="slider">SOUND FX <input type="range" name="sfx" min="0" max="100" step="5" /></label>
          <button class="art-btn btn-mute" data-a="mute">MUTE AUDIO</button>
          <button class="art-btn btn-fx" data-a="fx">EFFECTS: FULL</button>
          <button class="art-btn btn-controls" data-a="controls">CONTROLS: AIM &amp; CHARGE</button>
          <button class="btn secondary hidden" data-a="privacy">PRIVACY OPTIONS</button>
          <button class="art-btn btn-done" data-a="close">DONE</button>
        </div>
      </div>`;
    title.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      // A click on a dialog's dimmed backdrop closes it.
      if (el.classList.contains('menu-modal')) {
        this.closeMenuModal();
        return;
      }
      const btn = el.closest<HTMLElement>('[data-target],[data-difficulty],[data-scoring],[data-a]');
      if (!btn) return;
      const { target, difficulty, scoring, a } = btn.dataset;
      if (target) this.menuPick(() => this.setTarget(Number(target) as MatchTarget));
      else if (scoring) this.menuPick(() => this.setScoring(scoring as ScoringMode));
      else if (difficulty) this.menuPick(() => this.setDifficulty(difficulty as Difficulty));
      else if (a === 'play') this.startPlaying();
      else if (a === 'howto' || a === 'settings') this.menuPick(() => this.openMenuModal(a));
      else if (a === 'close') this.menuPick(() => this.closeMenuModal());
      else if (a === 'mute') {
        this.menuPick(() => this.audio.setMuted(!this.audio.muted));
        this.updateMuteBtns();
      } else if (a === 'fx') this.menuPick(() => this.setReducedEffects(!this.reducedFx));
      else if (a === 'controls') this.menuPick(() => this.setControlStyle(this.controlStyle === 'swipe' ? 'charge' : 'swipe'));
      else if (a === 'privacy') this.menuPick(() => void this.openPrivacyOptions());
    });
    title.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      const v = Number(input.value) / 100;
      input.style.setProperty('--fill', `${input.value}%`);
      if (input.name === 'music') this.audio.setBgmVolume(v);
      if (input.name === 'sfx') this.audio.setSfxVolume(v);
    });
    title.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.name !== 'music' && input.name !== 'sfx') return;
      this.saveCustom(input.name === 'music' ? { musicVolume: this.audio.bgmVolume } : { sfxVolume: this.audio.sfxVolume });
      if (input.name === 'sfx') this.audio.play('hit'); // preview the new level
    });

    const pause = document.createElement('div');
    pause.className = 'overlay dim hidden';
    pause.innerHTML = `<div class="panel"><div class="logo" style="font-size:40px">PAUSED</div>
      <button class="art-btn btn-resume" data-a="resume">RESUME</button>
      <button class="art-btn btn-restart" data-a="restart">RESTART</button>
      <button class="art-btn btn-mute" data-a="mute">MUTE AUDIO</button>
      <button class="art-btn btn-fx" data-a="fx">EFFECTS: FULL</button>
      <button class="art-btn btn-controls" data-a="controls">CONTROLS: AIM &amp; CHARGE</button>
      <button class="art-btn btn-main-menu" data-a="menu">MAIN MENU</button></div>`;
    pause.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a === 'resume') this.togglePause();
      if (a === 'restart') {
        this.fsm.resume();
        this.newMatch();
      }
      if (a === 'mute') {
        this.audio.setMuted(!this.audio.muted);
        this.updateMuteBtns();
      }
      if (a === 'fx') {
        this.setReducedEffects(!this.reducedFx);
        this.audio.play('click');
      }
      if (a === 'controls') {
        this.setControlStyle(this.controlStyle === 'swipe' ? 'charge' : 'swipe');
        this.audio.play('click');
      }
      if (a === 'menu') this.goToMenu();
    });

    const matchOver = document.createElement('div');
    matchOver.className = 'overlay dim match-over hidden';
    matchOver.innerHTML = `<div class="panel">
      <div class="result logo" style="font-size:44px"></div>
      <div class="best-rally hidden"></div>
      <div class="final"></div>
      <div class="sub"></div>
      <button class="btn second-chance hidden" data-a="chance">${SECOND_CHANCE_LABEL}</button>
      <button class="art-btn btn-play-again" data-a="again">PLAY AGAIN</button>
      <button class="art-btn btn-main-menu" data-a="menu">MAIN MENU</button></div>`;
    matchOver.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const a = target.dataset.a;
      if (!a || this.ads.busy) return;
      this.audio.play('click');
      if (a === 'chance') void this.secondChance(target as HTMLButtonElement);
      if (a === 'again') void this.leaveMatchOver(() => this.newMatch());
      if (a === 'menu') void this.leaveMatchOver(() => this.goToMenu());
    });

    this.uiRoot.append(title, pause, matchOver);
    return { title, pause, matchOver };
  }

  // ---------------------------------------------------------------- presentation helpers

  /** Every 5 shots: callout, hotter rally counter; crowd tension follows the rally length. */
  private rallyMilestone(shots: number): void {
    this.crowd?.setTension(shots / 15);
    if (shots === 0 || shots % MILESTONE_EVERY !== 0) return;
    const n = shots / MILESTONE_EVERY;
    this.hud.callout(MILESTONE_CALLS[Math.min(n, MILESTONE_CALLS.length) - 1], Math.min(3, n));
    this.hud.setRallyHeat(Math.min(3, n));
  }

  /** Dust at the feet on a hard push-off (sprint start or sharp change of direction). */
  private updateFootwork(sim: Athlete, a: Athlete, dt: number): void {
    const fw = this.footwork.get(sim)!;
    if (dt <= 0) return;
    fw.cooldown -= dt;
    const d = this.scratch.subVectors(a.vel, fw.lag).setY(0);
    fw.lag.lerp(a.vel, 1 - Math.exp(-10 * dt));
    if (fw.cooldown > 0 || d.length() < FOOT_KICK || Math.hypot(a.vel.x, a.vel.z) < 1.2) return;
    fw.cooldown = FOOT_COOLDOWN;
    this.effects.footDust(a.pos, d.normalize());
  }

  /** Projects a world point to client (CSS px) coordinates in `out`; false if behind the camera. */
  private toScreen(p: THREE.Vector3, out: THREE.Vector3): boolean {
    out.copy(p).project(this.sceneMgr.camera);
    if (out.z > 1) return false;
    const rect = this.sceneMgr.renderer.domElement.getBoundingClientRect();
    out.set(rect.left + ((out.x + 1) / 2) * rect.width, rect.top + ((1 - out.y) / 2) * rect.height, 0);
    out.x = Math.min(rect.right - 24, Math.max(rect.left + 24, out.x));
    out.y = Math.min(rect.bottom - 24, Math.max(rect.top + 24, out.y));
    return true;
  }

  /** Final score ticks up from 0–0 (instant under reduce-effects). */
  private countUpFinal(el: HTMLElement, hero: number, rival: number): void {
    const show = (k: number) => (el.textContent = `${Math.round(hero * k)} – ${Math.round(rival * k)}`);
    if (this.reducedFx) {
      show(1);
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 900);
      show(1 - Math.pow(1 - k, 3));
      if (k < 1) requestAnimationFrame(step);
    };
    show(0);
    requestAnimationFrame(step);
  }

  private updateIndicators(dt: number): void {
    const r = this.rally;
    const intent = this.heroCtl.intent;
    let aim: AimMarker | null = null;
    const heroServing = r.phase === 'serve' && r.server === this.hero;
    const heroToHit = r.phase === 'live' && r.lastHitter !== this.hero;
    // Swipe controls aim by the gesture alone: no reticle on the opponent's court.
    const showAim = this.controlStyle !== 'swipe' || this.heroCtl.input !== this.local;
    if (intent && showAim && (heroServing || heroToHit) && this.fsm.state !== GameStateId.MAIN_MENU) {
      // Once the swing is under way the locked direction-at-hit aim is shown; before that, a live
      // preview of where the held direction would send the ball (committed while charging).
      const sw = this.hero.swing;
      const swinging = sw.active && !sw.contact;
      const src = swinging ? this.heroCtl.swingAim : intent;
      const a = heroServing ? clampServeAim(r.serveFromRight, src.aimX, src.aimDepth) : src;
      const p = aimToWorld(this.hero.side, a.aimX, a.aimDepth);
      const charge = swinging ? this.heroCtl.swingAim.power : intent.charging ? intent.power : 0;
      aim = { x: p.x, z: p.z, locked: swinging || intent.charging, charge: charge >= POWER.MIN ? charge : 0 };
    }
    let landing: LandingMarker | null = null;
    if (this.landing && r.phase === 'live') {
      const d = Math.hypot(this.landing.x - this.hero.pos.x, this.landing.z - this.hero.pos.z);
      const remaining01 = 1 - (r.time - this.landingAt) / this.landingFlight;
      landing = { ...this.landing, good: d < PLAYER.REACH + 0.6, remaining01 };
    }
    this.indicators.update(dt, aim, landing);
  }

  /** Charge meter above the hero's head while the swing button is held. */
  private updateChargeMeter(): void {
    const intent = this.heroCtl.intent;
    const show = intent?.charging && this.heroCtl.input === this.local && !this.hero.holdingBall;
    this.scratch.set(this.heroR.pos.x, PLAYER.MODEL_HEIGHT + 0.35, this.heroR.pos.z);
    if (show && this.toScreen(this.scratch, this.scratch)) {
      this.hud.setCharge(intent.power, this.scratch.x, this.scratch.y, intent.power >= POWER.MIN);
    } else {
      this.hud.setCharge(null);
    }
  }

  private updateHint(): void {
    const r = this.rally;
    let text = '';
    if (this.fsm.state === GameStateId.SERVING && r.server === this.hero) {
      text = this.touch.active ? 'Tap on the right to serve diagonally (swipe to aim)' : 'SPACE / CLICK to serve · hold A or D to aim';
    } else if (this.fsm.state === GameStateId.SERVING) {
      text = 'Get ready to return — let the serve bounce';
    } else if (this.fsm.state === GameStateId.RALLY && r.lastHitter !== this.hero) {
      text = this.touch.active
        ? 'Tap to hit · hold for power · swipe to aim'
        : 'SPACE to hit · hold for power · direction keys aim';
    }
    this.hud.setHint(text);
  }

  private pickGround = (clientX: number, clientY: number): { x: number; z: number } | null => {
    const el = this.sceneMgr.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - el.left) / el.width) * 2 - 1, -((clientY - el.top) / el.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.sceneMgr.camera);
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, this.hitPoint);
    return hit ? { x: hit.x, z: hit.z } : null;
  };

  private debugText(): string {
    const r = this.rally;
    const b = r.ball.state;
    const t = this.ai.debugTarget;
    return [
      ...(this.frozen ? ['** FROZEN **  F resume · . step one tick'] : []),
      `FPS        ${this.fps.toFixed(0)}  (${this.sceneMgr.quality})`,
      `state      ${this.fsm.state} / rally:${r.phase}`,
      `server     ${r.server?.name} (${r.serveFromRight ? 'right' : 'left'})`,
      `last hit   ${r.lastHitter?.name ?? '-'}  shot #${r.shotIndex}`,
      `bounces    ${r.bouncesSinceHit}`,
      `ball pos   ${b.pos.x.toFixed(2)}, ${b.pos.y.toFixed(2)}, ${b.pos.z.toFixed(2)}`,
      `ball speed ${b.vel.length().toFixed(1)} m/s  spin ${b.spin.length().toFixed(0)} rad/s`,
      `AI target  ${t.x.toFixed(2)}, ${t.z.toFixed(2)}`,
      `rally time ${r.rallyTime.toFixed(1)}s`,
    ].join('\n');
  }
}
