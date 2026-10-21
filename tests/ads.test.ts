import { describe, expect, it, vi } from 'vitest';
import { AdManager, DEFAULT_INTERSTITIAL_POLICY, interstitialDue, type AdHooks } from '../src/game/AdManager';
import { DummyAdapter, dummyAdOptions } from '../src/platforms/dummy';
import type { PlatformCapabilities } from '../src/platforms/types';

const caps = (over: Partial<PlatformCapabilities> = {}): PlatformCapabilities => ({
  ads: true,
  rewardedAds: true,
  banner: true,
  cloudSave: false,
  leaderboards: false,
  achievements: false,
  haptics: false,
  backButton: false,
  iap: false,
  ...over,
});

function fakePlatform(over: Partial<PlatformCapabilities> = {}) {
  let adState: ((on: boolean) => void) | null = null;
  const p = {
    capabilities: caps(over),
    showInterstitialAd: vi.fn(async () => {}),
    showRewardedAd: vi.fn(async () => true),
    showBanner: vi.fn(async () => {}),
    hideBanner: vi.fn(async () => {}),
    onGameplayStop: vi.fn(),
    onAdStateChange: (cb: (on: boolean) => void) => (adState = cb),
    emitAdState: (on: boolean) => adState?.(on),
  };
  return p;
}

function setup(over: Partial<PlatformCapabilities> = {}) {
  const p = fakePlatform(over);
  const events: string[] = [];
  const hooks: AdHooks = { onAdStart: () => events.push('start'), onAdEnd: () => events.push('end') };
  let t = 0;
  const clock = { advance: (ms: number) => (t += ms) };
  const ads = new AdManager(p, hooks, DEFAULT_INTERSTITIAL_POLICY, () => t);
  return { p, ads, events, clock };
}

describe('interstitial pacing', () => {
  const policy = { minMatches: 2, minIntervalMs: 90_000 };

  it('needs both enough matches and enough time', () => {
    expect(interstitialDue({ matchesSinceAd: 2, lastAdAt: 0 }, 90_000, policy)).toBe(true);
    expect(interstitialDue({ matchesSinceAd: 1, lastAdAt: 0 }, 1e9, policy)).toBe(false);
    expect(interstitialDue({ matchesSinceAd: 5, lastAdAt: 0 }, 89_999, policy)).toBe(false);
  });

  it('skips the first match of a session, then plays after the second', async () => {
    const { p, ads, clock } = setup();
    clock.advance(300_000);
    ads.matchFinished();
    await ads.interstitialAtBreak();
    expect(p.showInterstitialAd).not.toHaveBeenCalled();
    ads.matchFinished();
    await ads.interstitialAtBreak();
    expect(p.showInterstitialAd).toHaveBeenCalledTimes(1);
  });

  it('cools down after an ad', async () => {
    const { p, ads, clock } = setup();
    clock.advance(300_000);
    ads.matchFinished();
    ads.matchFinished();
    await ads.interstitialAtBreak();
    ads.matchFinished();
    ads.matchFinished();
    clock.advance(60_000);
    await ads.interstitialAtBreak();
    expect(p.showInterstitialAd).toHaveBeenCalledTimes(1);
    clock.advance(30_000);
    await ads.interstitialAtBreak();
    expect(p.showInterstitialAd).toHaveBeenCalledTimes(2);
  });

  it('a watched rewarded ad counts as the break ad', async () => {
    const { p, ads, clock } = setup();
    clock.advance(300_000);
    ads.matchFinished();
    await ads.rewarded();
    ads.matchFinished();
    await ads.interstitialAtBreak();
    expect(p.showInterstitialAd).not.toHaveBeenCalled();
  });

  it('never runs without the ads capability', async () => {
    const { p, ads, clock } = setup({ ads: false });
    clock.advance(1e9);
    ads.matchFinished();
    ads.matchFinished();
    await ads.interstitialAtBreak();
    expect(p.showInterstitialAd).not.toHaveBeenCalled();
  });
});

