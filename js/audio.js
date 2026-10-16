/**
 * Tone engine: one shared AudioContext, any number of sine (or other) voices.
 *
 * Signal path:  voices -> master gain -> compressor (safety limiter) -> analyser -> speakers
 *
 * Why it looks like this:
 * - Browsers cap the number of AudioContexts, so we never create more than one.
 * - Every voice is scaled by 1/n so a 7-frequency chord does not clip.
 * - Starts and stops ramp the gain; jumping straight to/from full volume makes an audible click.
 */

const FADE_SECONDS = 0.08;

export class ToneEngine {
  constructor() {
    this.context = null;
    this.voices = [];
    this.volume = 0.35;
    this.waveform = "sine";
    this.binauralOffset = 0;
  }

  /** Creates the AudioContext lazily: browsers only allow it after a user gesture. */
  ensureContext() {
    if (this.context) {
      if (this.context.state === "suspended") this.context.resume();
      return this.context;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContextClass();

    this.master = this.context.createGain();
    this.master.gain.value = this.volume;

    this.limiter = this.context.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;

    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 2048;

    this.master.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    return this.context;
  }

  /** Highest frequency the current output can actually reproduce (Nyquist). */
  get maxFrequency() {
    return this.context ? this.context.sampleRate / 2 - 1 : 22049;
  }

  get isPlaying() {
    return this.voices.length > 0;
  }

  setVolume(volume) {
    this.volume = volume;
    if (this.master) this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.03);
  }

  setWaveform(waveform) {
    this.waveform = waveform;
    for (const voice of this.voices) voice.oscillator.type = waveform;
  }

  /** Binaural mode: left ear plays f, right ear plays f + offset. Needs headphones. */
  setBinauralOffset(offset) {
    this.binauralOffset = offset;
    if (this.isPlaying) this.play(this.currentFrequencies);
  }

  /** Replaces whatever is playing with the given frequencies, crossfading. */
  play(frequencies) {
    const context = this.ensureContext();
    this.fadeOutVoices();

    const playable = frequencies.filter((f) => f > 0 && f <= this.maxFrequency);
    this.currentFrequencies = playable;
    if (playable.length === 0) return playable;

    const now = context.currentTime;
    const channels = this.binauralOffset > 0 ? [-1, 1] : [0];
    const voiceGain = 1 / (playable.length * channels.length);

    for (const frequency of playable) {
      for (const pan of channels) {
        const oscillator = context.createOscillator();
        oscillator.type = this.waveform;
        oscillator.frequency.value = pan === 1 ? frequency + this.binauralOffset : frequency;

        const gain = context.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(voiceGain, now + FADE_SECONDS);

        const panner = context.createStereoPanner();
        panner.pan.value = pan;

        oscillator.connect(gain).connect(panner).connect(this.master);
        oscillator.start(now);
        this.voices.push({ oscillator, gain });
      }
    }
    return playable;
  }

  stop() {
    this.fadeOutVoices();
    this.currentFrequencies = [];
  }

  fadeOutVoices() {
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const { oscillator, gain } of this.voices) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + FADE_SECONDS);
      oscillator.stop(now + FADE_SECONDS + 0.02);
    }
    this.voices = [];
  }
}
