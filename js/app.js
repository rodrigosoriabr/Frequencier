/**
 * Frequencier UI: wires the library list, the player and the settings together.
 * No framework: the list is re-rendered from state whenever the filter or search changes.
 */

import { AMBIENCES } from "./audio.js";
import { LoopPlayer, MAX_FREQUENCY } from "./player.js";
import { startVisualizer } from "./visualizer.js";
import {
  SOURCES,
  formatHz,
  loadDatabase,
  loadFavourites,
  loadPresets,
  parseFrequencies,
  saveFavourites,
  savePresets,
} from "./library.js";

const SETTINGS_KEY = "frequencier.settings";
const TICK_MS = 250;

const $ = (selector) => document.querySelector(selector);
const player = new LoopPlayer();

const state = {
  library: [], // [{id, name, frequencies, source}]
  presets: loadPresets(), // [{name, frequencies}]
  favourites: loadFavourites(), // Set of library item names
  filter: "all",
  query: "",
  visible: [], // items currently shown in the list, in order
  current: null, // the selected item
  playing: false,
  stepIndex: 0,
  sessionStartedAt: 0,
  stepStartedAt: 0,
  settings: {
    mode: "together",
    stepSeconds: 180,
    timerMinutes: 15,
    waveform: "sine",
    binaural: 0,
    volume: 35,
    ambience: "off",
    ambienceLevel: 50,
    reverb: 25,
    breathing: false,
    theme: null,
    ...readSettings(),
  },
};

let wakeLock = null;

/* ---------- Settings ---------- */

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}

function writeSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {}
}

function applySettingsToControls() {
  const { settings } = state;
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-checked", String(button.dataset.mode === settings.mode));
  }
  $("#stepField").hidden = settings.mode !== "sequence";
  $("#stepSelect").value = String(settings.stepSeconds);
  $("#timerSelect").value = String(settings.timerMinutes);
  $("#waveSelect").value = settings.waveform;
  $("#binauralSelect").value = String(settings.binaural);
  $("#volumeRange").value = String(settings.volume);
  $("#volumeOutput").textContent = `${settings.volume}%`;
  if (settings.theme) document.documentElement.dataset.theme = settings.theme;
  $("#ambienceRange").value = String(settings.ambienceLevel);
  $("#ambienceOutput").textContent = `${settings.ambienceLevel}%`;
  $("#reverbRange").value = String(settings.reverb);
  $("#reverbOutput").textContent = `${settings.reverb}%`;
  $("#breathingToggle").checked = settings.breathing;
  renderAmbienceChips();

  player.settings = soundSettings();
}

/** The settings that change the rendered audio (everything else is UI or session timing). */
function soundSettings() {
  const { settings } = state;
  return {
    volume: volumeToGain(settings.volume),
    waveform: settings.waveform,
    binauralOffset: Number(settings.binaural),
    ambience: settings.ambience,
    ambienceLevel: volumeToGain(settings.ambienceLevel),
    reverb: settings.reverb / 100,
    breathing: settings.breathing,
  };
}

function soundSettingsChanged() {
  player.updateSettings(soundSettings());
}

function renderAmbienceChips() {
  $("#ambienceChips").innerHTML = Object.entries(AMBIENCES)
    .map(
      ([value, label]) =>
        `<button type="button" class="chip" role="radio" data-ambience="${value}" aria-checked="${state.settings.ambience === value}">${label}</button>`,
    )
    .join("");
}

/** Perceived loudness is logarithmic, so square the slider value for a natural feel. */
function volumeToGain(percent) {
  return (percent / 100) ** 2;
}

/* ---------- Library list ---------- */

function normalise(text) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function presetItems() {
  return state.presets.map((preset, index) => ({
    id: `preset-${index}`,
    name: preset.name,
    frequencies: preset.frequencies,
    source: "MINE",
    presetIndex: index,
  }));
}

