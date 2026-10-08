import type { PlatformAdapter, PlatformCapabilities, SaveData } from '../types';

const STORAGE_KEY = 'pickle-smash.save';

export class DummyAdapter implements PlatformAdapter {
  readonly id = 'dummy';
  readonly capabilities: PlatformCapabilities = {
    ads: false,
    rewardedAds: false,
    banner: false,
    cloudSave: false,
    leaderboards: false,
    achievements: false,
    haptics: false,
    backButton: false,
    iap: false,
  };

  private memStorage: SaveData | null = null;
  private adListeners: Array<(active: boolean) => void> = [];
  private pauseListeners: Array<() => void> = [];
  private resumeListeners: Array<() => void> = [];
  private backListeners: Array<() => void> = [];

  constructor() {
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

  async showInterstitialAd(): Promise<void> {
    console.log('[DummyPlatform] showInterstitialAd() requested');
    this.notifyAdState(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    this.notifyAdState(false);
    console.log('[DummyPlatform] showInterstitialAd() finished');
  }

  async showRewardedAd(): Promise<boolean> {
    console.log('[DummyPlatform] showRewardedAd() requested');
    this.notifyAdState(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    this.notifyAdState(false);
    console.log('[DummyPlatform] showRewardedAd() completed (reward granted)');
    return true;
  }

  async showBanner(): Promise<void> {
    console.log('[DummyPlatform] showBanner()');
  }

  async hideBanner(): Promise<void> {
    console.log('[DummyPlatform] hideBanner()');
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
