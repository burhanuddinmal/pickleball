import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Preferences } from '@capacitor/preferences';
import { StatusBar } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';
import {
  AdMob,
  BannerAdPluginEvents,
  BannerAdPosition,
  BannerAdSize,
  RewardAdPluginEvents,
  type AdMobRewardItem,
  type AdmobConsentInfo,
} from '@capacitor-community/admob';
import type { PlatformAdapter, PlatformCapabilities, SaveData } from '../types';

const STORAGE_KEY = 'pickle-smash.save';

// Google AdMob test ad unit IDs as fallback defaults if env vars are missing
const DEFAULT_TEST_BANNER = 'ca-app-pub-3940256099942544/6300978111';
const DEFAULT_TEST_INTERSTITIAL = 'ca-app-pub-3940256099942544/1033173712';
const DEFAULT_TEST_REWARDED = 'ca-app-pub-3940256099942544/5224354917';

export class AndroidAdapter implements PlatformAdapter {
  readonly id = 'android';
  readonly capabilities: PlatformCapabilities = {
    ads: true,
    rewardedAds: true,
    banner: true,
    cloudSave: true,
    leaderboards: false,
    achievements: false,
    haptics: true,
    backButton: true,
    iap: false,
  };

  private adListeners: Array<(active: boolean) => void> = [];
  private pauseListeners: Array<() => void> = [];
  private resumeListeners: Array<() => void> = [];
  private backListeners: Array<() => void> = [];
  private bannerListeners: Array<(h: number) => void> = [];
  private bannerHeight = 0;
  private isTesting = true;
  /** UMP result; false (no consent yet / SDK not ready) means no ad requests at all. */
  private canRequestAds = false;
  private privacyRequired = false;
  /** 'none' = never loaded, 'hidden' = loaded and paused (resume is cheap, no reload). */
  private bannerState: 'none' | 'shown' | 'hidden' = 'none';

  constructor() {
    this.isTesting = import.meta.env.VITE_ADMOB_IS_TESTING !== 'false';
    this.setupLifecycle();
  }

