/**
 * Background-safe playback, gapless in the foreground.
 *
 * Two ways to make sound, and we hand over between them:
 * - Foreground: the live ToneEngine (Web Audio). Gapless, instant setting changes, real fades.
 * - Phone screen locked / tab hidden: iOS suspends Web Audio but keeps an <audio> element playing
 *   (that is how web music players survive the lock screen). So the same ToneEngine graph renders
 *   a loop offline into a WAV and a plain <audio loop> element plays it.
 * Media elements are not sample-accurate at the loop point (a short cut every lap, very audible in
 * Chrome), which is why the <audio> path is only used while hidden, and only on touch devices:
 * desktop browsers keep Web Audio running in background tabs.
 *
 * Seamless loops: every tone and every slow modulation completes a whole number of cycles in
 * the loop length, and the render starts with a warm-up (reverb tail, fades, limiter) that is
 * cut off. The extracted segment is therefore exactly periodic and loops without a click.
 * - 20 s loop when every frequency is a multiple of 0.05 Hz (all whole-number sets);
 * - 100 s loop otherwise, with frequencies rounded to 0.01 Hz (the database never goes finer).
 * Ambience/breathing LFOs and noise buffers in audio.js are chosen to fit both lengths.
 */

import { ToneEngine } from "./audio.js";

const HAND_OVER_IN_BACKGROUND = matchMedia("(pointer: coarse)").matches;

export const SAMPLE_RATE = 44100;
export const MAX_FREQUENCY = SAMPLE_RATE / 2 - 1;

const WARM_UP_SECONDS = 4;
const CACHE_LIMIT = 12; // ~3.5 MB per 20 s loop

const isWhole = (value) => Math.abs(value - Math.round(value)) < 1e-6;

function loopPlan(frequencies, binauralOffset) {
  const tones = frequencies.flatMap((f) => (binauralOffset > 0 ? [f, f + binauralOffset] : [f]));
  if (tones.every((f) => isWhole(f * 20))) return { seconds: 20, frequencies, binauralOffset };
  const round = (f) => Math.round(f * 100) / 100;
  return { seconds: 100, frequencies: frequencies.map(round), binauralOffset: round(binauralOffset) };
}

/** Renders one seamless loop for the given sound settings and returns it as a WAV Blob. */
export async function renderLoop(options) {
  const plan = loopPlan(options.frequencies, options.binauralOffset);
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const context = new OfflineContext(2, Math.round((WARM_UP_SECONDS + plan.seconds) * SAMPLE_RATE), SAMPLE_RATE);

  const engine = new ToneEngine();
  Object.assign(engine, {
    volume: options.volume,
    waveform: options.waveform,
    binauralOffset: plan.binauralOffset,
    reverb: options.reverb,
    breathing: options.breathing,
    ambience: options.ambience,
    ambienceLevel: options.ambienceLevel,
  });
  engine.buildGraph(context);
  engine.play(plan.frequencies);

  const rendered = await context.startRendering();
  return encodeWav(rendered, Math.round(WARM_UP_SECONDS * SAMPLE_RATE), Math.round(plan.seconds * SAMPLE_RATE));
}

