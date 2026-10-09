import * as THREE from 'three';
import { AudioManager } from '../audio/AudioManager';
import { buildCourt } from '../court/Court';
import { buildEnvironment, OUTDOOR_THEME } from '../court/Environment';
import { buildNet } from '../court/Net';
import { clampServeAim } from '../gameplay/ShotSystem';
import { isGamePoint, MATCH_TARGETS, matchWinner, type MatchTarget, type RallyOutcome } from '../gameplay/RuleManager';
import { predictLanding } from '../physics/Trajectory';
import { AIController, AI_PROFILES, type Difficulty } from '../players/AIController';
import { Athlete } from '../players/Athlete';
import { LocalInputProvider } from '../players/LocalInputProvider';
import { PlayerController } from '../players/PlayerController';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HERO_LOOK, PrimitiveAthleteView, RIVAL_LOOK, type AthleteLook, type AthleteRig } from '../render/AthleteView';
import { BallView } from '../render/BallView';
import { CameraRig } from '../render/CameraRig';
import { Indicators } from '../render/Indicators';
import { RIVAL_PADDLE, STARTER_PADDLE, type PaddleLook } from '../render/PaddleModel';
import { detectQuality, SceneManager } from '../render/SceneManager';
import { SkinnedAthleteView } from '../render/SkinnedAthleteView';
import { HUD } from '../ui/HUD';
import { TouchControls } from '../ui/TouchControls';
import { FAR, NEAR, PLAYER, SIM } from '../utils/Constants';
import { aimToWorld, Rng } from '../utils/MathUtils';
import { GameStateId, GameStateMachine } from './GameState';
import { RallyManager } from './RallyManager';
import { platform } from '../platforms';

