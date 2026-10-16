/**
 * Frequency library: the bundled database plus the user's favourites and saved presets.
 * Favourites and presets live in localStorage, so every read/write tolerates it being unavailable
 * (private mode, blocked storage).
 */

const FAVOURITES_KEY = "frequencier.favourites";
const PRESETS_KEY = "frequencier.presets";
const LEGACY_FAVOURITES_KEY = "frequencierFavouriteItems"; // v1 format: {data: [{name: encodedName}]}

/** What each source code in the database stands for. */
export const SOURCES = {
  CAFL: "Consolidated Annotated Frequency List",
  XTRA: "Extra frequencies from practitioners",
  KHZ: "High-frequency (kHz) list",
  BIO: "Biomedical frequencies",
  VEGA: "Vega device frequencies",
  CUST: "Custom sets",
  PROV: "Provisional, not yet confirmed",
  ODD: "Unusual / one-off",
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the change simply lasts for this visit only.
  }
}

export async function loadDatabase() {
  const response = await fetch("database/frequencies.json");
  if (!response.ok) throw new Error(`Could not load frequencies (${response.status})`);
  return response.json();
}

export function loadFavourites() {
  const favourites = new Set(readJson(FAVOURITES_KEY, []));

  // Carry over favourites saved by the first version of the app.
  const legacy = readJson(LEGACY_FAVOURITES_KEY, null);
  if (legacy?.data?.length) {
    for (const item of legacy.data) favourites.add(decodeURIComponent(item.name));
    writeJson(FAVOURITES_KEY, [...favourites]);
    try {
      localStorage.removeItem(LEGACY_FAVOURITES_KEY);
    } catch {}
  }
  return favourites;
}

export function saveFavourites(favourites) {
  writeJson(FAVOURITES_KEY, [...favourites]);
}

export function loadPresets() {
  return readJson(PRESETS_KEY, []);
}

export function savePresets(presets) {
  writeJson(PRESETS_KEY, presets);
}

/** Turns "220, 440;528 hz" into [220, 440, 528]. Ignores anything that is not a positive number. */
export function parseFrequencies(text) {
  return String(text)
    .split(/[\s,;]+/)
    .map((part) => parseFloat(part.replace(/hz$/i, "")))
    .filter((value) => Number.isFinite(value) && value > 0);
}

export function formatHz(value) {
  if (value >= 1000) return `${+(value / 1000).toFixed(3)} kHz`;
  return `${+value.toFixed(2)} Hz`;
}