/** 16-bit PCM stereo WAV of `length` frames starting at `start`. */
function encodeWav(buffer, start, length) {
  const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
  const bytes = new ArrayBuffer(44 + length * 4);
  const view = new DataView(bytes);
  const writeText = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));

  writeText(0, "RIFF");
  view.setUint32(4, 36 + length * 4, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 4, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeText(36, "data");
  view.setUint32(40, length * 4, true);

  let offset = 44;
  for (let i = start; i < start + length; i++) {
    for (const data of channels) {
      const sample = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}

/** A tenth of a second of silence, used to unlock the <audio> element inside a tap. */
function silentWavUrl() {
  const frames = SAMPLE_RATE / 10;
  const context = { sampleRate: SAMPLE_RATE, getChannelData: () => new Float32Array(frames) };
  return URL.createObjectURL(encodeWav(context, 0, frames));
}

export class LoopPlayer {
  constructor() {
    this.engine = new ToneEngine();
    this.audio = new Audio();
    this.audio.loop = true;
    this.audio.preload = "auto";
    this.audio.setAttribute("playsinline", "");
    this.cache = new Map(); // options key -> Promise<objectURL>
    this.settings = {};
    this.currentFrequencies = [];
    this.playing = false;
    this.mode = "live"; // "live" (Web Audio) or "media" (<audio> loop)
    this.liveStartedAt = 0;
    this.request = 0;
    this.silentUrl = silentWavUrl();
    this.onerror = null;
    document.addEventListener("visibilitychange", () => this.onVisibilityChange());
  }

  get isPlaying() {
    return this.playing;
  }

  /** Seconds since the current tones started, for the oscilloscope. */
  get time() {
    if (this.mode === "media") return this.audio.currentTime || 0;
    return this.engine.context ? this.engine.context.currentTime - this.liveStartedAt : 0;
  }

  /**
   * Must run synchronously inside the tap/click. It resumes the AudioContext and starts the
   * <audio> element on a silent loop: iOS only lets media start during a user gesture, and an
   * element that is already playing may later switch source from the background. The silent
   * element also puts iOS in "playback" mode, so Web Audio is heard even with the mute switch on.
   */
  prime() {
    this.engine.ensureContext();
    if (this.audio.paused) {
      this.audio.src = this.silentUrl;
      this.audio.play().catch(() => {});
    }
  }

  keyFor(frequencies) {
    return JSON.stringify({ ...this.settings, frequencies });
  }

  render(frequencies) {
    const key = this.keyFor(frequencies);
    if (!this.cache.has(key)) {
      const url = renderLoop({ ...this.settings, frequencies }).then((blob) => URL.createObjectURL(blob));
      this.cache.set(key, url);
      url.catch(() => this.cache.delete(key));
      this.trimCache();
    }
    return this.cache.get(key);
  }

  trimCache() {
    while (this.cache.size > CACHE_LIMIT) {
      const [oldestKey, oldestUrl] = this.cache.entries().next().value;
      this.cache.delete(oldestKey);
      oldestUrl.then((url) => url !== this.audio.src && URL.revokeObjectURL(url)).catch(() => {});
    }
  }

  /** Renders ahead so a step change on a locked phone is just a source swap. */
  async prerender(list) {
    if (!HAND_OVER_IN_BACKGROUND) return;
    for (const frequencies of list) {
      try {
        await this.render(frequencies);
      } catch {}
    }
  }

  play(frequencies) {
    this.request++;
    this.playing = true;
    this.currentFrequencies = frequencies;
    if (this.mode === "media") return this.playMedia(frequencies, 0);
    this.playLive(frequencies);
    if (HAND_OVER_IN_BACKGROUND) this.render(frequencies).catch(() => {}); // ready for when the screen locks
  }

  playLive(frequencies) {
    const engine = this.engine;
    engine.ensureContext();
    engine.setVolume(this.settings.volume);
    engine.setWaveform(this.settings.waveform);
    engine.setReverb(this.settings.reverb);
    engine.setBreathing(this.settings.breathing);
    engine.binauralOffset = this.settings.binauralOffset;
    engine.ambience = this.settings.ambience;
    engine.ambienceLevel = this.settings.ambienceLevel;
    engine.play(frequencies);
    this.liveStartedAt = engine.context.currentTime;
  }

  async playMedia(frequencies, position) {
    const request = this.request;
    let url;
    try {
      url = await this.render(frequencies);
    } catch (error) {
      this.onerror?.(error);
      return;
    }
    if (request !== this.request) return; // a newer play/stop happened while rendering

    this.audio.src = url;
    if (position > 0) {
      this.audio.addEventListener("loadedmetadata", () => (this.audio.currentTime = position % this.audio.duration), {
        once: true,
      });
    }
    this.audio.play().catch((error) => this.onerror?.(error));
  }

  stop() {
    this.request++;
    this.playing = false;
    this.currentFrequencies = [];
    this.mode = "live";
    this.engine.stop();
    this.audio.pause();
  }

  onVisibilityChange() {
    if (!this.playing || !HAND_OVER_IN_BACKGROUND) return;
    if (document.hidden && this.mode === "live") {
      // Start the loop where the live tones are, so the hand-over doesn't jump phase.
      // The rendered loop begins WARM_UP_SECONDS after its tones started.
      const position = Math.max(0, this.time - WARM_UP_SECONDS);
      this.mode = "media";
      this.request++;
      this.playMedia(this.currentFrequencies, position).then(() => {
        if (this.mode === "media") this.engine.stop(); // unless the page came back meanwhile
      });
    } else if (!document.hidden && this.mode === "media") {
      this.mode = "live";
      this.request++;
      this.playLive(this.currentFrequencies);
      this.audio.src = this.silentUrl;
      this.audio.play().catch(() => {});
    }
  }

  /** New sound settings: applied live at once; background loops are re-rendered for later. */
  updateSettings(patch) {
    const before = { ...this.settings };
    Object.assign(this.settings, patch);
    const settings = this.settings;

    if (this.playing && this.mode === "live") {
      const engine = this.engine;
      engine.setVolume(settings.volume);
      engine.setWaveform(settings.waveform);
      engine.setReverb(settings.reverb);
      engine.setBreathing(settings.breathing);
      engine.setAmbienceLevel(settings.ambienceLevel);
      if (settings.ambience !== before.ambience) engine.setAmbience(settings.ambience);
      if (settings.binauralOffset !== before.binauralOffset) engine.setBinauralOffset(settings.binauralOffset);
    }

    clearTimeout(this.rerenderTimer);
    if (!this.playing || !HAND_OVER_IN_BACKGROUND) return;
    // Debounced so dragging a slider doesn't render dozens of loops.
    this.rerenderTimer = setTimeout(() => {
      for (const [, url] of this.cache) url.then((u) => u !== this.audio.src && URL.revokeObjectURL(u)).catch(() => {});
      this.cache.clear();
      this.render(this.currentFrequencies).catch(() => {});
      this.onsettingschange?.();
    }, 350);
  }
}