function computeVisible() {
  const { filter } = state;
  let items;
  if (filter === "mine") items = presetItems();
  else if (filter === "favourites") items = state.library.filter((item) => state.favourites.has(item.name));
  else if (filter === "all") items = [...presetItems(), ...state.library];
  else items = state.library.filter((item) => item.source === filter);

  const query = normalise(state.query.trim());
  if (query) {
    const numeric = /^\d/.test(query);
    items = items.filter((item) =>
      numeric
        ? item.frequencies.some((f) => String(f).startsWith(query))
        : normalise(item.name).includes(query),
    );
  }

  // Favourites float to the top of the full list, like the original app did.
  if (filter === "all") {
    items.sort((a, b) => Number(state.favourites.has(b.name)) - Number(state.favourites.has(a.name)));
  }
  return items;
}

function highlight(name) {
  const query = state.query.trim();
  if (!query || /^\d/.test(query)) return escapeHtml(name);
  const index = normalise(name).indexOf(normalise(query));
  if (index < 0) return escapeHtml(name);
  return (
    escapeHtml(name.slice(0, index)) +
    `<mark>${escapeHtml(name.slice(index, index + query.length))}</mark>` +
    escapeHtml(name.slice(index + query.length))
  );
}

function renderChips() {
  const sourceCounts = {};
  for (const item of state.library) sourceCounts[item.source] = (sourceCounts[item.source] || 0) + 1;

  const chips = [
    ["all", "All"],
    ["favourites", `★ Favourites ${state.favourites.size || ""}`],
    ["mine", `My presets ${state.presets.length || ""}`],
    ...Object.keys(sourceCounts)
      .sort((a, b) => sourceCounts[b] - sourceCounts[a])
      .map((code) => [code, code]),
  ];

  $("#filterChips").innerHTML = chips
    .map(
      ([value, label]) =>
        `<button type="button" class="chip" data-filter="${value}" aria-pressed="${state.filter === value}"` +
        (SOURCES[value] ? ` title="${escapeHtml(SOURCES[value])}"` : "") +
        `>${escapeHtml(label.trim())}</button>`,
    )
    .join("");
}

function renderList() {
  state.visible = computeVisible();
  const currentId = state.current?.id;

  $("#list").innerHTML = state.visible
    .map((item) => {
      const isCurrent = item.id === currentId;
      const isFavourite = state.favourites.has(item.name);
      const action =
        item.source === "MINE"
          ? `<button type="button" class="row-action" data-delete="${item.presetIndex}" aria-label="Delete preset ${escapeHtml(item.name)}" title="Delete preset">×</button>`
          : `<button type="button" class="row-action star" data-favourite="${escapeHtml(item.name)}" aria-pressed="${isFavourite}" aria-label="${isFavourite ? "Remove from" : "Add to"} favourites" title="Favourite">${isFavourite ? "★" : "☆"}</button>`;
      return `
        <li class="row" role="option" id="${item.id}" data-id="${item.id}" aria-selected="${isCurrent}"
            ${isCurrent && state.playing ? 'data-playing="true"' : ""}>
          ${action}
          <div class="row-main">
            <span class="row-name">${highlight(item.name)}</span>
            <span class="row-hz">${item.frequencies.map(formatHz).join(" · ")}</span>
          </div>
          <span class="badge" title="${escapeHtml(SOURCES[item.source] || "Your preset")}">${item.source}</span>
          <span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>
        </li>`;
    })
    .join("");

  $("#resultCount").textContent = state.visible.length;
  const empty = $("#emptyState");
  empty.hidden = state.visible.length > 0;
  if (state.visible.length === 0) {
    empty.textContent =
      state.filter === "favourites"
        ? "No favourites yet. Tap ☆ next to any set."
        : state.filter === "mine"
          ? "No presets yet. Type frequencies in the player and choose “Save as preset”."
          : `Nothing matches “${state.query}”.`;
  }
}

/* ---------- Player ---------- */

function findItem(id) {
  return state.library.find((item) => item.id === id) || presetItems().find((item) => item.id === id);
}

