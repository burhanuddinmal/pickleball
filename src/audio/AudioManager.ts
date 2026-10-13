export type SoundId = 'hit' | 'softHit' | 'powerHit' | 'bounce' | 'net' | 'pointWon' | 'pointLost' | 'click' | 'serve';
export type BgmTrack = 'menu' | 'match';

const BGM_PATHS: Record<BgmTrack, string> = {
  menu: `${import.meta.env.BASE_URL}audio/menu.mp3`,
  match: `${import.meta.env.BASE_URL}audio/match.mp3`,
};

/**
 * Audio manager handling procedural WebAudio sound effects alongside
 * background music streams with crossfading, volume ducking, and browser autoplay unlocks.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  sfxVolume = 0.8;
  bgmVolume = 0.35;
  muted = false;

  private currentBgm: BgmTrack | null = null;
  private pendingBgm: BgmTrack | null = null;
  private ducked = false;
  private bgmAudios: Map<BgmTrack, HTMLAudioElement> = new Map();
  private fadeInterval: number | null = null;

  constructor() {
    this.bindAutoUnlock();
  }

  /**
   * Automatically unlocks audio context & starts queued BGM on first user interaction anywhere.
   */
  private bindAutoUnlock(): void {
    if (typeof window === 'undefined') return;
    const onFirstGesture = () => {
      this.unlock();
      window.removeEventListener('pointerdown', onFirstGesture);
      window.removeEventListener('keydown', onFirstGesture);
    };
    window.addEventListener('pointerdown', onFirstGesture, { once: true, passive: true });
    window.addEventListener('keydown', onFirstGesture, { once: true, passive: true });
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
    } else {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        this.sfx = this.ctx.createGain();
        this.sfx.connect(this.master);
        this.applyVolume();
        const len = this.ctx.sampleRate * 0.5;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
    }

    if (this.pendingBgm) {
      const track = this.pendingBgm;
      this.pendingBgm = null;
      this.playBgm(track);
    } else if (this.currentBgm) {
      const audio = this.bgmAudios.get(this.currentBgm);
      if (audio && audio.paused) {
        audio.volume = this.targetBgmVolume();
        void audio.play().catch(() => {});
      }
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolume();
    this.applyBgmVolume();
  }

  setBgmVolume(v: number): void {
    this.bgmVolume = Math.max(0, Math.min(1, v));
    this.applyBgmVolume();
  }

  setSfxVolume(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    this.applyVolume();
  }

  setDucked(ducked: boolean): void {
    if (this.ducked === ducked) return;
    this.ducked = ducked;
    this.applyBgmVolume();
  }

  private targetBgmVolume(): number {
    if (this.muted) return 0;
    return this.ducked ? this.bgmVolume * 0.28 : this.bgmVolume;
  }

  private applyBgmVolume(): void {
    if (this.fadeInterval !== null) return;
    if (this.currentBgm) {
      const audio = this.bgmAudios.get(this.currentBgm);
      if (audio) {
        audio.volume = this.targetBgmVolume();
      }
    }
  }

  private getOrCreateBgmAudio(track: BgmTrack): HTMLAudioElement {
    let audio = this.bgmAudios.get(track);
    if (!audio) {
      audio = new Audio(BGM_PATHS[track]);
      audio.loop = true;
      audio.preload = 'auto';
      this.bgmAudios.set(track, audio);
    }
    return audio;
  }

  /**
   * Switches or starts the given BGM track with an optional crossfade.
   * If the track is already actively playing, this is a no-op.
   */
  playBgm(track: BgmTrack, crossfadeMs = 700): void {
    if (typeof window === 'undefined') return;

    if (this.currentBgm === track) {
      const existing = this.bgmAudios.get(track);
      if (existing && existing.paused) {
        existing.volume = this.targetBgmVolume();
        void existing.play().catch(() => {
          this.pendingBgm = track;
        });
      }
      return;
    }

    const prevTrack = this.currentBgm;
    this.currentBgm = track;
    const outgoing = prevTrack ? this.bgmAudios.get(prevTrack) : null;
    const incoming = this.getOrCreateBgmAudio(track);

    if (this.fadeInterval !== null) {
      window.clearInterval(this.fadeInterval);
      this.fadeInterval = null;
    }

    const targetVol = this.targetBgmVolume();
    incoming.currentTime = 0;
    incoming.volume = outgoing ? 0 : targetVol;

    const playPromise = incoming.play();
    if (playPromise) {
      playPromise.catch(() => {
        // Autoplay policy prevented playback until gesture
        this.pendingBgm = track;
      });
    }

    if (!outgoing) {
      incoming.volume = targetVol;
      return;
    }

    // Crossfade between outgoing and incoming
    const startOutgoingVol = outgoing.volume;
    const startTime = performance.now();
    this.fadeInterval = window.setInterval(() => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(1, elapsed / crossfadeMs);

      incoming.volume = progress * this.targetBgmVolume();
      outgoing.volume = Math.max(0, (1 - progress) * startOutgoingVol);

      if (progress >= 1) {
        if (this.fadeInterval !== null) {
          window.clearInterval(this.fadeInterval);
          this.fadeInterval = null;
        }
        outgoing.pause();
        outgoing.currentTime = 0;
        incoming.volume = this.targetBgmVolume();
      }
    }, 25);
  }

  stopBgm(fadeMs = 400): void {
    if (!this.currentBgm) return;
    const active = this.bgmAudios.get(this.currentBgm);
    this.currentBgm = null;
    this.pendingBgm = null;
    if (!active) return;

    if (this.fadeInterval !== null) {
      window.clearInterval(this.fadeInterval);
      this.fadeInterval = null;
    }

    if (fadeMs <= 0) {
      active.pause();
      active.currentTime = 0;
      return;
    }

    const startVol = active.volume;
    const startTime = performance.now();
    this.fadeInterval = window.setInterval(() => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(1, elapsed / fadeMs);
      active.volume = Math.max(0, (1 - progress) * startVol);
      if (progress >= 1) {
        if (this.fadeInterval !== null) {
          window.clearInterval(this.fadeInterval);
          this.fadeInterval = null;
        }
        active.pause();
        active.currentTime = 0;
      }
    }, 25);
  }

  private applyVolume(): void {
    if (this.sfx) this.sfx.gain.value = this.muted ? 0 : this.sfxVolume;
  }

  /** `intensity` 0..1 scales loudness/brightness (e.g. shot speed). `pan` -1..1. `gain` scales loudness only. */
  play(id: SoundId, intensity = 0.6, pan = 0, gain = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || this.muted) return;
    const t = ctx.currentTime;
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan));
    if (gain === 1) {
      out.connect(this.sfx);
    } else {
      const g = ctx.createGain();
      g.gain.value = gain;
      out.connect(g).connect(this.sfx);
    }
    switch (id) {
      case 'hit':
      case 'softHit':
      case 'powerHit':
      case 'serve': {
        // Hollow plastic "pock": short pitched body + filtered click.
        const power = id === 'powerHit' ? 1 : id === 'softHit' ? 0.25 : intensity;
        this.tone(out, t, 1150 + power * 500, 520, 0.07 + power * 0.03, 0.55 + power * 0.45, 'triangle');
        this.burst(out, t, 3200 + power * 2500, 0.03, 0.35 + power * 0.5);
        break;
      }
      case 'bounce':
        this.tone(out, t, 420, 180, 0.07, 0.35 * intensity + 0.1, 'sine');
        this.burst(out, t, 1400, 0.025, 0.18 * intensity);
        break;
      case 'net':
        this.burst(out, t, 700, 0.18, 0.4);
        break;
      case 'pointWon':
        this.tone(out, t, 660, 660, 0.12, 0.25, 'square');
        this.tone(out, t + 0.11, 990, 990, 0.22, 0.25, 'square');
        break;
      case 'pointLost':
        this.tone(out, t, 420, 300, 0.18, 0.22, 'sawtooth');
        this.tone(out, t + 0.16, 300, 220, 0.25, 0.2, 'sawtooth');
        break;
      case 'click':
        this.tone(out, t, 900, 700, 0.04, 0.2, 'square');
        break;
    }
  }

  private tone(out: AudioNode, t: number, f0: number, f1: number, dur: number, gain: number, type: OscillatorType): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private burst(out: AudioNode, t: number, freq: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur + 0.02);
  }
}
