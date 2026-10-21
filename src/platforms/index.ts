import type { PlatformAdapter } from './types';

export * from './types';

let currentAdapter: PlatformAdapter | null = null;
let initialized = false;

const fallbackAdapter: PlatformAdapter = {
  id: 'fallback',
  capabilities: {
    ads: false,
    rewardedAds: false,
    banner: false,
    cloudSave: false,
    leaderboards: false,
    achievements: false,
    haptics: false,
    backButton: false,
    iap: false,
  },
  async init() {},
  async showInterstitialAd() {},
  async showRewardedAd() {
    return false;
  },
  async saveProgress() {},
  async loadProgress() {
    return null;
  },
  async submitScore() {},
  onGameplayStart() {},
  onGameplayStop() {},
  onPause() {},
  onResume() {},
};

/**
 * Initializes and resolves the platform adapter according to the build mode.
 * Dynamically loads only the required provider SDK / adapter module.
 */
export async function initPlatform(): Promise<PlatformAdapter> {
  if (initialized && currentAdapter) return currentAdapter;

  const mode = (import.meta.env.MODE || 'dummy').toLowerCase();

  try {
    switch (mode) {
      case 'crazygames': {
        const { CrazyGamesAdapter } = await import('./crazygames');
        currentAdapter = new CrazyGamesAdapter();
        break;
      }
      case 'playgama': {
        const { PlayGamaAdapter } = await import('./playgama');
        currentAdapter = new PlayGamaAdapter();
        break;
      }
      case 'itch': {
        const { ItchAdapter } = await import('./itch');
        currentAdapter = new ItchAdapter();
        break;
      }
      case 'android':
      case 'android.production': {
        const { AndroidAdapter } = await import('./android');
        currentAdapter = new AndroidAdapter();
        break;
      }
      case 'dummy':
      default: {
        const { DummyAdapter } = await import('./dummy');
        currentAdapter = new DummyAdapter();
        break;
      }
    }
  } catch (err) {
    console.error(`[Platform] Failed to load adapter for mode "${mode}", falling back to Dummy:`, err);
    const { DummyAdapter } = await import('./dummy');
    currentAdapter = new DummyAdapter();
  }

  await currentAdapter.init();
  initialized = true;
  return currentAdapter;
}

/**
 * Platform proxy: delegates all calls and properties to the active adapter.
 * Can be safely imported across game systems without coupling to specific SDKs.
 */
export const platform: PlatformAdapter = new Proxy({} as PlatformAdapter, {
  get(_target, prop: keyof PlatformAdapter) {
    const adapter = currentAdapter || fallbackAdapter;
    const val = adapter[prop];
    if (typeof val === 'function') {
      return (val as (...args: unknown[]) => unknown).bind(adapter);
    }
    return val;
  },
});