describe('ad bracket (pause + mute)', () => {
  it('stops gameplay and brackets the ad with start/end', async () => {
    const { p, ads, events } = setup();
    p.showRewardedAd.mockImplementation(async () => {
      expect(ads.isAdActive).toBe(true);
      expect(ads.busy).toBe(true);
      return true;
    });
    expect(await ads.rewarded()).toBe(true);
    expect(p.onGameplayStop).toHaveBeenCalled();
    expect(events).toEqual(['start', 'end']);
    expect(ads.isAdActive).toBe(false);
  });

  it('resumes even when the ad throws, and grants nothing', async () => {
    const { p, ads, events } = setup();
    p.showRewardedAd.mockRejectedValue(new Error('no fill'));
    expect(await ads.rewarded()).toBe(false);
    expect(events).toEqual(['start', 'end']);
    expect(ads.busy).toBe(false);
  });

  it('only grants a reward on an explicit true', async () => {
    const { p, ads } = setup();
    p.showRewardedAd.mockResolvedValue(false);
    expect(await ads.rewarded()).toBe(false);
  });

  it('does not offer rewarded without the capability', async () => {
    const { p, ads } = setup({ rewardedAds: false });
    expect(ads.rewardedAvailable).toBe(false);
    expect(await ads.rewarded()).toBe(false);
    expect(p.showRewardedAd).not.toHaveBeenCalled();
  });

  it('adapter ad-state events overlapping a request produce a single bracket', async () => {
    const { p, ads, events } = setup();
    p.showRewardedAd.mockImplementation(async () => {
      p.emitAdState(true);
      p.emitAdState(false);
      return true;
    });
    await ads.rewarded();
    expect(events).toEqual(['start', 'end']);
  });

  it('a portal-started ad (no request) also pauses and resumes', () => {
    const { p, events } = setup();
    p.emitAdState(true);
    p.emitAdState(false);
    expect(events).toEqual(['start', 'end']);
  });
});

describe('banner', () => {
  it('shows on request, hides during fullscreen ads and gameplay, without repeat calls', async () => {
    const { p, ads } = setup();
    ads.setBanner(true);
    ads.setBanner(true);
    expect(p.showBanner).toHaveBeenCalledTimes(1);
    p.showRewardedAd.mockImplementation(async () => {
      expect(p.hideBanner).toHaveBeenCalledTimes(1);
      return true;
    });
    await ads.rewarded();
    expect(p.showBanner).toHaveBeenCalledTimes(2);
    ads.setBanner(false);
    expect(p.hideBanner).toHaveBeenCalledTimes(2);
  });

  it('is never touched without the banner capability', () => {
    const { p, ads } = setup({ banner: false });
    ads.setBanner(true);
    ads.setBanner(false);
    expect(p.showBanner).not.toHaveBeenCalled();
    expect(p.hideBanner).not.toHaveBeenCalled();
  });
});

describe('dummy platform ad testing', () => {
  it('parses the URL switches', () => {
    expect(dummyAdOptions('', true, false).ads).toBe(true);
    expect(dummyAdOptions('', false, false).ads).toBe(false);
    expect(dummyAdOptions('?ads=0', true, false).ads).toBe(false);
    expect(dummyAdOptions('?ads=1', false, false).ads).toBe(true);
    expect(dummyAdOptions('?adfail=rewarded', true, false).fail).toBe('rewarded');
    expect(dummyAdOptions('?adfail=bogus', true, false).fail).toBe('none');
    expect(dummyAdOptions('?privacy=1', true, false).privacy).toBe(true);
  });

  it('reports ad state around a successful rewarded ad', async () => {
    const d = new DummyAdapter({ ads: true, fail: 'none', ui: false });
    const states: boolean[] = [];
    d.onAdStateChange((on) => states.push(on));
    expect(await d.showRewardedAd()).toBe(true);
    expect(states).toEqual([true, false]);
  });

  it('"unavailable" ads resolve immediately with no reward and no ad state', async () => {
    const d = new DummyAdapter({ ads: true, fail: 'all', ui: false });
    const states: boolean[] = [];
    d.onAdStateChange((on) => states.push(on));
    expect(await d.showRewardedAd()).toBe(false);
    await d.showInterstitialAd();
    expect(states).toEqual([]);
  });

  it('capabilities follow the ads switch', () => {
    expect(new DummyAdapter({ ads: false, ui: false }).capabilities.rewardedAds).toBe(false);
    expect(new DummyAdapter({ ads: true, ui: false }).capabilities.banner).toBe(true);
  });
});
