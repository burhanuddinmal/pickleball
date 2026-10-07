export type SoundId = 'hit' | 'softHit' | 'powerHit' | 'bounce' | 'net' | 'pointWon' | 'pointLost' | 'click' | 'serve';

/**
 * Procedural WebAudio sound effects. Each SoundId maps to a synth recipe today; the same IDs can
 * later be mapped to sample files without touching gameplay code.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  sfxVolume = 0.8;
  muted = false;

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
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

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyVolume();
  }

  private applyVolume(): void {
    if (this.sfx) this.sfx.gain.value = this.muted ? 0 : this.sfxVolume;
  }

  /** `intensity` 0..1 scales loudness/brightness (e.g. shot speed). `pan` -1..1. */
  play(id: SoundId, intensity = 0.6, pan = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || this.muted) return;
    const t = ctx.currentTime;
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(this.sfx);
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
