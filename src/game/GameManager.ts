import * as THREE from 'three';
import { AudioManager } from '../audio/AudioManager';
import { buildCourt } from '../court/Court';
import type { Crowd } from '../court/Crowd';
import { buildEnvironment, OUTDOOR_THEME, type Ambient } from '../court/Environment';
import { NetView } from '../court/Net';
import { clampServeAim } from '../gameplay/ShotSystem';
import {
  distanceToNearestLine,
  isGamePoint,
  MATCH_TARGETS,
  matchWinner,
  sideOfZ,
  type MatchTarget,
  type RallyOutcome,
} from '../gameplay/RuleManager';
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
import { Indicators, type LandingMarker } from '../render/Indicators';
import { LineCalls } from '../render/LineCalls';
import { PaddleSwoosh } from '../render/PaddleSwoosh';
import { RIVAL_PADDLE, STARTER_PADDLE, type PaddleLook } from '../render/PaddleModel';
import { detectQuality, SceneManager } from '../render/SceneManager';
import { SkinnedAthleteView } from '../render/SkinnedAthleteView';
import { HUD } from '../ui/HUD';
import { TouchControls } from '../ui/TouchControls';
import { FAR, NEAR, PLAYER, SIM } from '../utils/Constants';
import { aimToWorld, Rng } from '../utils/MathUtils';
import { GameStateId, GameStateMachine } from './GameState';
import { HitStop } from './HitStop';
import { RallyManager } from './RallyManager';
import { platform } from '../platforms';

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
  private ai: AIController;
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
  private uiRoot: HTMLElement;
  private overlays: { title: HTMLElement; pause: HTMLElement; matchOver: HTMLElement };

  private accumulator = 0;
  private lastFrame = 0;
  private pointTimer = 0;
  private landing: { x: number; z: number } | null = null;
  /** Rally (sim) time the landing was predicted at, and the predicted flight time to it. */
  private landingAt = 0;
  private landingFlight = 1;
  /** Where the ball last touched the court (for the OUT mark). */
  private lastBounce = new THREE.Vector3();
  private tally = { hero: 0, rival: 0 };
  /** Bumped on each serve so a late "+1" flyer can't overwrite a newer score. */
  private pointSeq = 0;
  /** Longest rally this match, and the stored best when the match began ("NEW BEST RALLY!"). */
  private matchBestRally = 0;
  private bestAtMatchStart = 0;
  private footwork = new Map<Athlete, Footwork>();
  private target: MatchTarget = 11;
  private stats = { matchesPlayed: 0, matchesWon: 0, bestRally: 0 };
  /** Platform-saved free-form data, kept so saving one key doesn't drop the others. */
  private customData: Record<string, unknown> = {};
  /** "Reduce effects": no camera kicks, hit-stop, flashes or HUD pops. */
  private reducedFx = false;
  private nextServer!: Athlete;
  private nextFromRight = true;
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
    for (const a of [this.hero, this.rival]) this.footwork.set(a, { lag: new THREE.Vector3(), cooldown: 0 });
    this.touch = new TouchControls(uiRoot);
    this.local = new LocalInputProvider(this.sceneMgr.renderer.domElement, this.pickGround, this.touch);
    this.ai = new AIController(AI_PROFILES.medium, (Date.now() & 0xffff) + 1);
    this.heroCtl = new PlayerController(this.hero, this.local);
    const rivalCtl = new PlayerController(this.rival, this.ai);
    this.rally = new RallyManager([this.heroCtl, rivalCtl], new Rng(Date.now() & 0xffffff));

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
    this.overlays = this.buildOverlays();
    this.setTarget(this.target, false);
    this.setReducedEffects(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, false);
    this.bindRallyEvents();
    this.bindGlobalInput();
    this.bindPlatformEvents();
    this.fsm.onChange((to) => this.onStateChange(to));

    // Show the court behind the title screen.
    this.nextServer = this.hero;
    this.rally.startServe(this.hero, true);
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
        if (saved.customData) this.customData = { ...saved.customData };
        if (typeof this.customData.reducedEffects === 'boolean') this.setReducedEffects(this.customData.reducedEffects, false);
      }
    } catch (err) {
      console.warn('[GameManager] Failed to load progress from platform:', err);
    }
  }

  /** Toggles motion-heavy effects (camera kicks and shake, hit-stop, flashes, HUD pops). */
  setReducedEffects(v: boolean, persist = true): void {
    this.reducedFx = v;
    this.cameraRig.shakeEnabled = !v;
    this.hitStop.enabled = !v;
    if (v) this.hitStop.clear();
    this.effects.flashEnabled = !v;
    this.netView.flashEnabled = !v;
    this.uiRoot.classList.toggle('reduce-fx', v);
    this.updatePauseFxBtn();
    if (persist) {
      this.customData = { ...this.customData, reducedEffects: v };
      void platform.saveProgress({ customData: this.customData });
    }
  }

  /** Simple difficulty switch (full menu flow arrives in Phase 5). */
  setDifficulty(d: Difficulty): void {
    this.ai.profile = AI_PROFILES[d];
  }

  start(): void {
    this.fsm.go(GameStateId.MAIN_MENU);
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- loop

  private frame = (now: number): void => {
    requestAnimationFrame(this.frame);
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
        this.tick(SIM.TICK_DT);
        this.stepTicks--;
      }
    } else if (simulating) {
      const wasStopped = this.hitStop.active;
      worldDt = this.hitStop.scale(dt);
      this.accumulator += worldDt;
      let ticks = 0;
      while (this.accumulator >= SIM.TICK_DT && ticks < SIM.MAX_TICKS_PER_FRAME) {
        this.tick(SIM.TICK_DT);
        this.accumulator -= SIM.TICK_DT;
        ticks++;
        // A hit-stop that starts mid-frame drops the rest of this frame so the freeze is crisp.
        if (!wasStopped && this.hitStop.active) {
          this.accumulator = 0;
          break;
        }
      }
      if (ticks === SIM.MAX_TICKS_PER_FRAME) this.accumulator = 0; // drop time rather than spiral
    }
    this.render(this.frozen ? 0 : worldDt, this.frozen ? 0 : dt);
  };

  private tick(dt: number): void {
    // On the title screen the rally sits idle with the hero holding the ball.
    if (this.fsm.state === GameStateId.MAIN_MENU) return;
    this.rally.tick(dt);
    if (this.fsm.state === GameStateId.POINT_END) {
      this.pointTimer -= dt;
      if (this.pointTimer <= 0) this.afterPoint();
    }
  }

  /** `worldDt` drives everything in the scene (slowed by hit-stop); `dt` is real frame time. */
  private render(worldDt: number, dt: number): void {
    const r = this.rally;
    const { camera, renderer } = this.sceneMgr;
    this.heroView.update(this.hero, worldDt);
    this.rivalView.update(this.rival, worldDt);
    this.ballView.update(r.ball.state, worldDt, camera);
    this.heroSwoosh.update(this.hero, this.heroView, camera);
    this.rivalSwoosh.update(this.rival, this.rivalView, camera);
    this.netView.update(worldDt);
    this.lineCalls.update(worldDt);
    this.crowd?.update(worldDt);
    this.ambient?.update(worldDt);
    this.updateFootwork(this.hero, worldDt);
    this.updateFootwork(this.rival, worldDt);
    this.heroView.setMarkerPulse(r.phase === 'live' && r.lastHitter !== this.hero);
    this.cameraRig.update(this.cameraFocus(), dt);
    this.effects.update(worldDt, camera, renderer.domElement.height);
    this.updateIndicators(dt);
    this.updateHint();
    this.hud.update(dt);
    if (this.debug || this.frozen) this.hud.setDebug(this.debugText());
    this.sceneMgr.render();
  }

  private cameraFocus() {
    const r = this.rally;
    return { player: this.hero.pos, ball: r.ball.state.pos, ballLive: r.phase === 'live', side: this.hero.side };
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
    el.querySelector('.sub')!.textContent = `Game to ${this.target} · win by 2`;
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
    this.fsm.go(GameStateId.MATCH_OVER);

    platform.onGameplayStop();
    void platform.submitScore(this.tally.hero);
    this.stats.matchesPlayed = (this.stats.matchesPlayed ?? 0) + 1;
    if (heroWon) this.stats.matchesWon = (this.stats.matchesWon ?? 0) + 1;
    void platform.saveProgress(this.stats);

    if (platform.capabilities.ads) {
      void platform.showInterstitialAd();
    }
  }

  private newMatch(): void {
    this.tally = { hero: 0, rival: 0 };
    this.matchBestRally = 0;
    this.bestAtMatchStart = this.stats.bestRally;
    this.nextServer = this.hero;
    this.nextFromRight = true;
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
    this.ballView.resetTrail();
    this.lineCalls.clear();
    this.clearPointMoments();
    this.effects.clearConfetti();
    this.hitStop.clear();
    this.rally.startServe(this.hero, true);
    this.cameraRig.snap(this.cameraFocus());
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

  private onStateChange(to: GameStateId): void {
    const inMatch = to !== GameStateId.MAIN_MENU && to !== GameStateId.LOADING;
    this.hud.setVisible(inMatch);
    this.touch.setVisible(inMatch && to !== GameStateId.PAUSED && to !== GameStateId.MATCH_OVER);
    this.local.enabled = to === GameStateId.SERVING || to === GameStateId.RALLY || to === GameStateId.POINT_END;
    this.overlays.title.classList.toggle('hidden', to !== GameStateId.MAIN_MENU);
    this.overlays.pause.classList.toggle('hidden', to !== GameStateId.PAUSED);
    this.overlays.matchOver.classList.toggle('hidden', to !== GameStateId.MATCH_OVER);
    if (to === GameStateId.PAUSED) {
      this.accumulator = 0;
      this.updatePauseMuteBtn();
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
    const wasGamePoint = isGamePoint(prev.hero, prev.rival, this.target) || isGamePoint(prev.rival, prev.hero, this.target);
    if (outcome.winner !== null) {
      // Phase 1 tally: winner of the rally serves next. Singles rule: serve from the right on an
      // even score, from the left on an odd one.
      const winner = heroWon ? this.hero : this.rival;
      if (heroWon) this.tally.hero++;
      else this.tally.rival++;
      this.nextFromRight = (heroWon ? this.tally.hero : this.tally.rival) % 2 === 0;
      this.nextServer = winner;
    }
    // "+1" flies from where the point ended into the winner's score, which updates on arrival.
    const fly = outcome.winner !== null && !this.reducedFx && this.toScreen(this.rally.ball.state.pos, this.scratch);
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
    const small = w ? (w === 'a' ? 'GAME — you win the match!' : 'GAME — CPU wins the match') : detail;
    this.hud.setGamePoint(
      w ? null : isGamePoint(hero, rival, this.target) ? 'hero' : isGamePoint(rival, hero, this.target) ? 'rival' : null,
    );
    const slam = outcome.reason === 'MISS' && heroWon;
    this.hud.showBanner(big, small, outcome.winner === null ? 'neutral' : heroWon ? 'good' : 'bad', POINT_PAUSE - 0.2, slam);
    if (outcome.reason === 'OUT_OF_BOUNDS') this.lineCalls.showOut(this.lastBounce.x, this.lastBounce.z);
    if (outcome.winner !== null) {
      this.audio.play(heroWon ? 'pointWon' : 'pointLost');
      this.crowd?.cheer(heroWon ? 1 : 0.6);
      this.hud.edgeGlow(heroWon ? 'good' : 'bad');
      this.heroView.react(heroWon ? 'win' : 'lose');
      this.rivalView.react(heroWon ? 'lose' : 'win');
      // Push in on the OUT mark, otherwise on the point's winner.
      this.cameraRig.setPointFocus(outcome.reason === 'OUT_OF_BOUNDS' ? this.lastBounce : (heroWon ? this.hero : this.rival).pos);
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
    }
  }

  // ---------------------------------------------------------------- events

  private bindRallyEvents(): void {
    const bus = this.rally.bus;
    bus.on('hit', (e) => {
      const pan = e.pos.x / 6;
      const intensity = Math.min(1, e.speed / 22);
      const power = intensity > 0.75;
      (e.athlete === this.hero ? this.heroView : this.rivalView).onHit(intensity);
      this.audio.play(e.kind === 'serve' ? 'serve' : power ? 'powerHit' : intensity < 0.35 ? 'softHit' : 'hit', intensity, pan);
      // Kick on every hero contact (felt in the hands), and on any power shot.
      const kick = Math.max(power ? 0.45 : 0, e.athlete === this.hero ? 0.2 + 0.2 * intensity : 0);
      if (kick > 0) this.cameraRig.impulse(kick);
      if (e.kind === 'stroke') this.hitStop.trigger(power ? 0.07 : intensity > 0.45 ? 0.04 : 0);
      if (e.kind === 'stroke' && power) this.cameraRig.punch(1.5);
      const vel = this.rally.ball.state.vel;
      this.effects.hitBurst(e.pos, vel, intensity);
      this.ballView.onHit(vel, intensity);
      if (e.athlete === this.hero && platform.capabilities.haptics) {
        platform.vibrate?.(intensity > 0.75 ? 35 : 15);
      }
      this.ballView.resetTrail();
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
      this.audio.play('bounce', Math.min(1, e.speed / 8), e.pos.x / 6);
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
      this.audio.play('net', 0.6, e.pos.x / 6);
      this.netView.onHit(e.pos.x, e.tape);
      this.effects.netPuff(e.pos, e.tape);
      if (e.tape) {
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
      this.stats.bestRally = Math.max(this.stats.bestRally, e.shots);
      this.matchBestRally = Math.max(this.matchBestRally, e.shots);
      this.onRallyEnd(e.outcome, e.shots);
    });
  }

  private bindGlobalInput(): void {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' || e.code === 'KeyP') this.togglePause();
      if (e.code === 'KeyM' && !e.repeat) {
        this.audio.setMuted(!this.audio.muted);
        this.updatePauseMuteBtn();
      }
      if (e.code === 'Backquote' || e.code === 'F3') {
        this.debug = !this.debug;
        if (!this.debug && !this.frozen) this.hud.setDebug(null);
        e.preventDefault();
      }
      if (e.code === 'KeyF' && !e.repeat) {
        this.frozen = !this.frozen;
        this.stepTicks = 0;
        if (!this.frozen && !this.debug) this.hud.setDebug(null);
      }
      if (e.code === 'Period' && this.frozen) this.stepTicks++;
      if (this.fsm.state === GameStateId.MAIN_MENU) {
        if (e.code === 'Space' || e.code === 'Enter') this.startPlaying();
        const idx = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
        if (idx >= 0) this.setTarget(MATCH_TARGETS[idx]);
      } else if (this.fsm.state === GameStateId.MATCH_OVER && (e.code === 'Space' || e.code === 'Enter')) {
        this.newMatch();
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
        this.goToMenu();
      }
    });
    platform.onAdStateChange?.((active) => {
      if (active) {
        this.audio.setMuted(true);
        if (!this.fsm.isPaused) this.fsm.pause();
      } else {
        this.audio.setMuted(false);
      }
      this.updatePauseMuteBtn();
    });
  }

  private togglePause(): void {
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

  private updatePauseMuteBtn(): void {
    const btn = this.overlays?.pause?.querySelector<HTMLElement>('[data-a="mute"]');
    if (btn) btn.textContent = this.audio.muted ? 'UNMUTE AUDIO' : 'MUTE AUDIO';
  }

  private updatePauseFxBtn(): void {
    const btn = this.overlays?.pause?.querySelector<HTMLElement>('[data-a="fx"]');
    if (btn) btn.textContent = this.reducedFx ? 'EFFECTS: REDUCED' : 'EFFECTS: FULL';
  }

  private startPlaying(): void {
    if (this.fsm.state !== GameStateId.MAIN_MENU) return;
    this.audio.unlock();
    this.audio.play('click');
    this.newMatch();
  }

  private buildOverlays() {
    const title = document.createElement('div');
    title.className = 'overlay title';
    title.innerHTML = `
      <div class="logo">PICKLE<span>SMASH</span></div>
      <div class="match-len">
        <div class="match-len-label">GAME LENGTH <small>(win by 2)</small></div>
        <div class="match-len-opts">
          ${MATCH_TARGETS.map((t) => `<button class="opt" data-target="${t}">${t}<small>POINTS</small></button>`).join('')}
        </div>
      </div>
      <button class="tap" data-a="play">PLAY</button>
      <div class="controls-help">
        <span class="kbd">W A S D</span> move &nbsp; <span class="kbd">SHIFT</span> sprint &nbsp;
        <span class="kbd">SPACE</span> / <span class="kbd">CLICK</span> swing<br/>
        Point the mouse at the far court to aim &nbsp;·&nbsp; <span class="kbd">ESC</span> pause &nbsp;·&nbsp; <span class="kbd">M</span> mute &nbsp;·&nbsp; <span class="kbd">\`</span> debug &nbsp;·&nbsp; <span class="kbd">F</span> freeze<br/>
        Mobile: left thumb moves, tap or swipe on the right to hit
      </div>`;
    title.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-target],[data-a]');
      if (btn?.dataset.target) {
        this.audio.unlock();
        this.setTarget(Number(btn.dataset.target) as MatchTarget);
        this.audio.play('click');
      } else if (btn?.dataset.a === 'play') {
        this.startPlaying();
      }
    });

    const pause = document.createElement('div');
    pause.className = 'overlay dim hidden';
    pause.innerHTML = `<div class="panel"><div class="logo" style="font-size:40px">PAUSED</div>
      <button class="btn" data-a="resume">RESUME</button>
      <button class="btn secondary" data-a="restart">RESTART</button>
      <button class="btn secondary" data-a="mute">MUTE AUDIO</button>
      <button class="btn secondary" data-a="fx">EFFECTS: FULL</button>
      <button class="btn secondary" data-a="menu">MAIN MENU</button></div>`;
    pause.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a === 'resume') this.togglePause();
      if (a === 'restart') {
        this.fsm.resume();
        this.newMatch();
      }
      if (a === 'mute') {
        this.audio.setMuted(!this.audio.muted);
        this.updatePauseMuteBtn();
      }
      if (a === 'fx') {
        this.setReducedEffects(!this.reducedFx);
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
      <button class="btn" data-a="again">PLAY AGAIN</button>
      <button class="btn secondary" data-a="menu">MAIN MENU</button></div>`;
    matchOver.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a) this.audio.play('click');
      if (a === 'again') this.newMatch();
      if (a === 'menu') this.goToMenu();
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
  private updateFootwork(a: Athlete, dt: number): void {
    const fw = this.footwork.get(a)!;
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
    let aim: { x: number; z: number } | null = null;
    const heroServing = r.phase === 'serve' && r.server === this.hero;
    const heroToHit = r.phase === 'live' && r.lastHitter !== this.hero;
    if (intent && (heroServing || heroToHit) && this.fsm.state !== GameStateId.MAIN_MENU) {
      const a = heroServing ? clampServeAim(r.serveFromRight, intent.aimX, intent.aimDepth) : { aimX: intent.aimX, aimDepth: intent.aimDepth };
      aim = aimToWorld(this.hero.side, a.aimX, a.aimDepth);
    }
    let landing: LandingMarker | null = null;
    if (this.landing && r.phase === 'live') {
      const d = Math.hypot(this.landing.x - this.hero.pos.x, this.landing.z - this.hero.pos.z);
      const remaining01 = 1 - (r.time - this.landingAt) / this.landingFlight;
      landing = { ...this.landing, good: d < PLAYER.REACH + 0.6, remaining01 };
    }
    this.indicators.update(dt, aim, landing);
  }

  private updateHint(): void {
    const r = this.rally;
    let text = '';
    if (this.fsm.state === GameStateId.SERVING && r.server === this.hero) {
      text = this.touch.active ? 'Swipe or tap on the right to serve diagonally' : 'Aim with the mouse · SPACE / CLICK to serve';
    } else if (this.fsm.state === GameStateId.SERVING) {
      text = 'Get ready to return — let the serve bounce';
    } else if (this.fsm.state === GameStateId.RALLY && r.lastHitter !== this.hero) {
      text = this.touch.active ? 'Move to the ball · tap / swipe to hit' : 'Move to the ball · SPACE / CLICK to hit';
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
