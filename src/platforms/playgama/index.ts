import type { PlatformAdapter, PlatformCapabilities, SaveData } from '../types';

const STORAGE_KEY = 'pickle-smash.save';

interface PlayGamaBridge {
  initialize: () => Promise<void>;
  advertisement: {
    isInterstitialSupported?: boolean;
    showInterstitial: () => Promise<void>;
    showRewarded: () => Promise<void>;
    showBanner?: () => Promise<void>;
    hideBanner?: () => Promise<void>;
    on?: (event: string, callback: (...args: unknown[]) => void) => void;
  };
  storage: {
    get: (key: string | string[]) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
  };
  leaderboard?: {
    setScore: (data: { score: number; leaderboardName?: string }) => Promise<void>;
  };
}

declare global {
  interface Window {
    bridge?: PlayGamaBridge;
  }
}

export class PlayGamaAdapter implements PlatformAdapter {
  readonly id = 'playgama';
  readonly capabilities: PlatformCapabilities = {
    ads: true,
    rewardedAds: true,
    banner: true,
    cloudSave: true,
    leaderboards: true,
    achievements: false,
    haptics: false,
    backButton: false,
    iap: false,
  };

  private adListeners: Array<(active: boolean) => void> = [];
  private pauseListeners: Array<() => void> = [];
  private resumeListeners: Array<() => void> = [];
  private lastAdTime = 0;
  private readonly adCooldownMs = 60000;

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

  private get bridge(): PlayGamaBridge | undefined {
    return typeof window !== 'undefined' ? window.bridge : undefined;
  }

  async init(): Promise<void> {
    const bridge = this.bridge;
    if (bridge?.initialize) {
      try {
        await bridge.initialize();
        console.log('[PlayGama] Bridge SDK initialized');
      } catch (err) {
        console.warn('[PlayGama] Bridge initialization error:', err);
      }
    } else {
      console.log('[PlayGama] Bridge SDK object not detected at init time');
    }
  }

  async showInterstitialAd(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAdTime < this.adCooldownMs) {
      console.log('[PlayGama] Skipping interstitial (cooldown active)');
      return;
    }

    const bridge = this.bridge;
    if (!bridge?.advertisement?.showInterstitial) {
      console.log('[PlayGama] advertisement.showInterstitial not available');
      return;
    }

    this.lastAdTime = Date.now();
    this.notifyAdState(true);
    try {
      await bridge.advertisement.showInterstitial();
    } catch (err) {
      console.warn('[PlayGama] Interstitial ad error:', err);
    } finally {
      this.notifyAdState(false);
    }
  }

  async showRewardedAd(): Promise<boolean> {
    const bridge = this.bridge;
    if (!bridge?.advertisement?.showRewarded) {
      console.log('[PlayGama] advertisement.showRewarded not available, granting reward');
      return true;
    }

    this.notifyAdState(true);
    try {
      await bridge.advertisement.showRewarded();
      return true;
    } catch (err) {
      console.warn('[PlayGama] Rewarded ad error or dismissed:', err);
      return false;
    } finally {
      this.notifyAdState(false);
    }
  }

  async showBanner(): Promise<void> {
    const bridge = this.bridge;
    if (bridge?.advertisement?.showBanner) {
      try {
        await bridge.advertisement.showBanner();
      } catch (err) {
        console.warn('[PlayGama] Show banner error:', err);
      }
    }
  }

  async hideBanner(): Promise<void> {
    const bridge = this.bridge;
    if (bridge?.advertisement?.hideBanner) {
      try {
        await bridge.advertisement.hideBanner();
      } catch (err) {
        console.warn('[PlayGama] Hide banner error:', err);
      }
    }
  }

  async saveProgress(data: Partial<SaveData>): Promise<void> {
    try {
      const existing = (await this.loadProgress()) || { target: 11 };
      const merged: SaveData = { ...existing, ...data };
      const serialized = JSON.stringify(merged);

      const bridge = this.bridge;
      if (bridge?.storage?.set) {
        await bridge.storage.set(STORAGE_KEY, serialized);
      } else {
        localStorage.setItem(STORAGE_KEY, serialized);
      }
    } catch (err) {
      console.warn('[PlayGama] Error saving progress:', err);
    }
  }

  async loadProgress(): Promise<SaveData | null> {
    try {
      const bridge = this.bridge;
      let raw: unknown = null;
      if (bridge?.storage?.get) {
        raw = await bridge.storage.get(STORAGE_KEY);
      } else {
        raw = localStorage.getItem(STORAGE_KEY);
      }

      if (typeof raw === 'string') {
        return JSON.parse(raw) as SaveData;
      } else if (raw && typeof raw === 'object') {
        // bridge.storage might return an object map
        const map = raw as Record<string, unknown>;
        const item = map[STORAGE_KEY] ?? raw;
        if (typeof item === 'string') return JSON.parse(item) as SaveData;
        return item as SaveData;
      }
    } catch (err) {
      console.warn('[PlayGama] Error loading progress:', err);
    }
    return null;
  }

  async submitScore(score: number, leaderboardName = 'highscores'): Promise<void> {
    const bridge = this.bridge;
    if (bridge?.leaderboard?.setScore) {
      try {
        await bridge.leaderboard.setScore({ score, leaderboardName });
        console.log(`[PlayGama] Score ${score} submitted to ${leaderboardName}`);
      } catch (err) {
        console.warn('[PlayGama] Error submitting score:', err);
      }
    }
  }

  onGameplayStart(): void {
    console.log('[PlayGama] onGameplayStart()');
  }

  onGameplayStop(): void {
    console.log('[PlayGama] onGameplayStop()');
  }

  onPause(cb: () => void): void {
    this.pauseListeners.push(cb);
  }

  onResume(cb: () => void): void {
    this.resumeListeners.push(cb);
  }

  onAdStateChange(callback: (isAdActive: boolean) => void): void {
    this.adListeners.push(callback);
  }

  private notifyAdState(active: boolean): void {
    for (const listener of this.adListeners) {
      try {
        listener(active);
      } catch (err) {
        console.error('[PlayGama] Error in adState listener:', err);
      }
    }
  }
}
