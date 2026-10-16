/**
 * Oscilloscope. Playback now goes through an <audio> element (see player.js), and routing that
 * back into Web Audio to analyse it would bring back the iOS background suspension we avoid.
 * So the wave is computed from what is playing: the same frequencies, waveform and breathing
 * swell, advanced by the element's clock. requestAnimationFrame pauses while the tab is hidden.
 */

const SHAPES = {
  sine: (phase) => Math.sin(2 * Math.PI * phase),
  triangle: (phase) => 1 - 4 * Math.abs(Math.round(phase - 0.25) - (phase - 0.25)),
  square: (phase) => (phase % 1 < 0.5 ? 1 : -1),
  sawtooth: (phase) => 2 * (phase - Math.floor(phase + 0.5)),
};
const POINTS = 400;
const CYCLES_SHOWN = 6;

export function startVisualizer(canvas, player) {
  const context = canvas.getContext("2d");

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
  }

  function draw() {
    const { width, height } = canvas;
    const style = getComputedStyle(canvas);
    context.clearRect(0, 0, width, height);

    // Midline.
    context.strokeStyle = style.getPropertyValue("--grid").trim();
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.stroke();

    const frequencies = player.currentFrequencies;
    if (player.isPlaying && !player.audio.paused && frequencies.length) {
      const shape = SHAPES[player.settings.waveform] || SHAPES.sine;
      const start = player.time;
      // Show about six cycles of the lowest tone so both 95 Hz and 10 kHz read as waves.
      const span = CYCLES_SHOWN / Math.min(...frequencies);
      const swell = player.settings.breathing ? 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.1 * start) : 1;

      context.strokeStyle = style.getPropertyValue("--wave").trim();
      context.lineWidth = 2 * (window.devicePixelRatio || 1);
      context.lineJoin = "round";
      context.beginPath();
      for (let i = 0; i < POINTS; i++) {
        const t = start + (i / (POINTS - 1)) * span;
        let sample = 0;
        for (const f of frequencies) sample += shape(f * t);
        const y = height / 2 - (sample / frequencies.length) * swell * (height / 2) * 0.8;
        if (i === 0) context.moveTo((i / (POINTS - 1)) * width, y);
        else context.lineTo((i / (POINTS - 1)) * width, y);
      }
      context.stroke();
    }
    requestAnimationFrame(draw);
  }

  new ResizeObserver(resize).observe(canvas);
  resize();
  requestAnimationFrame(draw);
}
