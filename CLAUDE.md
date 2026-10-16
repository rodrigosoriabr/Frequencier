# Frequencier

Static PWA, no build, no dependencies. Code and comments in English (en-GB UI copy).

- Run locally: `python3 -m http.server 8000` (ES modules don't load from `file://`).
- Phone testing over Tailscale: **https://rodrigos-mac-studio.tail763e49.ts.net:8443** — launchd agent
  `eu.rodrigosoria.frequencier` (plist + server in `tools/local-server/`). It serves a *copy* in
  `~/Library/Application Support/Frequencier/site`, because launchd jobs can't read `/Volumes/Work` (macOS TCC).
  **After any change, run `tools/local-server/publish.sh`** or the phone keeps showing the old version.
  Logs: `~/Library/Application Support/Frequencier/logs/`. Restart: `launchctl kickstart -k gui/$(id -u)/eu.rodrigosoria.frequencier`.
- Bump `CACHE` in `sw.js` when shipping, so installed PWAs drop the old cache.
- Never serve the repo folder itself: it exposed `.git` and the TLS key on 16/10/2026.
- Audio claims: tones are exact (measured), therapeutic effect is not proven — keep the footer disclaimer.
- Playback architecture: Web Audio renders offline (`js/player.js` → `renderLoop`), `<audio loop>` plays. Anything new
  in `audio.js` (LFO, noise length, detune) must complete whole cycles in **20 s** (multiples of 0.05 Hz) or the loop
  clicks — cents-based detune broke the drone seam on 16/10/2026. Seam test: render, compare `|x[0]-x[L-1]|` to the
  largest in-loop step.
