import { describe, expect, it } from 'vitest';
import { AudioManager } from '../src/audio/AudioManager';

describe('AudioManager', () => {
  it('instantiates safely without error', () => {
    const audio = new AudioManager();
    expect(audio).toBeDefined();
    expect(audio.sfxVolume).toBe(0.8);
    expect(audio.bgmVolume).toBe(0.35);
    expect(audio.muted).toBe(false);
  });

  it('updates muted state correctly', () => {
    const audio = new AudioManager();
    audio.setMuted(true);
    expect(audio.muted).toBe(true);
    audio.setMuted(false);
    expect(audio.muted).toBe(false);
  });

  it('clamps BGM volume between 0 and 1', () => {
    const audio = new AudioManager();
    audio.setBgmVolume(0.5);
    expect(audio.bgmVolume).toBe(0.5);
    audio.setBgmVolume(1.5);
    expect(audio.bgmVolume).toBe(1);
    audio.setBgmVolume(-0.2);
    expect(audio.bgmVolume).toBe(0);
  });

  it('handles ducking and track requests without throwing', () => {
    const audio = new AudioManager();
    expect(() => {
      audio.setDucked(true);
      audio.playBgm('menu');
      audio.playBgm('match');
      audio.setDucked(false);
      audio.stopBgm();
    }).not.toThrow();
  });
});