const POINT_PAUSE = 1.9;

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
  private hud: HUD;
  private uiRoot: HTMLElement;
  private overlays: { title: HTMLElement; pause: HTMLElement; matchOver: HTMLElement };

  private accumulator = 0;
  private lastFrame = 0;
  private pointTimer = 0;
  private landing: { x: number; z: number } | null = null;
  private tally = { hero: 0, rival: 0 };
  private target: MatchTarget = 11;
  private stats = { matchesPlayed: 0, matchesWon: 0, bestRally: 0 };
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

  /** `athleteModel` is the rigged player GLB; null falls back to the primitive players. */
  constructor(gameRoot: HTMLElement, uiRoot: HTMLElement, onProgress: (p: number) => void, athleteModel: GLTF | null = null) {
    this.uiRoot = uiRoot;
    this.sceneMgr = new SceneManager(gameRoot, detectQuality());
    const { scene, camera } = this.sceneMgr;
    onProgress(0.2);

    buildEnvironment(scene, OUTDOOR_THEME, this.sceneMgr.quality);
    scene.add(buildCourt(), buildNet());
    onProgress(0.5);

    this.hero = new Athlete('hero', NEAR, 'You');
    this.rival = new Athlete('rival', FAR, 'CPU');
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
    this.cameraRig = new CameraRig(camera);
    this.sceneMgr.onResize((w, h) => this.cameraRig.setAspect(w / h));
    onProgress(0.8);

    this.hud = new HUD(uiRoot, 'You', 'CPU');
    this.overlays = this.buildOverlays();
    this.setTarget(this.target, false);
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
      }
    } catch (err) {
      console.warn('[GameManager] Failed to load progress from platform:', err);
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
    if (simulating && this.frozen) {
      // Frozen: only advance when a single-step was requested.
      this.accumulator = 0;
      while (this.stepTicks > 0) {
        this.tick(SIM.TICK_DT);
        this.stepTicks--;
      }
    } else if (simulating) {
      this.accumulator += dt;
      let ticks = 0;
      while (this.accumulator >= SIM.TICK_DT && ticks < SIM.MAX_TICKS_PER_FRAME) {
        this.tick(SIM.TICK_DT);
        this.accumulator -= SIM.TICK_DT;
        ticks++;
      }
      if (ticks === SIM.MAX_TICKS_PER_FRAME) this.accumulator = 0; // drop time rather than spiral
    }
    this.render(this.frozen ? 0 : dt);
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

  private render(dt: number): void {
    const r = this.rally;
    this.heroView.update(this.hero, dt);
    this.rivalView.update(this.rival, dt);
    this.ballView.update(r.ball.state, dt, this.sceneMgr.camera);
    this.cameraRig.update(this.cameraFocus(), dt);
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
    this.ballView.resetTrail();
    this.landing = null;
    this.rally.startServe(this.nextServer, this.nextFromRight);
    this.fsm.go(GameStateId.SERVING);
    this.hud.setScores(this.tally.hero, this.tally.rival, this.nextServer === this.hero);
    this.hud.setRally(0);
    platform.onGameplayStart();
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
    el.querySelector('.final')!.textContent = `${this.tally.hero} – ${this.tally.rival}`;
    el.querySelector('.sub')!.textContent = `Game to ${this.target} · win by 2`;
    this.hud.setHint('');
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
    this.nextServer = this.hero;
    this.nextFromRight = true;
    this.hud.setTarget(this.target);
    this.beginServe();
  }

  private goToMenu(): void {
    platform.onGameplayStop();
    this.fsm.go(GameStateId.MAIN_MENU);
    this.ballView.resetTrail();
    this.landing = null;
    this.rally.startServe(this.hero, true);
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
    if (to === GameStateId.PAUSED) this.accumulator = 0;
  }

  private onRallyEnd(outcome: RallyOutcome, shots: number): void {
    const heroWon = outcome.winner === this.hero.side;
    if (outcome.winner !== null) {
      // Phase 1 tally: winner of the rally serves next, switching sides after each point it wins.
      const winner = heroWon ? this.hero : this.rival;
      if (heroWon) this.tally.hero++;
      else this.tally.rival++;
      this.nextFromRight = winner === this.nextServer ? !this.nextFromRight : true;
      this.nextServer = winner;
    }
    this.hud.setScores(this.tally.hero, this.tally.rival, null);
    const [big, detail] = this.describeOutcome(outcome, heroWon, shots);
    const { hero, rival } = this.tally;
    const w = matchWinner(hero, rival, this.target);
    let small = detail;
    if (w) small = w === 'a' ? 'GAME — you win the match!' : 'GAME — CPU wins the match';
    else if (isGamePoint(hero, rival, this.target) || isGamePoint(rival, hero, this.target)) small = `${detail} · GAME POINT`;
    this.hud.showBanner(big, small, outcome.winner === null ? 'neutral' : heroWon ? 'good' : 'bad', POINT_PAUSE - 0.2);
    if (outcome.winner !== null) this.audio.play(heroWon ? 'pointWon' : 'pointLost');
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
      this.audio.play(e.kind === 'serve' ? 'serve' : intensity > 0.75 ? 'powerHit' : intensity < 0.35 ? 'softHit' : 'hit', intensity, pan);
      if (intensity > 0.8) this.cameraRig.impulse(0.35);
      if (e.athlete === this.hero && platform.capabilities.haptics) {
        platform.vibrate?.(intensity > 0.75 ? 35 : 15);
      }
      this.ballView.resetTrail();
      if (this.fsm.state === GameStateId.SERVING) this.fsm.go(GameStateId.RALLY);
      this.hud.setRally(e.shotIndex);
      // Landing assist for balls coming toward the hero.
      if (e.athlete !== this.hero) {
        const p = predictLanding(this.rally.ball.state);
        this.landing = p && !p.hitsNet ? { x: p.point.x, z: p.point.z } : null;
      } else {
        this.landing = null;
      }
    });
    bus.on('bounce', (e) => {
      this.audio.play('bounce', Math.min(1, e.speed / 8), e.pos.x / 6);
      this.landing = null;
    });
    bus.on('net', (e) => this.audio.play('net', 0.6, e.pos.x / 6));
    bus.on('rallyEnd', (e) => {
      this.stats.bestRally = Math.max(this.stats.bestRally, e.shots);
      this.onRallyEnd(e.outcome, e.shots);
    });
  }

  private bindGlobalInput(): void {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' || e.code === 'KeyP') this.togglePause();
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
        Point the mouse at the far court to aim &nbsp;·&nbsp; <span class="kbd">ESC</span> pause &nbsp;·&nbsp; <span class="kbd">\`</span> debug &nbsp;·&nbsp; <span class="kbd">F</span> freeze<br/>
        Mobile: left thumb moves, tap or swipe on the right to hit
      </div>`;
    title.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-target],[data-a]');
      if (btn?.dataset.target) {
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
      <button class="btn secondary" data-a="menu">MAIN MENU</button></div>`;
    pause.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a === 'resume') this.togglePause();
      if (a === 'restart') {
        this.fsm.resume();
        this.newMatch();
      }
      if (a === 'menu') this.goToMenu();
    });

    const matchOver = document.createElement('div');
    matchOver.className = 'overlay dim hidden';
    matchOver.innerHTML = `<div class="panel">
      <div class="result logo" style="font-size:44px"></div>
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
    let landing: { x: number; z: number; good: boolean } | null = null;
    if (this.landing && r.phase === 'live') {
      const d = Math.hypot(this.landing.x - this.hero.pos.x, this.landing.z - this.hero.pos.z);
      landing = { ...this.landing, good: d < PLAYER.REACH + 0.6 };
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
