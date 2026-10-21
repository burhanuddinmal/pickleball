import type { PlatformAdapter, PlatformCapabilities, SaveData } from '../types';

const STORAGE_KEY = 'pickle-smash.save';

/** CrazyGames HTML5 SDK v3 (https://docs.crazygames.com/sdk/). */
interface CrazyGamesSDK {
  init: () => Promise<void>;
  /** 'local' | 'crazygames' | 'disabled' (disabled = not on CrazyGames; ads and data are unavailable) */
  environment?: string;
  game: {
    gameplayStart: () => void;
    gameplayStop: () => void;
    loadingStart?: () => void;
    loadingStop?: () => void;
    happytime?: () => void;
  };
  ad: {
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

/**
 * CrazyGames rules followed here: gameplayStart/Stop around actual play, midgame ads only at
 * breaks (the game calls them from the match-over screen; the SDK also rate-limits them), rewarded
 * only on an explicit player choice, and no in-game banners.
 */
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
  private ready = false;
  private inGameplay = false;

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
    if (!this.ready) return undefined;
    return typeof window !== 'undefined' ? window.CrazyGames?.SDK : undefined;
  }

  async init(): Promise<void> {
    const sdk = typeof window !== 'undefined' ? window.CrazyGames?.SDK : undefined;
    if (!sdk?.init) {
      console.warn('[CrazyGames] SDK v3 script not loaded; ads and cloud save disabled');
      return;
    }
    try {
      await sdk.init();
      this.ready = true;
      sdk.game.loadingStart?.();
      console.log('[CrazyGames] SDK initialized, environment:', sdk.environment);
    } catch (err) {
      console.warn('[CrazyGames] SDK initialization failed:', err);
    }
  }

  onGameReady(): void {
    try {
      this.sdk?.game.loadingStop?.();
    } catch (err) {
      console.warn('[CrazyGames] loadingStop error:', err);
    }
  }

  private requestAd(type: 'midgame' | 'rewarded'): Promise<boolean> {
    const sdk = this.sdk;
    if (!sdk?.ad?.requestAd) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let started = false;
      let completed = false;
      const finish = (watched: boolean) => {
        if (completed) return;
        completed = true;
        if (started) this.notifyAdState(false);
        resolve(watched);
      };
      try {
        sdk.ad.requestAd(type, {
          adStarted: () => {
            started = true;
            this.notifyAdState(true);
          },
          adFinished: () => finish(true),
          adError: (err) => {
            // e.g. 'unfilled' or an ad blocker: just carry on.
            console.warn(`[CrazyGames] ${type} ad error:`, err);
            finish(false);
          },
        });
      } catch (err) {
        console.error(`[CrazyGames] Failed to request ${type} ad:`, err);
        finish(false);
      }
    });
  }

  async showInterstitialAd(): Promise<void> {
    await this.requestAd('midgame');
  }

  async showRewardedAd(): Promise<boolean> {
    return this.requestAd('rewarded');
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
    // Called on every serve; the SDK wants one start per stretch of play.
    if (this.inGameplay) return;
    this.inGameplay = true;
    try {
      this.sdk?.game.gameplayStart();
    } catch (err) {
      console.warn('[CrazyGames] Error on gameplayStart:', err);
    }
  }

  onGameplayStop(): void {
    if (!this.inGameplay) return;
    this.inGameplay = false;
    try {
      this.sdk?.game.gameplayStop();
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
