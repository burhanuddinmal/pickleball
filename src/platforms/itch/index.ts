import type { PlatformAdapter, PlatformCapabilities, SaveData } from '../types';

const STORAGE_KEY = 'pickle-smash.save';

export class ItchAdapter implements PlatformAdapter {
  readonly id = 'itch';
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
  private pauseListeners: Array<() => void> = [];
  private resumeListeners: Array<() => void> = [];

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
    console.log('[itch.io] Initialized (standalone web/iframe mode)');
  }

  async showInterstitialAd(): Promise<void> {
    // No ads on itch.io
  }

  async showRewardedAd(): Promise<boolean> {
    // No ads on itch.io (rewardedAds is false, so nothing offers one)
    return false;
  }

  async saveProgress(data: Partial<SaveData>): Promise<void> {
    try {
      const existing = (await this.loadProgress()) || { target: 11 };
      const merged: SaveData = { ...existing, ...data };
      this.memStorage = merged;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch {
      // Sandboxed iframe storage fallback
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
      // Sandboxed iframe storage fallback
    }
    return this.memStorage;
  }

  async submitScore(): Promise<void> {
    // No-op
  }

  onGameplayStart(): void {
    // No-op
  }

  onGameplayStop(): void {
    // No-op
  }

  onPause(cb: () => void): void {
    this.pauseListeners.push(cb);
  }

  onResume(cb: () => void): void {
    this.resumeListeners.push(cb);
  }
}
