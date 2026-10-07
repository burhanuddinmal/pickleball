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
  private hint: HTMLDivElement;
  private debugEl: HTMLDivElement;
  readonly pauseButton: HTMLButtonElement;

  constructor(parent: HTMLElement, heroName: string, rivalName: string) {
    this.root = document.createElement('div');
    this.root.className = 'hud hidden';
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="hud-score hero"><span class="label"></span><span class="value">0</span><span class="serve-dot">● SERVING</span></div>
        <div class="hud-mid"><span class="target"></span><span>RALLY</span><span class="rally">0</span></div>
        <div class="hud-score rival"><span class="label"></span><span class="value">0</span><span class="serve-dot">● SERVING</span></div>
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
    this.hint = q('.hint');
    this.debugEl = q('.debug');
    this.pauseButton = q('.pause-btn');
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  setScores(hero: number, rival: number, heroServing: boolean | null): void {
    this.heroScore.textContent = String(hero);
    this.rivalScore.textContent = String(rival);
    this.heroBox.classList.toggle('serving', heroServing === true);
    this.rivalBox.classList.toggle('serving', heroServing === false);
  }

  setTarget(points: number): void {
    this.targetEl.textContent = `TO ${points}`;
  }

  setRally(n: number): void {
    this.rallyEl.textContent = String(n);
  }

  /** Big centered callout. `tone` adds a non-color cue via the text itself; color is secondary. */
  showBanner(big: string, small = '', tone: 'good' | 'bad' | 'neutral' = 'neutral', seconds = 1.6): void {
    this.banner.querySelector('.big')!.textContent = big;
    this.banner.querySelector('.small')!.textContent = small;
    this.banner.className = `banner ${tone}`;
    void this.banner.offsetWidth; // restart animation
    this.banner.classList.add('show');
    this.banner.style.opacity = '1';
    this.bannerTimer = seconds;
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
      if (this.bannerTimer <= 0) this.banner.style.opacity = '0';
    }
  }
}
