import type { PlatformAdapter, PlatformCapabilities, SaveData } from '../types';

const STORAGE_KEY = 'pickle-smash.save';
const FAKE_BANNER_H = 50;

/**
 * Local ad testing (`npm run dev`). Fake ads are on in dev builds and off in other dummy builds;
 * URL switches:
 *   ?ads=0 / ?ads=1                      turn fake ads off / on
 *   ?adfail=interstitial|rewarded|all   that ad type is "unavailable" (resolves at once, no reward)
 *   ?privacy=1                           show the "Privacy options" settings button
 *   ?adcooldown=0                        (GameManager) interstitial at every match-over break
 */
export interface DummyAdOptions {
  ads: boolean;
  fail: 'none' | 'interstitial' | 'rewarded' | 'all';
  privacy: boolean;
  /** Fake ad UI in the page; without it ads resolve after a short delay (tests, no DOM). */
  ui: boolean;
}

export function dummyAdOptions(search: string, dev: boolean, hasDom: boolean): DummyAdOptions {
  const q = new URLSearchParams(search);
  const fail = q.get('adfail');
  return {
    ads: q.has('ads') ? q.get('ads') !== '0' : dev,
    fail: fail === 'interstitial' || fail === 'rewarded' || fail === 'all' ? fail : 'none',
    privacy: q.get('privacy') === '1',
    ui: hasDom,
  };
}

export class DummyAdapter implements PlatformAdapter {
  readonly id = 'dummy';
  readonly capabilities: PlatformCapabilities;
  private opts: DummyAdOptions;
  private bannerEl: HTMLElement | null = null;
  private bannerListeners: Array<(h: number) => void> = [];

  private memStorage: SaveData | null = null;
  private adListeners: Array<(active: boolean) => void> = [];
  private pauseListeners: Array<() => void> = [];
  private resumeListeners: Array<() => void> = [];
  private backListeners: Array<() => void> = [];

