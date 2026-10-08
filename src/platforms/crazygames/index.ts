import type { PlatformAdapter, PlatformCapabilities, SaveData } from '../types';

const STORAGE_KEY = 'pickle-smash.save';

interface CrazyGamesSDK {
  init?: () => Promise<void>;
  getEnvironment?: (cb: (err: unknown, env: string) => void) => void;
  game?: {
    gameplayStart: () => void;
    gameplayStop: () => void;
    happytime?: () => void;
  };
  ad?: {
    requestAd: (
      type: 'midgame' | 'rewarded',
      callbacks?: {
        adStarted?: () => void;
        adFinished?: () => void;
        adError?: (error: unknown) => void;
      }
    ) => void;
  };
  data?: {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
  };
}

declare global {
  interface Window {
    CrazyGames?: {
      SDK?: CrazyGamesSDK;
    };
  }
}

export class CrazyGamesAdapter implements PlatformAdapter {
  readonly id = 'crazygames';
  readonly capabilities: PlatformCapabilities = {
    ads: true,
    rewardedAds: true,
    banner: false,
    cloudSave: true,
    leaderboards: false,
    achievements: false,
    haptics: false,
    backButton: false,
    iap: false,
  };

  private adListeners: Array<(active: boolean) => void> = [];
  private pauseListeners: Array<() => void> = [];
  private resumeListeners: Array<() => void> = [];
  private lastAdTime = 0;
  private readonly adCooldownMs = 60000; // 60s recommended between midgame ads

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

  private get sdk(): CrazyGamesSDK | undefined {
    return typeof window !== 'undefined' ? window.CrazyGames?.SDK : undefined;
  }

  async init(): Promise<void> {
    const sdk = this.sdk;
    if (sdk?.init) {
      try {
        await sdk.init();
        console.log('[CrazyGames] SDK initialized');
      } catch (err) {
        console.warn('[CrazyGames] SDK initialization warning:', err);
      }
    } else {
      console.log('[CrazyGames] SDK ready or running without explicit init()');
    }
  }

  async showInterstitialAd(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAdTime < this.adCooldownMs) {
      console.log('[CrazyGames] Skipping interstitial ad (cooldown active)');
      return;
    }
    const sdk = this.sdk;
    if (!sdk?.ad?.requestAd) {
      console.log('[CrazyGames] SDK ad module unavailable, skipping interstitial');
      return;
    }

    return new Promise<void>((resolve) => {
      this.lastAdTime = Date.now();
      let completed = false;

      const finish = () => {
        if (!completed) {
          completed = true;
          this.notifyAdState(false);
          resolve();
        }
      };

      try {
        sdk.ad!.requestAd('midgame', {
          adStarted: () => {
            this.notifyAdState(true);
          },
          adFinished: () => {
            finish();
          },
          adError: (err) => {
            console.warn('[CrazyGames] Interstitial ad error:', err);
            finish();
          },
        });
      } catch (err) {
        console.error('[CrazyGames] Failed to request interstitial ad:', err);
        finish();
      }
    });
  }

  async showRewardedAd(): Promise<boolean> {
    const sdk = this.sdk;
    if (!sdk?.ad?.requestAd) {
      console.log('[CrazyGames] SDK ad module unavailable, simulating rewarded ad');
      return true;
    }

    return new Promise<boolean>((resolve) => {
      let rewarded = false;
      let completed = false;

      const finish = () => {
        if (!completed) {
          completed = true;
          this.notifyAdState(false);
          resolve(rewarded);
        }
      };

      try {
        sdk.ad!.requestAd('rewarded', {
          adStarted: () => {
            this.notifyAdState(true);
          },
          adFinished: () => {
            rewarded = true;
            finish();
          },
          adError: (err) => {
            console.warn('[CrazyGames] Rewarded ad error:', err);
            finish();
          },
        });
      } catch (err) {
        console.error('[CrazyGames] Failed to request rewarded ad:', err);
        finish();
      }
    });
  }

  async saveProgress(data: Partial<SaveData>): Promise<void> {
    try {
      const existing = (await this.loadProgress()) || { target: 11 };
      const merged: SaveData = { ...existing, ...data };
      const serialized = JSON.stringify(merged);

      const sdk = this.sdk;
      if (sdk?.data?.setItem) {
        sdk.data.setItem(STORAGE_KEY, serialized);
      } else {
        localStorage.setItem(STORAGE_KEY, serialized);
      }
    } catch (err) {
      console.warn('[CrazyGames] Failed to save progress:', err);
    }
  }

  async loadProgress(): Promise<SaveData | null> {
    try {
      const sdk = this.sdk;
      let raw: string | null = null;
      if (sdk?.data?.getItem) {
        raw = sdk.data.getItem(STORAGE_KEY);
      } else {
        raw = localStorage.getItem(STORAGE_KEY);
      }

      if (raw) return JSON.parse(raw) as SaveData;
    } catch (err) {
      console.warn('[CrazyGames] Failed to load progress:', err);
    }
    return null;
  }

  async submitScore(score: number): Promise<void> {
    console.log('[CrazyGames] submitScore:', score);
  }

  onGameplayStart(): void {
    const sdk = this.sdk;
    try {
      sdk?.game?.gameplayStart();
    } catch (err) {
      console.warn('[CrazyGames] Error on gameplayStart:', err);
    }
  }

  onGameplayStop(): void {
    const sdk = this.sdk;
    try {
      sdk?.game?.gameplayStop();
    } catch (err) {
      console.warn('[CrazyGames] Error on gameplayStop:', err);
    }
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
        console.error('[CrazyGames] Error in adState listener:', err);
      }
    }
  }
}
