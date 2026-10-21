import type { PlatformAdapter, PlatformCapabilities, SaveData } from '../types';

const STORAGE_KEY = 'pickle-smash.save';
/** Give up waiting if the bridge never reports an ad opening (e.g. its own interstitial delay). */
const AD_START_TIMEOUT_MS = 2500;
/** Hard cap so a lost 'closed' event can't leave the game paused forever. */
const AD_MAX_MS = 120_000;

/** Playgama Bridge v2 (https://wiki.playgama.com/playgama/sdk/engines/core/advertisement). */
interface PlayGamaBridge {
  initialize: () => Promise<void>;
  EVENT_NAME?: Record<string, string>;
  advertisement: {
    isInterstitialSupported?: boolean;
    isRewardedSupported?: boolean;
    /** Results arrive as state events, not through a returned promise. */
    showInterstitial: (placement?: string) => unknown;
    showRewarded: (placement?: string) => unknown;
    on?: (event: string, callback: (state: string) => void) => void;
  };
  platform?: {
    sendMessage?: (message: string) => unknown;
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
    // Banners are off: many Playgama hosts show their own, and an in-game one would cover the UI.
    banner: false,
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
  /** Whoever is waiting on the ad in flight receives each state event. */
  private adWaiter: ((kind: 'interstitial' | 'rewarded', state: string) => void) | null = null;

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
        const ev = bridge.EVENT_NAME ?? {};
        bridge.advertisement.on?.(ev.INTERSTITIAL_STATE_CHANGED ?? 'interstitial_state_changed', (st) =>
          this.adWaiter?.('interstitial', st),
        );
        bridge.advertisement.on?.(ev.REWARDED_STATE_CHANGED ?? 'rewarded_state_changed', (st) => this.adWaiter?.('rewarded', st));
        console.log('[PlayGama] Bridge SDK initialized');
      } catch (err) {
        console.warn('[PlayGama] Bridge initialization error:', err);
      }
    } else {
      console.log('[PlayGama] Bridge SDK object not detected at init time');
    }
  }

  onGameReady(): void {
    this.send('game_ready');
  }

  /** Shows one ad and resolves with whether it was watched to the end (rewarded: reward granted). */
  private runAd(kind: 'interstitial' | 'rewarded'): Promise<boolean> {
    const ad = this.bridge?.advertisement;
    const supported = kind === 'interstitial' ? ad?.isInterstitialSupported : ad?.isRewardedSupported;
    if (!ad || supported === false) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let opened = false;
      let rewarded = false;
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(startTimer);
        clearTimeout(maxTimer);
        this.adWaiter = null;
        if (opened) this.notifyAdState(false);
        resolve(ok);
      };
      const startTimer = setTimeout(() => {
        if (!opened) finish(false);
      }, AD_START_TIMEOUT_MS);
      const maxTimer = setTimeout(() => finish(kind === 'rewarded' ? rewarded : opened), AD_MAX_MS);

      this.adWaiter = (k, state) => {
        if (k !== kind) return;
        if (state === 'loading' || state === 'opened') {
          clearTimeout(startTimer);
          if (state === 'opened' && !opened) {
            opened = true;
            this.notifyAdState(true);
          }
        } else if (state === 'rewarded') {
          rewarded = true;
        } else if (state === 'closed') {
          finish(kind === 'rewarded' ? rewarded : true);
        } else if (state === 'failed') {
          finish(false);
        }
      };

      try {
        const r = kind === 'interstitial' ? ad.showInterstitial() : ad.showRewarded();
        if (r instanceof Promise) r.catch((err: unknown) => {
          console.warn(`[PlayGama] ${kind} ad error:`, err);
          finish(false);
        });
      } catch (err) {
        console.warn(`[PlayGama] ${kind} ad error:`, err);
        finish(false);
      }
    });
  }

  async showInterstitialAd(): Promise<void> {
    await this.runAd('interstitial');
  }

  async showRewardedAd(): Promise<boolean> {
    return this.runAd('rewarded');
  }

  private send(message: string): void {
    try {
      void this.bridge?.platform?.sendMessage?.(message);
    } catch {
      // Not every host supports platform messages.
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

  private inGameplay = false;

  onGameplayStart(): void {
    if (this.inGameplay) return;
    this.inGameplay = true;
    this.send('gameplay_started');
  }

  onGameplayStop(): void {
    if (!this.inGameplay) return;
    this.inGameplay = false;
    this.send('gameplay_stopped');
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
