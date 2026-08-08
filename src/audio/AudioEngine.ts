import type { SoundKind } from '../core/GameEvents';
import { clamp01 } from '../core/Math2D';
import { fxRng } from '../core/Random';
import { spatialise, type ListenerState, type SpatialResult } from './Spatial';

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
   * Place a sound relative to the listener.
   *
   * The arithmetic lives in `audio/Spatial.ts` so it can be tested without an
   * `AudioContext` - it decides whether a player can locate a firefight, which
   * is far too important to be reachable only through a browser.
   */
  private spatialise(
    x: number,
    y: number,
    radius: number,
    occlusion: number,
  ): SpatialResult | null {
    return spatialise(this.listener, x, y, radius, occlusion);
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
        // `radius` is the weapon's loudness, which is how far the shot can be
        // heard - and that is set by the cartridge, so it doubles as calibre.
        this.playGunshot(spatial, intensity, false, radius);
        break;
      case 'suppressed':
        this.playGunshot(spatial, intensity, true, radius);
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
  /**
   * A gunshot, with its character taken from how loud the weapon is.
   *
   * Every firearm previously produced the same sound at a different volume,
   * which threw away most of what a shot can tell you. Loudness already tracks
   * cartridge size across the whole arsenal - a pistol is 22, a battle rifle
   * 63, the bolt action 78 - so it stands in for calibre without any new
   * plumbing, and a heavier weapon comes out slower, deeper and longer.
   *
   * The point is tactical, not decorative. Hearing that the contact two
   * courtyards away is carrying something big is a reason to leave, and a
   * reason the player can act on before they can see anything.
   */
  private playGunshot(
    spatial: { gain: number; pan: number; cutoff: number },
    intensity: number,
    suppressed: boolean,
    loudness = 45,
  ): void {
    if (!this.ctx || !this.noiseBuffer) return;

    // 0 at a pistol, 1 at the heaviest thing in the game.
    const heft = clamp01((loudness - 20) / 60);

    const duration = suppressed ? 0.16 : 0.42 + heft * 0.3;
    if (!this.canPlay(duration)) return;

    const t = this.now;
    const chain = this.makeChain(spatial);
    if (!chain) return;

    const level = spatial.gain * intensity * (suppressed ? 0.45 : 1);

    // --- body ---------------------------------------------------------------
    const body = this.ctx.createBufferSource();
    body.buffer = this.noiseBuffer;
    // Heavier weapons play the noise slower, which drops the whole report.
    body.playbackRate.value = fxRng.range(0.75, 0.95) * (1 - heft * 0.3);
    const bodyFilter = this.ctx.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.setValueAtTime(suppressed ? 900 : 3200 - heft * 1100, t);
    bodyFilter.frequency.exponentialRampToValueAtTime(180 - heft * 60, t + duration * 0.7);
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
      // The supersonic crack drops in pitch with the cartridge as well, so a
      // heavy round reads as a slap rather than a snap.
      crack.playbackRate.value = fxRng.range(1.4, 2.0) * (1 - heft * 0.28);
      const crackFilter = this.ctx.createBiquadFilter();
      crackFilter.type = 'highpass';
      crackFilter.frequency.value = 1800 - heft * 700;
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

  // =========================================================================
  // Weather ambience
  // =========================================================================

  /**
   * The continuous weather bed: rain and wind.
   *
   * Two looping noise sources rather than a sample, filtered differently -
   * rain is broadband hiss with the low end rolled off, wind is a slow-moving
   * low rumble. Both stay unspatialised, because weather has no direction.
   *
   * The bed is not just atmosphere. Rain is the reason the sound propagation
   * multiplier drops in wet weather: the player hears less, and so does
   * everyone hunting them.
   */
  private rainSource: AudioBufferSourceNode | null = null;
  private rainGain: GainNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windLfo: OscillatorNode | null = null;
  private wantRain = 0;
  private wantWind = 0;

  setAmbience(rain: number, wind: number): void {
    this.wantRain = clamp01(rain);
    this.wantWind = clamp01(wind);
    this.applyAmbience();
  }

  stopAmbience(): void {
    this.wantRain = 0;
    this.wantWind = 0;
    this.applyAmbience();
  }

  private applyAmbience(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noiseBuffer) return;
    const t = ctx.currentTime;

    if ((this.wantRain > 0 || this.wantWind > 0) && !this.rainSource) {
      // --- rain: broadband hiss, low end removed -------------------------
      const rainSrc = ctx.createBufferSource();
      rainSrc.buffer = this.noiseBuffer;
      rainSrc.loop = true;
      const rainHigh = ctx.createBiquadFilter();
      rainHigh.type = 'highpass';
      rainHigh.frequency.value = 900;
      const rainLow = ctx.createBiquadFilter();
      rainLow.type = 'lowpass';
      rainLow.frequency.value = 7000;
      const rainGain = ctx.createGain();
      rainGain.gain.value = 0;
      rainSrc.connect(rainHigh);
      rainHigh.connect(rainLow);
      rainLow.connect(rainGain);
      rainGain.connect(master);
      rainSrc.start();
      this.rainSource = rainSrc;
      this.rainGain = rainGain;

      // --- wind: slow low rumble, gain modulated by an LFO ---------------
      const windSrc = ctx.createBufferSource();
      windSrc.buffer = this.noiseBuffer;
      windSrc.loop = true;
      windSrc.playbackRate.value = 0.35;
      const windFilter = ctx.createBiquadFilter();
      windFilter.type = 'lowpass';
      windFilter.frequency.value = 340;
      const windGain = ctx.createGain();
      windGain.gain.value = 0;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.13;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.4;
      lfo.connect(lfoGain);
      lfoGain.connect(windGain.gain);
      windSrc.connect(windFilter);
      windFilter.connect(windGain);
      windGain.connect(master);
      windSrc.start();
      lfo.start();
      this.windSource = windSrc;
      this.windGain = windGain;
      this.windLfo = lfo;
    }

    if (this.rainGain) {
      this.rainGain.gain.setTargetAtTime(this.wantRain * 0.1, t, 1.2);
    }
    if (this.windGain) {
      this.windGain.gain.setTargetAtTime(this.wantWind * 0.075, t, 1.6);
    }

    if (this.wantRain === 0 && this.wantWind === 0 && this.rainSource) {
      // Let the ramps finish before tearing the graph down.
      const rainSrc = this.rainSource;
      const windSrc = this.windSource;
      const lfo = this.windLfo;
      this.rainSource = null;
      this.windSource = null;
      this.windLfo = null;
      this.rainGain = null;
      this.windGain = null;
      const stopAt = t + 2;
      try {
        rainSrc.stop(stopAt);
        windSrc?.stop(stopAt);
        lfo?.stop(stopAt);
      } catch {
        // Already stopped; nothing to do.
      }
    }
  }

  /**
   * Thunder, delayed to imply distance.
   *
   * The strike lights the map instantly and the sound arrives seconds later,
   * which is both correct and useful: the flash shows you the yard, and the
   * delay tells you how far off the storm is.
   */
  playThunder(): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuffer || !this.master) return;
    const delay = fxRng.range(0.6, 3.2);
    const duration = fxRng.range(2.2, 4);
    if (!this.canPlay(delay + duration)) return;
    const t = this.now + delay;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.28;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(700, t);
    filter.frequency.exponentialRampToValueAtTime(70, t + duration);
    const gain = ctx.createGain();
    // A slow swell rather than a hit: distant thunder rolls in.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + duration * 0.22);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    src.start(t, fxRng.range(0, 1));
    src.stop(t + duration);
  }

  update(dt: number): void {
    if (this.listener.deafness > 0) {
      this.listener.deafness = Math.max(0, this.listener.deafness - dt * 0.55);
    }
    // The bed may have been requested before the context existed - the first
    // raid can start in the same gesture that unlocks audio.
    if ((this.wantRain > 0 || this.wantWind > 0) && !this.rainSource) this.applyAmbience();
  }
}
