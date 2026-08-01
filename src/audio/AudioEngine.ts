import type { SoundKind } from '../core/GameEvents';
import { clamp01 } from '../core/Math2D';
import { fxRng } from '../core/Random';

/**
 * AudioEngine - fully procedural sound, synthesised at runtime.
 *
 * There are no audio files in this project. Every sound is built from noise
 * bursts, filtered tones and envelopes shaped by the Web Audio graph. That is
 * partly a licensing decision (everything ships original) and partly a
 * practical one: a gunshot assembled from a body, a crack and a tail can be
 * parameterised by calibre, suppression and environment, so a suppressed pistol
 * indoors and an unsuppressed rifle across the yard genuinely differ rather
 * than being two files.
 *
 * Spatialisation is deliberately simple and cheap: distance attenuation, a
 * stereo pan from the listener's facing, and a low-pass whose cutoff follows
 * both distance and wall occlusion. In a game where hearing where a shot came
 * from is a core skill, predictable and readable beats physically exact.
 *
 * Unity port note: replace with AudioSource/AudioMixer. Keep the parameter
 * mapping - it is the part that carries the game feel.
 */

interface Voice {
  endsAt: number;
}

export interface ListenerState {
  x: number;
  y: number;
  angle: number;
  /** Hearing multiplier from equipment (helmets muffle). */
  hearingFactor: number;
  /** Deafened 0..1 after firing unsuppressed - recovers over a second or two. */
  deafness: number;
}

