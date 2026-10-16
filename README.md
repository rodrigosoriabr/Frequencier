# Frequencier

Play frequency sets in the browser: 439 Rife-style programmes, your own frequencies, sequences, timers and binaural beats. No build step, no dependencies, works offline once loaded.

> **Not medical advice.** There is no scientific evidence that audio frequencies treat disease. Keep the volume low and see a doctor for anything that worries you.

## Features

- **Library** of 439 sets with instant search (by name or by Hz), filters by source, and ★ favourites.
- **Two play modes**: all frequencies together, or one at a time (30 s – 5 min each, looping) the way Rife programmes are usually run.
- **Session timer** that fades out on its own (5 min – 12 h, or infinite).
- **Waveform** (sine, triangle, square, sawtooth) and **binaural beat** offset (delta, theta, Schumann, alpha — use headphones).
- **Your own frequencies**: type `396, 528, 852`, play, save as a preset, or share a link (`#f=396,528,852`, `#set=Abdominal Pain`).
- **Ambience** to soften sessions, all synthesised in the browser (no audio files): rain, ocean waves, wind or a deep drone, with its own level; **room echo** (reverb) on the tones; and **breathing**, a slow 10 s swell that paces relaxed breathing.
- **Live oscilloscope**, lock-screen controls (Media Session), screen kept awake during a session, light and dark themes, keyboard shortcuts (`Space`, `↑ ↓`, `← →`, `/`, `F`).
- **Installable PWA** that works offline.

## Run locally

Any static server works; the app uses ES modules, so opening the file directly with `file://` will not.

```bash
git clone https://github.com/rodrigosoriabr/Frequencier.git
cd Frequencier
python3 -m http.server 8000
# open http://localhost:8000
```

## Project layout

| Path | What it does |
| --- | --- |
| `index.html` | Page structure |
| `css/app.css` | All styles; colour tokens at the top, dark and light themes |
| `js/app.js` | UI state, list rendering, player logic, keyboard, sharing |
| `js/audio.js` | Tone engine: one AudioContext, gain-scaled voices, click-free fades, limiter, reverb, breathing LFO, synthesised ambience beds |
| `js/library.js` | Database loading, favourites/presets storage, frequency parsing |
| `js/visualizer.js` | Oscilloscope canvas |
| `sw.js` | Offline cache (network first) |
| `database/frequencies.json` | The library: `{ name, frequencies[], source }` |

## Adding frequencies

Append to `database/frequencies.json`:

```json
{ "name": "Example", "frequencies": [396, 528], "source": "CUST" }
```

Sources: `CAFL` (Consolidated Annotated Frequency List), `XTRA`, `KHZ`, `BIO`, `VEGA`, `CUST`, `PROV`, `ODD` — descriptions live in `js/library.js`.

## Notes on audio

- Each voice is scaled by `1/n` and the master runs through a compressor, so large chords don't clip.
- Frequencies above the device's Nyquist limit (usually 22–24 kHz) are skipped with a notice. Tones under 20 Hz or above ~16 kHz may be inaudible on phone and laptop speakers.

## License

MIT.

## Testing on a phone (maintainer)

`tools/local-server/` holds a launchd agent that serves the site over HTTPS on the tailnet. Run `tools/local-server/publish.sh` after changes. See `CLAUDE.md`.
