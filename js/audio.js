/**
 * Tone engine: one shared AudioContext, any number of tone voices, plus an optional
 * synthesised ambience bed (rain, ocean, wind, drone) to make sessions gentler.
 *
 * Signal path:
 *   voices -> tone bus (breathing) -+-> dry ------------+
 *                                   +-> reverb -> wet --+-> master -> limiter -> speakers
 *   ambience -> ambience gain ----------------------------+
 *   tone bus -> analyser (oscilloscope taps the tones only, so noise doesn't blur the wave)
 *
 * Why it looks like this:
 * - Browsers cap the number of AudioContexts, so we never create more than one.
 * - Every voice is scaled by 1/n so a 7-frequency chord does not clip.
 * - Starts and stops ramp the gain; jumping straight to/from full volume makes an audible click.
 * - Ambience is generated noise and oscillators, not audio files: nothing to download, works offline.
 */

const FADE_SECONDS = 0.08;
const AMBIENCE_FADE_SECONDS = 1.5;
const BREATH_HZ = 0.1; // one slow swell every 10 s, about six breaths a minute
const BREATH_DEPTH = 0.6; // tone dips to 40% at the bottom of each breath

export const AMBIENCES = {
  off: "Off",
  rain: "Rain",
  ocean: "Ocean waves",
  wind: "Wind",
  drone: "Deep drone",
};

export class ToneEngine {
  constructor() {
    this.context = null;
    this.voices = [];
    this.volume = 0.35;
    this.waveform = "sine";
    this.binauralOffset = 0;
    this.reverb = 0; // 0..1 wet mix
    this.breathing = false;
    this.ambience = "off";
    this.ambienceLevel = 0.5;
    this.ambienceNodes = null;
  }

  /** Creates the AudioContext lazily: browsers only allow it after a user gesture. */
  ensureContext() {
    if (this.context) {
      if (this.context.state === "suspended") this.context.resume().catch(() => {});
      return this.context;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.buildGraph(new AudioContextClass());
    return this.context;
  }

  /** Separate from ensureContext so tests can render the same graph in an OfflineAudioContext. */
  buildGraph(context) {
    this.context = context;

    this.master = context.createGain();
    this.master.gain.value = this.volume;

    this.limiter = context.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.master.connect(this.limiter).connect(context.destination);

    this.toneBus = context.createGain();
    this.dry = context.createGain();
    this.wet = context.createGain();
    this.convolver = context.createConvolver();
    this.convolver.buffer = createImpulseResponse(context, 3.5, 2.5);
    this.toneBus.connect(this.dry).connect(this.master);
    this.toneBus.connect(this.convolver).connect(this.wet).connect(this.master);

    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.toneBus.connect(this.analyser);

    // Breathing: a very slow LFO added to the tone bus gain.
    this.breathLfo = context.createOscillator();
    this.breathLfo.frequency.value = BREATH_HZ;
    this.breathDepth = context.createGain();
    this.breathDepth.gain.value = 0;
    this.breathLfo.connect(this.breathDepth).connect(this.toneBus.gain);
    this.breathLfo.start();

    this.ambienceGain = context.createGain();
    this.ambienceGain.gain.value = 0;
    this.ambienceGain.connect(this.master);

    this.applyReverb();
    this.applyBreathing();
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

  /** Room reverb on the tones: softens their edges and makes them feel less "test tone". */
  setReverb(amount) {
    this.reverb = amount;
    this.applyReverb();
  }

  applyReverb() {
    if (!this.context) return;
    const now = this.context.currentTime;
    // Equal-power crossfade keeps loudness steady as the mix changes.
    this.dry.gain.setTargetAtTime(Math.cos((this.reverb * Math.PI) / 2), now, 0.1);
    this.wet.gain.setTargetAtTime(Math.sin((this.reverb * Math.PI) / 2) * 1.5, now, 0.1);
  }

  setBreathing(enabled) {
    this.breathing = enabled;
    this.applyBreathing();
  }

  applyBreathing() {
    if (!this.context) return;
    const now = this.context.currentTime;
    const depth = this.breathing ? BREATH_DEPTH / 2 : 0;
    // Centre the swell below 1 so the peak never exceeds the normal level.
    this.toneBus.gain.setTargetAtTime(1 - depth, now, 0.5);
    this.breathDepth.gain.setTargetAtTime(depth, now, 0.5);
  }

  setAmbience(name) {
    this.ambience = name;
    if (this.isPlaying) this.startAmbience();
  }

  setAmbienceLevel(level) {
    this.ambienceLevel = level;
    if (this.ambienceNodes) this.ambienceGain.gain.setTargetAtTime(level, this.context.currentTime, 0.1);
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

        oscillator.connect(gain).connect(panner).connect(this.toneBus);
        oscillator.start(now);
        this.voices.push({ oscillator, gain });
      }
    }

    if (!this.ambienceNodes || this.ambienceNodes.name !== this.ambience) this.startAmbience();
    return playable;
  }