  constructor(opts?: Partial<DummyAdOptions>) {
    const hasDom = typeof document !== 'undefined';
    const search = typeof location !== 'undefined' ? location.search : '';
    this.opts = { ...dummyAdOptions(search, !!import.meta.env?.DEV, hasDom), ...opts };
    const ads = this.opts.ads;
    this.capabilities = {
      ads,
      rewardedAds: ads,
      banner: ads,
      cloudSave: false,
      leaderboards: false,
      achievements: false,
      haptics: false,
      backButton: false,
      iap: false,
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          for (const cb of this.pauseListeners) cb();
        } else {
          for (const cb of this.resumeListeners) cb();
        }
      });
    }
  }

  async init(): Promise<void> {
    console.log('[DummyPlatform] Initialized (local development mode)');
  }

  private fails(kind: 'interstitial' | 'rewarded'): boolean {
    return this.opts.fail === 'all' || this.opts.fail === kind;
  }

  async showInterstitialAd(): Promise<void> {
    console.log('[DummyPlatform] showInterstitialAd() requested');
    if (!this.opts.ads || this.fails('interstitial')) {
      console.log('[DummyPlatform] interstitial unavailable');
      return;
    }
    this.notifyAdState(true);
    try {
      await this.fakeAd('interstitial');
    } finally {
      this.notifyAdState(false);
    }
    console.log('[DummyPlatform] showInterstitialAd() finished');
  }

  async showRewardedAd(): Promise<boolean> {
    console.log('[DummyPlatform] showRewardedAd() requested');
    if (!this.opts.ads || this.fails('rewarded')) {
      console.log('[DummyPlatform] rewarded unavailable (no reward)');
      return false;
    }
    this.notifyAdState(true);
    try {
      const earned = await this.fakeAd('rewarded');
      console.log(`[DummyPlatform] showRewardedAd() ${earned ? 'completed (reward granted)' : 'skipped (no reward)'}`);
      return earned;
    } finally {
      this.notifyAdState(false);
    }
  }

  /** Fullscreen stand-in. Interstitial: CLOSE. Rewarded: CLAIM REWARD (after 2 s) or SKIP. */
  private fakeAd(kind: 'interstitial' | 'rewarded'): Promise<boolean> {
    if (!this.opts.ui) return new Promise((r) => setTimeout(() => r(true), 50));
    return new Promise<boolean>((resolve) => {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;' +
        'background:repeating-linear-gradient(45deg,#2b2b2b 0 24px,#333 24px 48px);color:#fff;font:700 18px system-ui;pointer-events:auto';
      const btn = (label: string) =>
        `<button style="font:700 16px system-ui;padding:12px 22px;border-radius:10px;border:0;cursor:pointer">${label}</button>`;
      el.innerHTML =
        kind === 'interstitial'
          ? `<div style="font-size:28px">TEST INTERSTITIAL</div><div>Game is paused and muted</div>${btn('CLOSE')}`
          : `<div style="font-size:28px">TEST REWARDED AD</div><div class="count">Reward in 2…</div><div style="display:flex;gap:12px">${btn('CLAIM REWARD')}${btn('SKIP (no reward)')}</div>`;
      document.body.appendChild(el);
      const [first, second] = el.querySelectorAll('button');
      const done = (earned: boolean) => {
        el.remove();
        resolve(earned);
      };
      if (kind === 'interstitial') {
        first.addEventListener('click', () => done(true));
        return;
      }
      first.disabled = true;
      setTimeout(() => {
        first.disabled = false;
        el.querySelector('.count')!.textContent = 'Reward ready';
      }, 2000);
      first.addEventListener('click', () => done(true));
      second.addEventListener('click', () => done(false));
    });
  }

  async showBanner(): Promise<void> {
    console.log('[DummyPlatform] showBanner()');
    if (!this.opts.ui || this.bannerEl) return;
    const el = document.createElement('div');
    el.textContent = 'TEST BANNER AD (menus only)';
    el.style.cssText =
      `position:fixed;left:0;right:0;bottom:0;height:${FAKE_BANNER_H}px;z-index:9000;display:flex;align-items:center;justify-content:center;` +
      'background:#e8e8e8;color:#333;font:700 13px system-ui;border-top:2px dashed #999;pointer-events:none';
    document.body.appendChild(el);
    this.bannerEl = el;
    for (const cb of this.bannerListeners) cb(FAKE_BANNER_H);
  }

  async hideBanner(): Promise<void> {
    console.log('[DummyPlatform] hideBanner()');
    if (!this.bannerEl) return;
    this.bannerEl.remove();
    this.bannerEl = null;
    for (const cb of this.bannerListeners) cb(0);
  }

  onBannerSizeChange(cb: (heightPx: number) => void): void {
    this.bannerListeners.push(cb);
    cb(this.bannerEl ? FAKE_BANNER_H : 0); // the banner may be up before this listener existed
  }

  privacyOptionsRequired(): boolean {
    return this.opts.privacy;
  }

  async showPrivacyOptions(): Promise<void> {
    console.log('[DummyPlatform] showPrivacyOptions() (UMP privacy form would open here)');
  }

  async saveProgress(data: Partial<SaveData>): Promise<void> {
    console.log('[DummyPlatform] saveProgress:', data);
    try {
      const existing = (await this.loadProgress()) || { target: 11 };
      const merged: SaveData = { ...existing, ...data };
      this.memStorage = merged;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch {
      // In-memory fallback if localStorage fails (e.g. sandboxed iframe)
    }
  }

  async loadProgress(): Promise<SaveData | null> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SaveData;
        this.memStorage = parsed;
        return parsed;
      }
    } catch {
      // Return memory fallback
    }
    return this.memStorage;
  }

  async submitScore(score: number, leaderboardName = 'default'): Promise<void> {
    console.log(`[DummyPlatform] submitScore to "${leaderboardName}": ${score}`);
  }

  async unlockAchievement(id: string): Promise<void> {
    console.log(`[DummyPlatform] unlockAchievement: ${id}`);
  }

  onGameplayStart(): void {
    console.log('[DummyPlatform] onGameplayStart()');
  }

  onGameplayStop(): void {
    console.log('[DummyPlatform] onGameplayStop()');
  }

  onPause(cb: () => void): void {
    this.pauseListeners.push(cb);
  }

  onResume(cb: () => void): void {
    this.resumeListeners.push(cb);
  }

  onBackButton(cb: () => void): void {
    this.backListeners.push(cb);
  }

  vibrate(pattern: number | number[] = 25): void {
    console.log('[DummyPlatform] vibrate:', pattern);
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch {
        // Ignored
      }
    }
  }

  onAdStateChange(callback: (isAdActive: boolean) => void): void {
    this.adListeners.push(callback);
  }

  private notifyAdState(active: boolean): void {
    for (const listener of this.adListeners) {
      try {
        listener(active);
      } catch (err) {
        console.error('[DummyPlatform] Error in adState listener:', err);
      }
    }
  }
}