function select(item, { autoplay = false, scroll = false } = {}) {
  state.current = item;
  state.stepIndex = 0;
  $("#playButton").disabled = !item;
  renderNowPlaying();
  renderList();
  if (scroll && item) document.getElementById(item.id)?.scrollIntoView({ block: "nearest" });
  if (autoplay || state.playing) start();
}

function playableFrequencies() {
  return (state.current?.frequencies || []).filter((f) => f <= MAX_FREQUENCY);
}

function start() {
  const frequencies = playableFrequencies();
  if (frequencies.length === 0) {
    toast(state.current ? "These frequencies are above what your device can play." : "Pick a set first.");
    return;
  }

  player.prime(); // must happen inside the tap, before any await
  const now = Date.now();
  state.playing = true;
  state.sessionStartedAt = now;
  state.stepStartedAt = now;
  state.stepIndex = Math.min(state.stepIndex, frequencies.length - 1);
  playCurrentStep();

  if (frequencies.length < state.current.frequencies.length) {
    toast("Some frequencies are above your device's range and were skipped.");
  }
  requestWakeLock();
  updateMediaSession();
  renderList();
}

function playCurrentStep() {
  const frequencies = playableFrequencies();
  const sequence = state.settings.mode === "sequence" && frequencies.length > 1;
  player.play(sequence ? [frequencies[state.stepIndex]] : frequencies);
  renderNowPlaying();
  // Render the other steps now, while the page is in the foreground, so step changes on a
  // locked phone are only a source swap.
  if (sequence) player.prerender(frequencies.map((f) => [f]));
}

function stop(message) {
  player.stop();
  state.playing = false;
  state.stepIndex = 0;
  releaseWakeLock();
  renderNowPlaying();
  renderList();
  if (message) toast(message);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
}

function togglePlay() {
  if (state.playing) stop();
  else if (state.current) start();
}

function isSequencing() {
  return state.settings.mode === "sequence" && playableFrequencies().length > 1;
}

/** Previous/next walks the steps of a sequence; otherwise it moves through the list. */
function skip(direction) {
  if (state.playing && isSequencing()) {
    const count = playableFrequencies().length;
    state.stepIndex = (state.stepIndex + direction + count) % count;
    state.stepStartedAt = Date.now();
    playCurrentStep();
    return;
  }
  moveSelection(direction);
}

function moveSelection(direction) {
  if (state.visible.length === 0) return;
  const index = state.visible.findIndex((item) => item.id === state.current?.id);
  const next = index < 0 ? 0 : (index + direction + state.visible.length) % state.visible.length;
  select(state.visible[next], { scroll: true });
}

function tick() {
  if (!state.playing) return;
  const now = Date.now();
  const elapsed = (now - state.sessionStartedAt) / 1000;
  const timerSeconds = state.settings.timerMinutes * 60;

  if (timerSeconds && elapsed >= timerSeconds) {
    stop("Session finished.");
    return;
  }

  if (isSequencing() && (now - state.stepStartedAt) / 1000 >= state.settings.stepSeconds) {
    state.stepIndex = (state.stepIndex + 1) % playableFrequencies().length;
    state.stepStartedAt = now;
    playCurrentStep();
  }
  renderProgress(elapsed, timerSeconds);
}

function formatClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

function renderProgress(elapsed, timerSeconds) {
  $("#elapsed").textContent = formatClock(elapsed);
  $("#remaining").textContent = timerSeconds ? `−${formatClock(timerSeconds - elapsed)}` : "∞";
  const fraction = timerSeconds ? elapsed / timerSeconds : 0;
  $("#progressFill").style.transform = `scaleX(${Math.min(1, fraction)})`;
}

