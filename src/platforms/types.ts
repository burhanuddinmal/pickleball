export interface SaveData {
  target: number;
  matchesPlayed?: number;
  matchesWon?: number;
  bestRally?: number;
  /** Consecutive matches won (current run) and the longest run so far. */
  winStreak?: number;
  bestStreak?: number;
  /** AI difficulty last picked on the title screen. */
  difficulty?: string;
  highScore?: number;
  customData?: Record<string, unknown>;
}

export interface PlatformCapabilities {
  readonly ads: boolean;
  readonly rewardedAds: boolean;
  readonly banner: boolean;
  readonly cloudSave: boolean;
  readonly leaderboards: boolean;
  readonly achievements: boolean;
  readonly haptics: boolean;
  readonly backButton: boolean;
  readonly iap: boolean;
}

export type AdType = 'interstitial' | 'rewarded' | 'banner';

export interface PlatformAdapter {
  /** Identifier of the active platform: 'dummy' | 'crazygames' | 'playgama' | 'itch' | 'android' */
  readonly id: string;

  /** Feature capabilities of this platform */
  readonly capabilities: PlatformCapabilities;

  /** Initialize platform SDK, check auth/environment, setup consent */
  init(): Promise<void>;

  /**
   * Display an interstitial/midgame ad.
   * Resolves when the ad closes or if no ad is displayed.
   */
  showInterstitialAd(): Promise<void>;

  /**
   * Display a rewarded ad.
   * Resolves true only if the reward was earned; false when skipped, failed or no ad was available.
   */
  showRewardedAd(): Promise<boolean>;

  /** Optional banner controls (only called when `capabilities.banner`); both are idempotent. */
  showBanner?(): Promise<void>;
  hideBanner?(): Promise<void>;

  /** Banner height in CSS px whenever it changes (0 when hidden), so the UI can keep clear of it. */
  onBannerSizeChange?(cb: (heightPx: number) => void): void;

  /** Ad consent (UMP): true when the user must be offered a "Privacy options" entry point. */
  privacyOptionsRequired?(): boolean;

  /** Opens the consent provider's privacy options form. */
  showPrivacyOptions?(): Promise<void>;

  /** Notify platform that loading finished and the game is interactive. */
  onGameReady?(): void;

  /** Persist progression data */
  saveProgress(data: Partial<SaveData>): Promise<void>;

  /** Load persisted progression data */
  loadProgress(): Promise<SaveData | null>;

  /** Submit leaderboard score */
  submitScore(score: number, leaderboardName?: string): Promise<void>;

  /** Unlock achievement */
  unlockAchievement?(id: string): Promise<void>;

  /** Notify platform when gameplay starts or resumes */
  onGameplayStart(): void;

  /** Notify platform when gameplay stops (menu, pause, match over) */
  onGameplayStop(): void;

  /** App backgrounded / tab hidden listener */
  onPause(cb: () => void): void;

  /** App foregrounded / tab visible listener */
  onResume(cb: () => void): void;

  /** Hardware back button listener (Android) */
  onBackButton?(cb: () => void): void;

  /** Close the app (Android back on the title screen); absent where a page can't close itself. */
  exitApp?(): void;

  /** Haptic feedback / vibration (pattern in ms) */
  vibrate?(pattern?: number | number[]): void;

  /** Register callback to mute/unmute game audio during ads */
  onAdStateChange?(callback: (isAdActive: boolean) => void): void;
}