  private setupLifecycle(): void {
    if (Capacitor.isNativePlatform()) {
      App.addListener('appStateChange', (state) => {
        if (!state.isActive) {
          for (const cb of this.pauseListeners) cb();
        } else {
          for (const cb of this.resumeListeners) cb();
        }
      });

      App.addListener('backButton', () => {
        for (const cb of this.backListeners) cb();
      });
    } else if (typeof document !== 'undefined') {
      // Browser fallback when running in dev mode
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          for (const cb of this.pauseListeners) cb();
        } else {
          for (const cb of this.resumeListeners) cb();
        }
      });
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          for (const cb of this.backListeners) cb();
        }
      });
    }
  }

  async init(): Promise<void> {
    console.log('[Android] Initializing Android platform adapter...');
    if (Capacitor.isNativePlatform()) {
      try {
        await SplashScreen.hide().catch(() => {});
        await StatusBar.hide().catch(() => {});
      } catch (err) {
        console.warn('[Android] StatusBar/SplashScreen setup warning:', err);
      }

      // Initialize AdMob and handle UMP consent (GDPR / US states) before any ad request
      try {
        await AdMob.initialize({
          initializeForTesting: this.isTesting,
        });

        let consentInfo = await AdMob.requestConsentInfo().catch(() => null);
        if (consentInfo?.isConsentFormAvailable && consentInfo.status === 'REQUIRED') {
          consentInfo = await AdMob.showConsentForm().catch(() => consentInfo);
        }
        this.applyConsent(consentInfo);
        await AdMob.addListener(BannerAdPluginEvents.SizeChanged, (size) => this.notifyBanner(size.height));
        console.log('[Android] AdMob initialized; canRequestAds =', this.canRequestAds);
      } catch (err) {
        console.warn('[Android] AdMob initialization error:', err);
      }
    } else {
      console.log('[Android] Running on web platform with Capacitor fallbacks');
    }
  }

  private applyConsent(info: AdmobConsentInfo | null): void {
    // Outside consent regions UMP reports canRequestAds = true; a failed request still allows ads
    // (Google then serves per its defaults) unless the user is known to need a form.
    this.canRequestAds = info ? info.canRequestAds : true;
    this.privacyRequired = info?.privacyOptionsRequirementStatus === 'REQUIRED';
  }

  privacyOptionsRequired(): boolean {
    return this.privacyRequired;
  }

  async showPrivacyOptions(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    await AdMob.showPrivacyOptionsForm();
    this.applyConsent(await AdMob.requestConsentInfo().catch(() => null));
    if (!this.canRequestAds) await this.hideBanner();
  }

  async showInterstitialAd(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      console.log('[Android] Web fallback: simulated interstitial ad');
      this.notifyAdState(true);
      await new Promise((r) => setTimeout(r, 200));
      this.notifyAdState(false);
      return;
    }

    if (!this.canRequestAds) return;
    const adId = import.meta.env.VITE_ADMOB_INTERSTITIAL_ID || DEFAULT_TEST_INTERSTITIAL;
    this.notifyAdState(true);

    try {
      await AdMob.prepareInterstitial({
        adId,
        isTesting: this.isTesting,
      });
      await AdMob.showInterstitial();
    } catch (err) {
      console.warn('[Android] Interstitial ad failed:', err);
    } finally {
      this.notifyAdState(false);
    }
  }

  async showRewardedAd(): Promise<boolean> {
    if (!Capacitor.isNativePlatform()) {
      console.log('[Android] Web fallback: simulated rewarded ad');
      this.notifyAdState(true);
      await new Promise((r) => setTimeout(r, 200));
      this.notifyAdState(false);
      return true;
    }

    if (!this.canRequestAds) return false;
    const adId = import.meta.env.VITE_ADMOB_REWARDED_ID || DEFAULT_TEST_REWARDED;
    this.notifyAdState(true);

    return new Promise<boolean>((resolve) => {
      (async () => {
        let rewarded = false;
        let rewardListenerHandle: { remove: () => Promise<void> } | null = null;

        try {
          rewardListenerHandle = await AdMob.addListener(RewardAdPluginEvents.Rewarded, (reward: AdMobRewardItem) => {
            if (reward) rewarded = true;
          });

          await AdMob.prepareRewardVideoAd({
            adId,
            isTesting: this.isTesting,
          });

          await AdMob.showRewardVideoAd();
        } catch (err) {
          console.warn('[Android] Rewarded ad failed:', err);
        } finally {
          if (rewardListenerHandle) {
            await rewardListenerHandle.remove().catch(() => {});
          }
          this.notifyAdState(false);
          resolve(rewarded);
        }
      })();
    });
  }

  async showBanner(): Promise<void> {
    if (!Capacitor.isNativePlatform() || !this.canRequestAds || this.bannerState === 'shown') return;
    const wasHidden = this.bannerState === 'hidden';
    this.bannerState = 'shown';
    try {
      if (wasHidden) {
        await AdMob.resumeBanner();
      } else {
        await AdMob.showBanner({
          adId: import.meta.env.VITE_ADMOB_BANNER_ID || DEFAULT_TEST_BANNER,
          adSize: BannerAdSize.ADAPTIVE_BANNER,
          position: BannerAdPosition.BOTTOM_CENTER,
          isTesting: this.isTesting,
        });
      }
    } catch (err) {
      console.warn('[Android] Show banner error:', err);
      this.bannerState = wasHidden ? 'hidden' : 'none';
    }
  }

  async hideBanner(): Promise<void> {
    if (!Capacitor.isNativePlatform() || this.bannerState !== 'shown') return;
    this.bannerState = 'hidden';
    try {
      await AdMob.hideBanner();
    } catch (err) {
      console.warn('[Android] Hide banner error:', err);
    }
    this.notifyBanner(0);
  }

  onBannerSizeChange(cb: (heightPx: number) => void): void {
    this.bannerListeners.push(cb);
    cb(this.bannerHeight); // the banner may have loaded before this listener existed
  }

  private notifyBanner(height: number): void {
    this.bannerHeight = height;
    for (const cb of this.bannerListeners) cb(height);
  }

  async saveProgress(data: Partial<SaveData>): Promise<void> {
    try {
      const existing = (await this.loadProgress()) || { target: 11 };
      const merged: SaveData = { ...existing, ...data };
      const serialized = JSON.stringify(merged);

      if (Capacitor.isNativePlatform()) {
        await Preferences.set({ key: STORAGE_KEY, value: serialized });
      } else {
        localStorage.setItem(STORAGE_KEY, serialized);
      }
    } catch (err) {
      console.warn('[Android] Error saving progress:', err);
    }
  }

  async loadProgress(): Promise<SaveData | null> {
    try {
      let raw: string | null = null;
      if (Capacitor.isNativePlatform()) {
        const res = await Preferences.get({ key: STORAGE_KEY });
        raw = res.value;
      } else {
        raw = localStorage.getItem(STORAGE_KEY);
      }

      if (raw) return JSON.parse(raw) as SaveData;
    } catch (err) {
      console.warn('[Android] Error loading progress:', err);
    }
    return null;
  }

  async submitScore(score: number): Promise<void> {
    console.log('[Android] submitScore:', score);
  }

  onGameplayStart(): void {
    console.log('[Android] onGameplayStart()');
  }

  onGameplayStop(): void {
    console.log('[Android] onGameplayStop()');
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

  exitApp(): void {
    if (Capacitor.isNativePlatform()) void App.exitApp();
  }

  vibrate(pattern: number | number[] = 25): void {
    if (Capacitor.isNativePlatform()) {
      try {
        Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
      } catch {
        // Ignored
      }
    } else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
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
        console.error('[Android] Error in adState listener:', err);
      }
    }
  }
}
