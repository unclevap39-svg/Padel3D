/**
 * All sound is synthesised with the Web Audio API: racket hits, bounces on turf, glass and wire
 * mesh, crowd ambience and applause. The score is spoken with the device's speech synthesis.
 */
export class Sound {
  enabled = true;
  voice = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private applauseBuf: AudioBuffer | null = null;
  private crowdGain: GainNode | null = null;

  /** Must be called from a user gesture: browsers only start audio then. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch {
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
      this.noise = this.makeNoise(1.5);
      this.applauseBuf = this.makeApplause(3.2);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Applause: a few hundred individual claps, each a short burst of filtered noise. */
  private makeApplause(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(2, Math.floor(sr * seconds), sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const claps = 520;
      for (let c = 0; c < claps; c++) {
        // More claps early on, thinning out.
        const t = Math.pow(Math.random(), 1.5) * (seconds - 0.1);
        const start = Math.floor(t * sr);
        const len = Math.floor(sr * (0.008 + Math.random() * 0.012));
        const amp = (0.25 + Math.random() * 0.5) * (1 - t / seconds);
        let lp = 0;
        const tone = 0.25 + Math.random() * 0.5;
        for (let i = 0; i < len && start + i < d.length; i++) {
          const n = Math.random() * 2 - 1;
          lp += (n - lp) * tone;
          d[start + i] += (n - lp) * amp * (1 - i / len);
        }
      }
    }
    return buf;
  }

  private burst(opts: {
    type: BiquadFilterType;
    freq: number;
    q?: number;
    gain: number;
    attack?: number;
    decay: number;
    at?: number;
  }): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (opts.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = opts.type;
    f.frequency.value = opts.freq;
    f.Q.value = opts.q ?? 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(opts.gain, t0 + (opts.attack ?? 0.002));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.decay);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + opts.decay + 0.05);
  }

  private tone(freq: number, toFreq: number, gain: number, decay: number, type: OscillatorType = 'sine', at = 0): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, toFreq), t0 + decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    o.connect(g).connect(this.master!);
    o.start(t0);
    o.stop(t0 + decay + 0.02);
  }

  private get ready(): boolean {
    return this.enabled && this.ctx !== null && this.ctx.state === 'running';
  }

  /** Racket on ball: the hollow "pock" of a padel racket. `power` 0..1. */
  hit(power: number): void {
    if (!this.ready) return;
    const v = 0.35 + 0.65 * power;
    this.tone(260 + power * 60, 110, 0.55 * v, 0.09);
    this.tone(520, 300, 0.18 * v, 0.05, 'triangle');
    this.burst({ type: 'bandpass', freq: 1900, q: 1.2, gain: 0.5 * v, decay: 0.05 });
  }

  /** Racket through the air: a swing that met nothing. */
  whoosh(): void {
    if (!this.ready) return;
    this.burst({ type: 'bandpass', freq: 900, q: 0.7, gain: 0.22, attack: 0.05, decay: 0.2 });
  }

  /** Bounce on a surface; `speed` in m/s scales the loudness. */
  bounce(surface: 'floor' | 'glass' | 'fence' | 'net' | 'ground', speed: number): void {
    if (!this.ready) return;
    const v = Math.min(1, 0.15 + speed / 22);
    switch (surface) {
      case 'floor':
      case 'ground':
        this.tone(150, 70, 0.4 * v, 0.08);
        this.burst({ type: 'lowpass', freq: 700, gain: 0.35 * v, decay: 0.07 });
        break;
      case 'glass':
        // Dull thump plus the ring of a large pane.
        this.tone(190, 90, 0.5 * v, 0.1);
        this.tone(1180, 1120, 0.1 * v, 0.16);
        this.tone(1730, 1650, 0.06 * v, 0.12);
        this.burst({ type: 'highpass', freq: 2200, gain: 0.22 * v, decay: 0.04 });
        break;
      case 'fence':
        // Rattle of wire mesh: a few quick metallic bursts.
        for (let i = 0; i < 5; i++) {
          this.burst({ type: 'bandpass', freq: 3200 + Math.random() * 2600, q: 5, gain: 0.3 * v * (1 - i * 0.16), decay: 0.06, at: i * 0.035 });
        }
        this.tone(420, 380, 0.12 * v, 0.18, 'triangle');
        this.tone(663, 610, 0.08 * v, 0.14, 'triangle');
        break;
      case 'net':
        this.burst({ type: 'lowpass', freq: 500, gain: 0.3 * v, decay: 0.1 });
        break;
    }
  }

  /** Steady murmur of the crowd; call once when play starts. */
  startCrowd(): void {
    if (!this.ctx || this.crowdGain || !this.noise) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.5;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    bp.Q.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = this.enabled ? 0.05 : 0;
    src.connect(bp).connect(lp).connect(this.crowdGain).connect(this.master!);
    src.start();
    // Slow swell so the murmur is not a flat hiss.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.015;
    lfo.connect(lfoGain).connect(this.crowdGain.gain);
    lfo.start();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.crowdGain) this.crowdGain.gain.value = on ? 0.05 : 0;
    if (!on && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  /** Applause after a point; `intensity` 0..1. */
  applause(intensity: number): void {
    if (!this.ready || !this.applauseBuf) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.applauseBuf;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1700;
    bp.Q.value = 0.4;
    const g = ctx.createGain();
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.25 + 0.55 * intensity, t0 + 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6 + 1.4 * intensity);
    src.connect(bp).connect(g).connect(this.master!);
    src.start();
    // A collective "oh!" under the clapping on big points.
    if (intensity > 0.6) {
      this.burst({ type: 'bandpass', freq: 600, q: 2, gain: 0.25, attack: 0.08, decay: 0.7 });
    }
  }

  /** Speaks the score in French, if the device has a voice. */
  say(text: string): void {
    if (!this.enabled || !this.voice || !text) return;
    if (!('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'fr-FR';
      u.rate = 1.05;
      u.pitch = 0.9;
      u.volume = 0.9;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      // No voice available: the score is on screen anyway.
    }
  }
}