function renderNowPlaying() {
  const item = state.current;
  const playButton = $("#playButton");
  playButton.dataset.playing = String(state.playing);
  playButton.setAttribute("aria-label", state.playing ? "Stop" : "Play");
  document.body.dataset.playing = String(state.playing);

  if (!item) return;

  $("#miniTitle").textContent = item.name;

  const playable = playableFrequencies();
  const sequencing = isSequencing();
  $("#nowTitle").textContent = item.name;
  $("#nowStatus").textContent = state.playing
    ? sequencing
      ? `Playing · step ${state.stepIndex + 1} of ${playable.length}`
      : `Playing · ${playable.length} tone${playable.length > 1 ? "s" : ""} together`
    : SOURCES[item.source] || (item.source === "MINE" ? "Your preset" : "Custom");

  $("#nowHz").textContent =
    state.playing && sequencing
      ? formatHz(playable[state.stepIndex])
      : item.frequencies.length === 1
        ? formatHz(item.frequencies[0])
        : `${item.frequencies.length} frequencies`;

  $("#steps").innerHTML = item.frequencies
    .map((frequency) => {
      const index = playable.indexOf(frequency);
      const active = state.playing && (!sequencing || index === state.stepIndex) && index >= 0;
      const note = frequency > MAX_FREQUENCY ? "above your device's range" : frequency < 20 ? "below hearing range" : "";
      return `<li class="step" data-active="${active}" ${note ? `data-note="${note}" title="${note}"` : ""}>${formatHz(frequency)}</li>`;
    })
    .join("");

  $("#miniHz").textContent = $("#nowHz").textContent;

  if (!state.playing) {
    $("#elapsed").textContent = "0:00";
    $("#remaining").textContent = state.settings.timerMinutes ? formatClock(state.settings.timerMinutes * 60) : "∞";
    $("#progressFill").style.transform = "scaleX(0)";
  }
}

/* ---------- Custom frequencies, presets, sharing ---------- */

function customItem(frequencies, name) {
  return { id: "custom", name: name || frequencies.map(formatHz).join(" + "), frequencies, source: "CUSTOM" };
}

function frequenciesFromInputOrCurrent() {
  const typed = parseFrequencies($("#customInput").value);
  return typed.length ? typed : state.current?.frequencies || [];
}

function openPresetDialog() {
  const frequencies = frequenciesFromInputOrCurrent();
  if (frequencies.length === 0) {
    toast("Type some frequencies first.");
    $("#customInput").focus();
    return;
  }
  const dialog = $("#presetDialog");
  $("#presetName").value = state.current?.id === "custom" || !state.current ? "" : `${state.current.name} (mine)`;
  $("#presetPreview").textContent = frequencies.map(formatHz).join(" · ");
  dialog.returnValue = "";
  dialog.showModal();
  dialog.onclose = () => {
    if (dialog.returnValue !== "save") return;
    const name = $("#presetName").value.trim() || frequencies.map(formatHz).join(" + ");
    state.presets.push({ name, frequencies });
    savePresets(state.presets);
    renderChips();
    renderList();
    toast(`Saved “${name}” to My presets.`);
  };
}

function deletePreset(index) {
  const [removed] = state.presets.splice(index, 1);
  savePresets(state.presets);
  if (state.current?.source === "MINE") state.current = customItem(removed.frequencies, removed.name);
  renderChips();
  renderList();
  toast(`Deleted “${removed.name}”.`);
}

function shareUrl() {
  const item = state.current;
  const url = new URL(location.href);
  url.hash = "";
  if (item && item.source !== "CUSTOM" && item.source !== "MINE") {
    url.hash = `set=${encodeURIComponent(item.name)}`;
  } else {
    const frequencies = frequenciesFromInputOrCurrent();
    if (!frequencies.length) return null;
    url.hash = `f=${frequencies.join(",")}` + (item?.name && item.source === "MINE" ? `&n=${encodeURIComponent(item.name)}` : "");
  }
  return url.toString();
}

async function share() {
  const url = shareUrl();
  if (!url) {
    toast("Pick a set or type frequencies first.");
    return;
  }
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try {
      await navigator.share({ title: `Frequencier · ${state.current?.name || "Custom"}`, url });
      return;
    } catch {}
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied.");
  } catch {
    prompt("Copy this link:", url);
  }
}

