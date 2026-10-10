/** DOM overlay for the in-match HUD. Knows nothing about gameplay; GameManager pushes values in. */
export class HUD {
  readonly root: HTMLDivElement;
  private heroScore: HTMLElement;
  private rivalScore: HTMLElement;
  private heroBox: HTMLElement;
  private rivalBox: HTMLElement;
  private rallyEl: HTMLElement;
  private targetEl: HTMLElement;
  private banner: HTMLDivElement;
  private bannerTimer = 0;
  private edgeGlowEl: HTMLDivElement;
  private gamePointEl: HTMLDivElement;
  private calloutEl: HTMLDivElement;
  private hint: HTMLDivElement;
  private debugEl: HTMLDivElement;
  readonly pauseButton: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    private readonly heroName: string,
    private readonly rivalName: string,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'hud hidden';
    this.root.innerHTML = `
      <div class="edge-glow"></div>
      <div class="hud-corner">
        <div class="hud-top">
          <div class="hud-score hero"><span class="label"></span><span class="value">0</span><span class="serve-dot">● SERVING</span></div>
          <div class="hud-mid"><span class="target"></span><span>RALLY</span><span class="rally">0</span></div>
          <div class="hud-score rival"><span class="label"></span><span class="value">0</span><span class="serve-dot">● SERVING</span></div>
        </div>
        <div class="gp-badge hidden"></div>
        <div class="callout"></div>
      </div>
      <div class="banner"><div class="big"></div><div class="small"></div></div>
      <div class="hint"></div>
      <button class="pause-btn" aria-label="Pause">II</button>
      <div class="debug hidden"></div>`;
    parent.appendChild(this.root);
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    this.heroBox = q('.hud-score.hero');
    this.rivalBox = q('.hud-score.rival');
    this.heroBox.querySelector('.label')!.textContent = heroName.toUpperCase();
    this.rivalBox.querySelector('.label')!.textContent = rivalName.toUpperCase();
    this.heroScore = this.heroBox.querySelector('.value')!;
    this.rivalScore = this.rivalBox.querySelector('.value')!;
    this.rallyEl = q('.rally');
    this.targetEl = q('.target');
    this.banner = q('.banner');
    this.edgeGlowEl = q('.edge-glow');
    this.gamePointEl = q('.gp-badge');
    this.calloutEl = q('.callout');
    this.hint = q('.hint');
    this.debugEl = q('.debug');
    this.pauseButton = q('.pause-btn');
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  setScores(hero: number, rival: number, heroServing: boolean | null): void {
    this.setValue(this.heroScore, hero);
    this.setValue(this.rivalScore, rival);
    this.heroBox.classList.toggle('serving', heroServing === true);
    this.rivalBox.classList.toggle('serving', heroServing === false);
  }

  setTarget(points: number): void {
    this.targetEl.textContent = `TO ${points}`;
  }

  setRally(n: number): void {
    this.rallyEl.textContent = String(n);
    if (n > 0) bump(this.rallyEl);
  }

  /** Rally counter glow for long rallies: 0 off, 1..3 hotter. */
  setRallyHeat(level: number): void {
    this.rallyEl.classList.toggle('hot', level > 0);
    this.rallyEl.dataset.heat = String(level);
  }

  /** Short mid-rally shout under the scoreboard, clear of the court ("HOT RALLY!"); `level` 1..3 warms the colour. */
  callout(text: string, level: number): void {
    this.calloutEl.textContent = text;
    this.calloutEl.className = `callout l${level}`;
    void this.calloutEl.offsetWidth;
    this.calloutEl.classList.add('show');
  }

  /**
   * "+1" that pops at screen point (`x`, `y`) and flies into `holder`'s score box; `onLand` runs
   * on arrival (GameManager updates the score there, so the bump lands with it).
   */
  flyPoint(holder: 'hero' | 'rival', x: number, y: number, onLand: () => void): void {
    const target = (holder === 'hero' ? this.heroScore : this.rivalScore).getBoundingClientRect();
    const tx = target.left + target.width / 2;
    const ty = target.top + target.height / 2;
    const el = document.createElement('div');
    el.className = `plus-one ${holder}`;
    el.textContent = '+1';
    this.root.appendChild(el);
    const at = (px: number, py: number, s: number) => `translate(${px}px, ${py}px) translate(-50%, -50%) scale(${s})`;
    // Pop up in place, then arc over to the scoreboard.
    const mx = (x + tx) / 2;
    const my = Math.min(y, ty) - 60;
    const anim = el.animate(
      [
        { transform: at(x, y, 0.4), opacity: 0 },
        { transform: at(x, y - 34, 1.35), opacity: 1, offset: 0.22 },
        { transform: at(x, y - 40, 1.2), opacity: 1, offset: 0.36, easing: 'ease-in' },
        { transform: at(mx, my, 1), opacity: 1, offset: 0.7 },
        { transform: at(tx, ty, 0.6), opacity: 0.6 },
      ],
      { duration: 820, easing: 'linear', fill: 'forwards' },
    );
    anim.onfinish = () => {
      el.remove();
      onLand();
    };
  }

  /** Updates a score readout, popping it when the value goes up. */
  private setValue(el: HTMLElement, v: number): void {
    const prev = Number(el.textContent);
    el.textContent = String(v);
    if (v > prev) bump(el);
  }

  /**
   * Big centered callout. `tone` adds a non-color cue via the text itself; color is secondary.
   * `slam` uses a harder, skewed entrance (for WINNER!).
   */
  showBanner(big: string, small = '', tone: 'good' | 'bad' | 'neutral' = 'neutral', seconds = 1.6, slam = false): void {
    this.banner.querySelector('.big')!.textContent = big;
    this.banner.querySelector('.small')!.textContent = small;
    this.banner.className = `banner ${tone}${slam ? ' slam' : ''}`;
    void this.banner.offsetWidth; // restart animation
    this.banner.classList.add('show');
    this.bannerTimer = seconds;
  }

  /** Hides the banner, playing the exit animation if it is currently showing. */
  hideBanner(): void {
    this.bannerTimer = 0;
    if (!this.banner.classList.contains('show')) return;
    this.banner.classList.remove('show');
    this.banner.classList.add('hide');
  }

  /** Brief full-screen edge tint: green for a point won, red for a point lost. */
  edgeGlow(tone: 'good' | 'bad'): void {
    this.edgeGlowEl.className = `edge-glow ${tone}`;
    void this.edgeGlowEl.offsetWidth;
    this.edgeGlowEl.classList.add('flash');
  }

  /** Pulsing GAME POINT badge in the holder's colour; null hides it. */
  setGamePoint(holder: 'hero' | 'rival' | null): void {
    this.gamePointEl.classList.toggle('hidden', holder === null);
    if (holder === null) return;
    this.gamePointEl.textContent = `GAME POINT · ${(holder === 'hero' ? this.heroName : this.rivalName).toUpperCase()}`;
    this.gamePointEl.className = `gp-badge ${holder}`;
  }

  setHint(text: string): void {
    this.hint.textContent = text;
    this.hint.classList.toggle('hidden', !text);
  }

  setDebug(text: string | null): void {
    this.debugEl.classList.toggle('hidden', text === null);
    if (text !== null) this.debugEl.textContent = text;
  }

  update(dt: number): void {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.hideBanner();
    }
  }
}

/** Restarts the CSS `.bump` pop animation on `el`. */
function bump(el: HTMLElement): void {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}