  stop() {
    this.fadeOutVoices();
    this.stopAmbience();
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

  /* ---------- Ambience ---------- */

  startAmbience() {
    this.stopAmbience();
    if (this.ambience === "off" || !this.context) return;

    const context = this.context;
    const now = context.currentTime;
    const output = context.createGain(); // per-bed gain so the old bed can fade while the new one rises
    output.gain.setValueAtTime(0, now);
    output.gain.linearRampToValueAtTime(1, now + AMBIENCE_FADE_SECONDS);
    output.connect(this.ambienceGain);
    this.ambienceGain.gain.setTargetAtTime(this.ambienceLevel, now, 0.1);

    const sources = AMBIENCE_BUILDERS[this.ambience](context, output);
    for (const source of sources) source.start(now);
    this.ambienceNodes = { name: this.ambience, output, sources };
  }

  stopAmbience() {
    if (!this.ambienceNodes) return;
    const { output, sources } = this.ambienceNodes;
    const now = this.context.currentTime;
    output.gain.cancelScheduledValues(now);
    output.gain.setValueAtTime(output.gain.value, now);
    output.gain.linearRampToValueAtTime(0, now + AMBIENCE_FADE_SECONDS);
    for (const source of sources) source.stop(now + AMBIENCE_FADE_SECONDS + 0.05);
    this.ambienceNodes = null;
  }
}

/* ---------- Synthesis helpers ---------- */

/** Decaying stereo noise: a cheap, convincing room reverb without loading an impulse file. */
function createImpulseResponse(context, seconds, decay) {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
    }
  }
  return buffer;
}

/**
 * Loopable noise buffer. "pink" falls off 3 dB/octave (rain, hiss), "brown" 6 dB/octave (surf, rumble).
 * Ten seconds, so it repeats a whole number of times in both the 20 s and 100 s player loops.
 */
function createNoiseBuffer(context, colour, seconds = 10) {
  const length = Math.floor(context.sampleRate * seconds);
  const blend = Math.floor(context.sampleRate * 0.5);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const output = buffer.getChannelData(channel);
    const data = new Float32Array(length + blend);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < length + blend; i++) {
      const white = Math.random() * 2 - 1;
      if (colour === "brown") {
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      } else if (colour === "pink") {
        // Paul Kellet's refined pink-noise filter.
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      } else {
        data[i] = white;
      }
    }
    // Generate half a second extra and fade it into the start, so the loop point has no step
    // (brown noise drifts, and a jump from its last sample back to its first is an audible click).
    output.set(data.subarray(0, length));
    for (let i = 0; i < blend; i++) {
      const t = i / blend;
      output[i] = data[i] * Math.sqrt(t) + data[length + i] * Math.sqrt(1 - t);
    }
  }
  return buffer;
}

function noiseSource(context, colour) {
  const source = context.createBufferSource();
  source.buffer = createNoiseBuffer(context, colour);
  source.loop = true;
  return source;
}

/** Slow oscillator that wobbles an AudioParam around its current value. */
function lfo(context, frequency, amount, target) {
  const oscillator = context.createOscillator();
  oscillator.frequency.value = frequency;
  const depth = context.createGain();
  depth.gain.value = amount;
  oscillator.connect(depth).connect(target);
  return oscillator;
}

function filter(context, type, frequency, q = 0.7) {
  const node = context.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  return node;
}

/**
 * Bed levels are tuned so that at the default 50% ambience the bed sits about 10 dB under a
 * single tone (measured RMS: tone ~0.19, bed ~0.05). Below that the bed was inaudible.
 *
 * Each builder wires its sources into `output` and returns everything that needs start()/stop(). */
const AMBIENCE_BUILDERS = {
  rain(context, output) {
    const noise = noiseSource(context, "pink");
    const highpass = filter(context, "highpass", 500);
    const lowpass = filter(context, "lowpass", 7000);
    const level = context.createGain();
    level.gain.value = 3.5;
    noise.connect(highpass).connect(lowpass).connect(level).connect(output);
    return [noise];
  },

  ocean(context, output) {
    const noise = noiseSource(context, "brown");
    const lowpass = filter(context, "lowpass", 600);
    const swell = context.createGain();
    swell.gain.value = 0.5;
    const level = context.createGain();
    level.gain.value = 3;
    noise.connect(lowpass).connect(swell).connect(level).connect(output);
    // Waves: volume and brightness rise and fall together every 10 seconds.
    const volumeWave = lfo(context, 0.1, 0.45, swell.gain);
    const brightnessWave = lfo(context, 0.1, 400, lowpass.frequency);
    return [noise, volumeWave, brightnessWave];
  },

  wind(context, output) {
    const noise = noiseSource(context, "pink");
    const bandpass = filter(context, "bandpass", 500, 1.2);
    const level = context.createGain();
    level.gain.value = 5;
    noise.connect(bandpass).connect(level).connect(output);
    // Two unrelated slow sweeps so the gusts never repeat in an obvious pattern.
    const gust = lfo(context, 0.05, 300, bandpass.frequency);
    const eddy = lfo(context, 0.15, 120, bandpass.frequency);
    const surge = lfo(context, 0.1, 1.8, level.gain);
    return [noise, gust, eddy, surge];
  },

  drone(context, output) {
    // A soft open fifth on A (55 / 82.5 / 110 Hz), slightly detuned so it shimmers. The detuned
    // pitches are written out as multiples of 0.05 Hz (not cents) so the player's 20 s loop closes.
    const lowpass = filter(context, "lowpass", 400);
    const level = context.createGain();
    level.gain.value = 0.5;
    lowpass.connect(level).connect(output);
    const sources = [];
    for (const frequency of [54.9, 82.6, 110.15, 109.8]) {
      const oscillator = context.createOscillator();
      oscillator.type = "triangle";
      oscillator.frequency.value = frequency;
      oscillator.connect(lowpass);
      sources.push(oscillator);
    }
    sources.push(lfo(context, 0.05, 150, lowpass.frequency));
    return sources;
  },
};