/** Opens whatever a shared link points at: #set=Name or #f=396,528&n=Name. */
function openFromHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has("set")) {
    const name = params.get("set");
    const item = state.library.find((entry) => entry.name === name);
    if (item) select(item, { scroll: true });
  } else if (params.has("f")) {
    const frequencies = parseFrequencies(params.get("f"));
    if (frequencies.length) {
      $("#customInput").value = frequencies.join(", ");
      select(customItem(frequencies, params.get("n")));
    }
  }
}

/* ---------- Platform niceties ---------- */

async function requestWakeLock() {
  // Keeps phones from sleeping (and silencing audio) mid-session.
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function updateMediaSession() {
  if (!("mediaSession" in navigator) || !state.current) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.current.name,
    artist: "Frequencier",
    album: state.current.frequencies.map(formatHz).join(" · "),
    artwork: [{ src: "apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  });
  navigator.mediaSession.playbackState = "playing";
  const handlers = {
    play: start,
    pause: () => stop(),
    stop: () => stop(),
    nexttrack: () => skip(1),
    previoustrack: () => skip(-1),
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {}
  }
}

let toastTimer;
function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.dataset.visible = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.dataset.visible = "false"), 2800);
}

function toggleTheme() {
  const current =
    document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  state.settings.theme = next;
  writeSettings();
}

function toggleFavourite(name) {
  if (state.favourites.has(name)) state.favourites.delete(name);
  else state.favourites.add(name);
  saveFavourites(state.favourites);
  renderChips();
  renderList();
}

/** On small screens the settings start folded so the library is one scroll away. */
function setUpSettingsPanel() {
  $("#settingsPanel").open = matchMedia("(min-width: 960px)").matches;
}

