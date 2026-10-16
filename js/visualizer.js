/**
 * Oscilloscope drawn from the engine's AnalyserNode. Draws a flat line when idle and
 * pauses the animation loop while the tab is hidden (requestAnimationFrame does that for us).
 */

export function startVisualizer(canvas, engine) {
  const context = canvas.getContext("2d");
  let samples = new Float32Array(2048);

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

    if (engine.analyser && engine.isPlaying) {
      if (samples.length !== engine.analyser.fftSize) samples = new Float32Array(engine.analyser.fftSize);
      engine.analyser.getFloatTimeDomainData(samples);

      // Show about six cycles of the lowest tone so both 95 Hz and 10 kHz read as waves.
      const lowest = Math.min(...(engine.currentFrequencies || [440]));
      const visible = Math.round(Math.min(samples.length, Math.max(48, (engine.context.sampleRate * 6) / lowest)));
      const gain = 0.9 / Math.max(engine.volume, 0.05);

      context.strokeStyle = style.getPropertyValue("--wave").trim();
      context.lineWidth = 2 * (window.devicePixelRatio || 1);
      context.lineJoin = "round";
      context.beginPath();
      for (let i = 0; i < visible; i++) {
        const x = (i / (visible - 1)) * width;
        const y = height / 2 - samples[i] * gain * (height / 2) * 0.9;
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.stroke();
    }
    requestAnimationFrame(draw);
  }

  new ResizeObserver(resize).observe(canvas);
  resize();
  requestAnimationFrame(draw);
}