/** Maximum simultaneous voices. Beyond this, new sounds are dropped. */
const MAX_VOICES = 22;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private shortNoise: AudioBuffer | null = null;
  private voices: Voice[] = [];

  /** Master volume 0..1, settable from the options screen. */
  volume = 0.8;
  muted = false;

  /** Set true once the user has interacted, which browsers require. */
  private unlocked = false;

  readonly listener: ListenerState = { x: 0, y: 0, angle: 0, hearingFactor: 1, deafness: 0 };

  /**
   * Create the context. Must be called from a user gesture on mobile, so the
   * game calls it from the first tap on the main menu.
   */
  unlock(): void {
    if (this.unlocked) return;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.buildNoiseBuffers();
      this.unlocked = true;
    } catch {
      // Audio is optional - a device that refuses a context still plays fine.
      this.ctx = null;
    }
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend();
  }

  setVolume(v: number): void {
    this.volume = clamp01(v);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  /** Pre-generate the noise sources every effect is built from. */
  private buildNoiseBuffers(): void {
    if (!this.ctx) return;
    const rate = this.ctx.sampleRate;

    // Two seconds of white noise, reused by every effect at different offsets
    // and playback rates so no two shots sound identical.
    const long = this.ctx.createBuffer(1, rate * 2, rate);
    const longData = long.getChannelData(0);
    for (let i = 0; i < longData.length; i++) longData[i] = Math.random() * 2 - 1;
    this.noiseBuffer = long;

    // A short, steeply decaying burst used for transients (impacts, clicks).
    const short = this.ctx.createBuffer(1, Math.floor(rate * 0.12), rate);
    const shortData = short.getChannelData(0);
    for (let i = 0; i < shortData.length; i++) {
      const t = i / shortData.length;
      shortData[i] = (Math.random() * 2 - 1) * Math.exp(-t * 14);
    }
    this.shortNoise = short;
  }

  private get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Reap finished voices and enforce the polyphony cap. */
  private canPlay(duration: number): boolean {
    const t = this.now;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i].endsAt <= t) this.voices.splice(i, 1);
    }
    if (this.voices.length >= MAX_VOICES) return false;
    this.voices.push({ endsAt: t + duration });
    return true;
  }

  /**
   * Compute distance gain, stereo pan and filter cutoff for a world position.
   * Returns null when the sound is inaudible.
   */
  private spatialise(
    x: number,
    y: number,
    radius: number,
    occlusion: number,
  ): { gain: number; pan: number; cutoff: number } | null {
    const dx = x - this.listener.x;
    const dy = y - this.listener.y;
    const dist = Math.hypot(dx, dy);
    const audibleRange = radius * this.listener.hearingFactor;
    if (dist > audibleRange * 1.6) return null;

    // Inverse falloff with a soft floor - distant shots stay just audible,
    // which is what lets the player orient towards a firefight.
    const attenuation = 1 / (1 + (dist / Math.max(1, audibleRange * 0.35)) ** 1.7);
    let gain = attenuation * (1 - occlusion * 0.72) * (1 - this.listener.deafness * 0.85);
    gain *= this.listener.hearingFactor;
    if (gain < 0.004) return null;

    // Pan from the bearing relative to where the listener is facing.
    const bearing = Math.atan2(dy, dx) - this.listener.angle;
    const pan = clamp01(Math.abs(Math.sin(bearing))) * Math.sign(Math.sin(bearing));

    // Air and walls both eat high frequencies.
    const cutoff = Math.max(320, 16000 * (1 - occlusion * 0.8) * (1 / (1 + dist * 0.08)));

    return { gain, pan, cutoff };
  }

  /**
   * Play a world sound.
   * `occlusion` 0..1 comes from the same estimate the AI hearing model uses,
   * so what muffles an enemy's hearing muffles yours identically.
   */
  play(kind: SoundKind, x: number, y: number, radius: number, occlusion: number, intensity = 1): void {
    if (!this.ctx || !this.master || this.muted) return;
    const spatial = this.spatialise(x, y, radius, occlusion);
    if (!spatial) return;

    switch (kind) {
      case 'gunshot':
        this.playGunshot(spatial, intensity, false);
        break;
      case 'suppressed':
        this.playGunshot(spatial, intensity, true);
        break;
      case 'explosion':
        this.playExplosion(spatial, intensity);
        break;
      case 'footstep':
        this.playFootstep(spatial, false);
        break;
      case 'sprint':
        this.playFootstep(spatial, true);
        break;
      case 'reload':
        this.playMechanical(spatial, 0.06, 2200);
        break;
      case 'door':
      case 'container':
        this.playMechanical(spatial, 0.16, 900);
        break;
      case 'impact':
        this.playImpact(spatial, false);
        break;
      case 'ricochet':
        this.playImpact(spatial, true);
        break;
      case 'death':
        this.playVoice(spatial, 180, 0.55);
        break;
      case 'voice':
        this.playVoice(spatial, 260, 0.3);
        break;
      default:
        break;
    }
  }

  /** Local UI feedback - unspatialised, always at the listener. */
  playUi(kind: 'click' | 'confirm' | 'deny' | 'pickup' | 'alert'): void {
    if (!this.ctx || !this.master || this.muted) return;
    const spatial = { gain: 0.4, pan: 0, cutoff: 12000 };
    switch (kind) {
      case 'click':
        this.playTone(spatial, 880, 0.04, 'square', 0.12);
        break;
      case 'confirm':
        this.playTone(spatial, 620, 0.09, 'triangle', 0.2);
        this.playTone(spatial, 930, 0.12, 'triangle', 0.15, 0.05);
        break;
      case 'deny':
        this.playTone(spatial, 190, 0.16, 'sawtooth', 0.2);
        break;
      case 'pickup':
        this.playTone(spatial, 1180, 0.07, 'sine', 0.18);
        break;
      case 'alert':
        this.playTone(spatial, 420, 0.22, 'sawtooth', 0.22);
        break;
      default:
        break;
    }
  }

  // =========================================================================
  // Synthesis
  // =========================================================================

  private makeChain(spatial: { gain: number; pan: number; cutoff: number }): {
    input: AudioNode;
    gain: GainNode;
  } | null {
    if (!this.ctx || !this.master) return null;
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = spatial.cutoff;
    filter.Q.value = 0.7;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = spatial.pan;

    gain.connect(filter);
    filter.connect(panner);
    panner.connect(this.master);
    return { input: gain, gain };
  }

  /**
   * Gunshot: three layered components.
   *   body  - low-frequency thump from the propellant
   *   crack - high-frequency transient of the supersonic bullet
   *   tail  - reverberant decay that carries the sense of distance
   * A suppressor removes most of the crack and shortens the tail, leaving the
   * mechanical action - which is exactly what it sounds like in reality.
   */
  private playGunshot(spatial: { gain: number; pan: number; cutoff: number }, intensity: number, suppressed: boolean): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const duration = suppressed ? 0.16 : 0.55;
    if (!this.canPlay(duration)) return;

    const t = this.now;
    const chain = this.makeChain(spatial);
    if (!chain) return;

    const level = spatial.gain * intensity * (suppressed ? 0.45 : 1);

    // --- body ---------------------------------------------------------------
    const body = this.ctx.createBufferSource();
    body.buffer = this.noiseBuffer;
    body.playbackRate.value = fxRng.range(0.75, 0.95);
    const bodyFilter = this.ctx.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.setValueAtTime(suppressed ? 900 : 2600, t);
    bodyFilter.frequency.exponentialRampToValueAtTime(180, t + duration * 0.7);
    const bodyGain = this.ctx.createGain();
    bodyGain.gain.setValueAtTime(level * 0.9, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    body.connect(bodyFilter);
    bodyFilter.connect(bodyGain);
    bodyGain.connect(chain.input);
    body.start(t, fxRng.range(0, 1.5));
    body.stop(t + duration);

    // --- crack --------------------------------------------------------------
    if (!suppressed && this.shortNoise) {
      const crack = this.ctx.createBufferSource();
      crack.buffer = this.shortNoise;
      crack.playbackRate.value = fxRng.range(1.4, 2.0);
      const crackFilter = this.ctx.createBiquadFilter();
      crackFilter.type = 'highpass';
      crackFilter.frequency.value = 1800;
      const crackGain = this.ctx.createGain();
      crackGain.gain.setValueAtTime(level * 0.8, t);
      crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      crack.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(chain.input);
      crack.start(t);
      crack.stop(t + 0.1);
    }

    // --- mechanical action --------------------------------------------------
    if (this.shortNoise) {
      const action = this.ctx.createBufferSource();
      action.buffer = this.shortNoise;
      action.playbackRate.value = fxRng.range(2.2, 3.2);
      const actionGain = this.ctx.createGain();
      actionGain.gain.setValueAtTime(level * (suppressed ? 0.55 : 0.22), t + 0.02);
      actionGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      action.connect(actionGain);
      actionGain.connect(chain.input);
      action.start(t + 0.02);
      action.stop(t + 0.14);
    }
  }

  private playExplosion(spatial: { gain: number; pan: number; cutoff: number }, intensity: number): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const duration = 1.4;
    if (!this.canPlay(duration)) return;
    const t = this.now;
    const chain = this.makeChain(spatial);
    if (!chain) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.45;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2400, t);
    filter.frequency.exponentialRampToValueAtTime(90, t + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(spatial.gain * intensity * 1.4, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(chain.input);
    src.start(t, fxRng.range(0, 1));
    src.stop(t + duration);
  }

  private playFootstep(spatial: { gain: number; pan: number; cutoff: number }, running: boolean): void {
    if (!this.ctx || !this.shortNoise) return;
    if (!this.canPlay(0.14)) return;
    const t = this.now;
    const chain = this.makeChain(spatial);
    if (!chain) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.shortNoise;
    src.playbackRate.value = fxRng.range(0.55, 0.85);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = fxRng.range(420, 780);
    filter.Q.value = 1.1;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(spatial.gain * (running ? 0.65 : 0.4), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(chain.input);
    src.start(t);
    src.stop(t + 0.15);
  }

  private playImpact(spatial: { gain: number; pan: number; cutoff: number }, ricochet: boolean): void {
    if (!this.ctx || !this.shortNoise) return;
    if (!this.canPlay(ricochet ? 0.4 : 0.12)) return;
    const t = this.now;
    const chain = this.makeChain(spatial);
    if (!chain) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.shortNoise;
    src.playbackRate.value = fxRng.range(1.4, 2.4);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(spatial.gain * 0.55, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    src.connect(gain);
    gain.connect(chain.input);
    src.start(t);
    src.stop(t + 0.12);

    if (ricochet) {
      // The whine: a fast downward frequency sweep, the classic spall sound.
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      const start = fxRng.range(1600, 2600);
      osc.frequency.setValueAtTime(start, t);
      osc.frequency.exponentialRampToValueAtTime(start * 0.28, t + 0.32);
      const oscGain = this.ctx.createGain();
      oscGain.gain.setValueAtTime(spatial.gain * 0.16, t);
      oscGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      osc.connect(oscGain);
      oscGain.connect(chain.input);
      osc.start(t);
      osc.stop(t + 0.36);
    }
  }

  private playMechanical(spatial: { gain: number; pan: number; cutoff: number }, duration: number, freq: number): void {
    if (!this.ctx || !this.shortNoise) return;
    if (!this.canPlay(duration)) return;
    const t = this.now;
    const chain = this.makeChain(spatial);
    if (!chain) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.shortNoise;
    src.playbackRate.value = fxRng.range(1.0, 1.6);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 2.2;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(spatial.gain * 0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(chain.input);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  private playVoice(spatial: { gain: number; pan: number; cutoff: number }, baseFreq: number, duration: number): void {
    if (!this.ctx) return;
    if (!this.canPlay(duration)) return;
    const t = this.now;
    const chain = this.makeChain(spatial);
    if (!chain) return;

    // A pair of detuned saws through a formant-ish bandpass reads as a human
    // grunt without needing a voice actor.
    for (const detune of [0, 7]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(baseFreq * fxRng.range(0.9, 1.1), t);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.55, t + duration);
      osc.detune.value = detune;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 780;
      filter.Q.value = 3;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(spatial.gain * 0.3, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(chain.input);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    }
  }

  private playTone(
    spatial: { gain: number; pan: number; cutoff: number },
    freq: number,
    duration: number,
    type: OscillatorType,
    level: number,
    delay = 0,
  ): void {
    if (!this.ctx) return;
    if (!this.canPlay(duration + delay)) return;
    const t = this.now + delay;
    const chain = this.makeChain(spatial);
    if (!chain) return;

    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain);
    gain.connect(chain.input);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  /**
   * Temporary hearing loss after firing without a suppressor.
   * Recovers over a couple of seconds - long enough that spraying costs you
   * situational awareness, which is a real tactical trade.
   */
  applyMuzzleDeafness(amount: number): void {
    this.listener.deafness = clamp01(this.listener.deafness + amount);
  }

  update(dt: number): void {
    if (this.listener.deafness > 0) {
      this.listener.deafness = Math.max(0, this.listener.deafness - dt * 0.55);
    }
  }
}