/** Shows a slim "now playing" bar while the big player is scrolled out of view. */
function setUpMiniPlayer() {
  const mini = $("#miniPlayer");
  $("#miniStop").addEventListener("click", () => stop());
  new IntersectionObserver(([entry]) => {
    document.body.dataset.playerHidden = String(!entry.isIntersecting);
  }).observe($("#playButton"));
  mini.addEventListener("click", (event) => {
    if (event.target.id !== "miniStop") $("#playButton").scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

/* ---------- Events ---------- */

function bindEvents() {
  $("#playButton").addEventListener("click", togglePlay);
  $("#previousButton").addEventListener("click", () => skip(-1));
  $("#nextButton").addEventListener("click", () => skip(1));

  $("#list").addEventListener("click", (event) => {
    const favourite = event.target.closest("[data-favourite]");
    if (favourite) return toggleFavourite(favourite.dataset.favourite);
    const remove = event.target.closest("[data-delete]");
    if (remove) return deletePreset(Number(remove.dataset.delete));
    const row = event.target.closest(".row");
    if (!row) return;
    const item = findItem(row.dataset.id);
    if (item.id === state.current?.id && state.playing) stop();
    else select(item, { autoplay: true });
  });

  $("#filterChips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-filter]");
    if (!chip) return;
    state.filter = chip.dataset.filter;
    renderChips();
    renderList();
  });

  $("#searchInput").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderList();
  });

  $("#customForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const frequencies = parseFrequencies($("#customInput").value);
    if (frequencies.length === 0) {
      toast("Type at least one frequency, e.g. 528.");
      return;
    }
    select(customItem(frequencies), { autoplay: true });
  });
  $("#savePresetButton").addEventListener("click", openPresetDialog);
  $("#shareButton").addEventListener("click", share);

  for (const button of document.querySelectorAll("[data-mode]")) {
    button.addEventListener("click", () => {
      state.settings.mode = button.dataset.mode;
      state.stepIndex = 0;
      state.stepStartedAt = Date.now();
      applySettingsToControls();
      writeSettings();
      if (state.playing) playCurrentStep();
      else renderNowPlaying();
    });
  }

  const onSetting = (selector, key, transform = Number, after) =>
    $(selector).addEventListener("input", (event) => {
      state.settings[key] = transform(event.target.value);
      writeSettings();
      after?.();
    });
  onSetting("#stepSelect", "stepSeconds");
  onSetting("#timerSelect", "timerMinutes", Number, () => {
    // Restart the clock so a newly chosen timer counts from now.
    state.sessionStartedAt = Date.now();
    renderNowPlaying();
  });
  onSetting("#waveSelect", "waveform", String, soundSettingsChanged);
  onSetting("#binauralSelect", "binaural", Number, () => {
    soundSettingsChanged();
  });
  onSetting("#volumeRange", "volume", Number, () => {
    $("#volumeOutput").textContent = `${state.settings.volume}%`;
    soundSettingsChanged();
  });

  $("#ambienceChips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-ambience]");
    if (!chip) return;
    state.settings.ambience = chip.dataset.ambience;
    writeSettings();
    renderAmbienceChips();
    soundSettingsChanged();
  });
  onSetting("#ambienceRange", "ambienceLevel", Number, () => {
    $("#ambienceOutput").textContent = `${state.settings.ambienceLevel}%`;
    soundSettingsChanged();
  });
  onSetting("#reverbRange", "reverb", Number, () => {
    $("#reverbOutput").textContent = `${state.settings.reverb}%`;
    soundSettingsChanged();
  });
  $("#breathingToggle").addEventListener("change", (event) => {
    state.settings.breathing = event.target.checked;
    writeSettings();
    soundSettingsChanged();
  });

  $("#themeButton").addEventListener("click", toggleTheme);
  $("#helpButton").addEventListener("click", () => $("#helpDialog").showModal());
  window.addEventListener("hashchange", openFromHash);

  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || document.querySelector("dialog[open]")) return;
    const typing = event.target.matches("input, select, textarea");
    if (typing) {
      if (event.key === "Escape") event.target.blur();
      if (event.target.id === "searchInput" && (event.key === "ArrowDown" || event.key === "Enter")) {
        event.preventDefault();
        event.target.blur();
        if (event.key === "Enter" && state.visible[0]) select(state.visible[0], { autoplay: true, scroll: true });
        else moveSelection(1);
      }
      return;
    }
    const actions = {
      " ": togglePlay,
      Enter: () => state.current && !state.playing && start(),
      ArrowDown: () => moveSelection(1),
      ArrowUp: () => moveSelection(-1),
      ArrowRight: () => skip(1),
      ArrowLeft: () => skip(-1),
      "/": () => $("#searchInput").focus(),
      Escape: () => stop(),
      f: () => state.current && state.current.source !== "MINE" && state.current.id !== "custom" && toggleFavourite(state.current.name),
    };
    const action = actions[event.key];
    if (!action || (event.key === " " && event.target.matches("button"))) return;
    event.preventDefault();
    action();
  });
}

/* ---------- Boot ---------- */

async function main() {
  setUpSettingsPanel();
  $("#year").textContent = new Date().getFullYear();
  $("#sourcesList").innerHTML = Object.entries(SOURCES)
    .map(([code, description]) => `<dt>${code}</dt><dd>${description}</dd>`)
    .join("");

  applySettingsToControls();
  bindEvents();
  setUpMiniPlayer();
  startVisualizer($("#scope"), player);
  setInterval(tick, TICK_MS);
  // Timers are throttled or frozen on a locked phone; the <audio> element keeps firing
  // timeupdate while it plays, so the session clock and step changes still run.
  player.audio.addEventListener("timeupdate", tick);
  player.audio.addEventListener("playing", renderNowPlaying);
  player.onerror = (error) => {
    if (error?.name === "AbortError") return; // a newer source replaced this one
    stop(`Couldn't play: ${error?.message || error}`);
  };
  player.onsettingschange = () => {
    if (state.playing && isSequencing()) player.prerender(playableFrequencies().map((f) => [f]));
  };

  try {
    const entries = await loadDatabase();
    state.library = entries.map((entry, index) => ({ id: `set-${index}`, ...entry }));
  } catch (error) {
    $("#emptyState").hidden = false;
    $("#emptyState").textContent = `Couldn't load the library: ${error.message}`;
    return;
  }

  renderChips();
  renderList();
  openFromHash();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

main();
