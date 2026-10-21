import type { PlatformAdapter } from '../platforms/types';

/** When an interstitial may play at a match-over break. */
export interface InterstitialPolicy {
  /** Finished matches needed since the last ad (or session start). */
  minMatches: number;
  /** Real time (ms) needed since the last ad (or session start). */
  minIntervalMs: number;
}

export const DEFAULT_INTERSTITIAL_POLICY: InterstitialPolicy = { minMatches: 2, minIntervalMs: 90_000 };

/** Ad pacing state: counted from session start until the first ad, then from the last ad. */
export interface AdPacing {
  matchesSinceAd: number;
  lastAdAt: number;
}

/**
 * Both limits must be met. Counting from session start means the very first match never gets an
 * interstitial (it needs `minMatches` ≥ 2 finished matches).
 */
export function interstitialDue(p: AdPacing, now: number, policy: InterstitialPolicy): boolean {
  return p.matchesSinceAd >= policy.minMatches && now - p.lastAdAt >= policy.minIntervalMs;
}

type AdPlatform = Pick<
  PlatformAdapter,
  'capabilities' | 'showInterstitialAd' | 'showRewardedAd' | 'showBanner' | 'hideBanner' | 'onGameplayStop' | 'onAdStateChange' | 'onBannerSizeChange'
>;

export interface AdHooks {
  /** An ad took over the screen: pause the loop and mute. */
  onAdStart(): void;
  /** The ad is gone (shown, skipped or failed): restore audio and resume. */
  onAdEnd(): void;
  /** Banner height (CSS px, 0 when hidden). */
  onBannerSize?(heightPx: number): void;
}

/**
 * Every ad goes through here: interstitial pacing, the pause/mute bracket around fullscreen ads
 * (restored even when the ad fails), and banner visibility. Ads only run at natural breaks; the
 * game decides where those are.
 */
export class AdManager {
  private pacing: AdPacing;
  private running = false;
  private external = false;
  private active = false;
  private bannerWanted = false;
  private bannerShown = false;

  constructor(
    private platform: AdPlatform,
    private hooks: AdHooks,
    private policy: InterstitialPolicy = DEFAULT_INTERSTITIAL_POLICY,
    private now: () => number = () => Date.now(),
  ) {
    this.pacing = { matchesSinceAd: 0, lastAdAt: now() };
    // Adapter-reported ad state covers ads the portal starts itself (e.g. a preroll).
    platform.onAdStateChange?.((on) => {
      this.external = on;
      this.sync();
    });
    platform.onBannerSizeChange?.((h) => hooks.onBannerSize?.(h));
  }

  /** True while a fullscreen ad owns the screen. */
  get isAdActive(): boolean {
    return this.active;
  }

  /** An ad request is in flight (ignore further taps until it settles). */
  get busy(): boolean {
    return this.running;
  }

  get rewardedAvailable(): boolean {
    return this.platform.capabilities.rewardedAds;
  }

  /** Call once per match that really ended (not one rescued by a second chance). */
  matchFinished(): void {
    this.pacing.matchesSinceAd++;
  }

  /** A match-over break: plays an interstitial if one is due. Resolves when it's safe to continue. */
  async interstitialAtBreak(): Promise<void> {
    if (!this.platform.capabilities.ads || this.running) return;
    if (!interstitialDue(this.pacing, this.now(), this.policy)) return;
    await this.run(() => this.platform.showInterstitialAd());
    this.resetPacing();
  }

  /** Opt-in rewarded ad. Resolves true only when the reward was earned. */
  async rewarded(): Promise<boolean> {
    if (!this.platform.capabilities.rewardedAds || this.running) return false;
    const earned = await this.run(() => this.platform.showRewardedAd()).catch(() => false);
    // A watched ad counts as this break's ad: no interstitial right after it.
    this.resetPacing();
    return earned === true;
  }

  /** Banner on menus / pause / match-over; never while playing or under a fullscreen ad. */
  setBanner(wanted: boolean): void {
    this.bannerWanted = wanted;
    this.syncBanner();
  }

  private resetPacing(): void {
    this.pacing = { matchesSinceAd: 0, lastAdAt: this.now() };
  }

  private async run<T>(show: () => Promise<T>): Promise<T> {
    this.running = true;
    this.platform.onGameplayStop();
    this.sync();
    try {
      return await show();
    } finally {
      this.running = false;
      this.sync();
    }
  }

  private sync(): void {
    const on = this.running || this.external;
    if (on === this.active) return;
    this.active = on;
    try {
      if (on) this.hooks.onAdStart();
      else this.hooks.onAdEnd();
    } catch (err) {
      console.error('[Ads] ad state hook failed:', err);
    }
    this.syncBanner();
  }

  private syncBanner(): void {
    if (!this.platform.capabilities.banner) return;
    const show = this.bannerWanted && !this.active;
    if (show === this.bannerShown) return;
    this.bannerShown = show;
    const op = show ? this.platform.showBanner : this.platform.hideBanner;
    void op?.call(this.platform).catch((err: unknown) => console.warn('[Ads] banner error:', err));
  }
}
