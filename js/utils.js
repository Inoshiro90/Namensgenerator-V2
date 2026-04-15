/**
 * utils.js — Hilfsfunktionen für den Namensgenerator
 *
 * Enthält:
 *  - Seeded Pseudo-Random Number Generator (Mulberry32)
 *  - Gewichtete Zufallsauswahl (weightedRandom)
 *  - Normalisierung von Namen
 *  - Sortierung & Gruppierung der Ausgabe
 *  - Allgemeine Helfer (debounce, capitalize, etc.)
 */

// ═══════════════════════════════════════════════════
// SEEDED PSEUDO-RANDOM NUMBER GENERATOR
// Implementierung: Mulberry32 — schnell, reproduzierbar
// ═══════════════════════════════════════════════════

/**
 * Erstellt einen seeded PRNG auf Basis des Mulberry32-Algorithmus.
 * Gleicher Seed → immer gleiche Sequenz von Zufallswerten.
 *
 * @param {number|string} seed - Startwert (Zahl oder String)
 * @returns {() => number} - Funktion, die Werte in [0, 1) liefert
 */
export function createSeededRNG(seed) {
  // String-Seeds in einen numerischen Hash umwandeln (djb2-variant)
  if (typeof seed === 'string') {
    seed = seed.split('').reduce((hash, char) => {
      return Math.imul(31, hash) + char.charCodeAt(0) | 0;
    }, 5381);
  }

  // Mulberry32 PRNG
  let s = seed >>> 0;
  return function mulberry32() {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────
// Globaler RNG-State (ersetzbar via setRNG / resetRNG)
// ─────────────────────────────────────────────────

/** @type {() => number} */
export let rng = Math.random;

/**
 * Überschreibt den globalen RNG (z. B. mit seeded RNG).
 * @param {() => number} newRng
 */
export function setRNG(newRng) {
  rng = newRng;
}

/**
 * Setzt den RNG zurück auf Math.random.
 */
export function resetRNG() {
  rng = Math.random;
}

// ═══════════════════════════════════════════════════
// GEWICHTETE ZUFALLSAUSWAHL
// ═══════════════════════════════════════════════════

/**
 * Wählt ein Element aus `items` aus, gewichtet nach `getWeight(item)`.
 *
 * Algorithmus: Roulette-Wheel-Selection
 * - Berechne Gesamtgewicht aller Einträge
 * - Ziehe Zufallszahl in [0, Gesamtgewicht)
 * - Durchlaufe Items, subtrahiere Gewichte — wähle bei Unterschreitung
 *
 * @param {Array<T>} items - Liste von Elementen
 * @param {(item: T) => number} getWeight - Funktion, die das Gewicht liefert
 * @returns {T|null}
 */
export function weightedRandom(items, getWeight) {
  if (!items || items.length === 0) return null;

  const weights = items.map(item => Math.max(0, getWeight(item)));
  const total = weights.reduce((sum, w) => sum + w, 0);

  // Fallback: Gleichverteilung, wenn alle Gewichte 0 sind
  if (total === 0) return items[Math.floor(rng() * items.length)];

  let threshold = rng() * total;
  for (let i = 0; i < items.length; i++) {
    threshold -= weights[i];
    if (threshold <= 0) return items[i];
  }

  // Floating-point edge case: letztes Element zurückgeben
  return items[items.length - 1];
}

/**
 * Wählt zufällig ein Element aus einem Array (Gleichverteilung).
 * @param {Array<T>} arr
 * @returns {T|null}
 */
export function randomPick(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Mischung (Fisher-Yates-Shuffle) eines Arrays — in-place.
 * @param {Array<T>} arr
 * @returns {Array<T>} - dasselbe Array (gemischt)
 */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ═══════════════════════════════════════════════════
// NAME-NORMALISIERUNG
// ═══════════════════════════════════════════════════

/**
 * Wandelt den ersten Buchstaben eines Strings in Großbuchstaben um.
 * @param {string} str
 * @returns {string}
 */
export function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Normalisiert einen Namen:
 * - Trimmt Leerzeichen
 * - Kapitalisiert jedes Wort (Vor- und Nachname separat)
 * - Entfernt doppelte Leerzeichen
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  if (!name) return '';
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(part => capitalize(part))
    .join(' ');
}

// ═══════════════════════════════════════════════════
// SORTIERUNG & GRUPPIERUNG DER AUSGABE
// ═══════════════════════════════════════════════════

/**
 * ZENTRALE SORTIERFUNKTION — wird von ALLEN Sortieroperationen verwendet.
 *
 * Sortierregel (verbindlich für UI, Clipboard, Export gesamt & pro Buchstabe):
 *  1. Anfangsbuchstabe alphabetisch (A → Z)
 *  2. Bei gleichem Anfangsbuchstaben: Namenslänge aufsteigend
 *  3. Bei gleicher Länge: vollständig lexikografisch (de-Locale)
 *
 * Gibt ein NEUES Array zurück — mutiert das Original nicht.
 *
 * @param {string[]} names
 * @returns {string[]}
 */
export function sortNames(names) {
  return [...names].sort((a, b) => {
    const la = (a.charAt(0) || '').toUpperCase();
    const lb = (b.charAt(0) || '').toUpperCase();
    if (la !== lb) return la.localeCompare(lb, 'de');
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b, 'de');
  });
}

/**
 * Sortiert Namen alphabetisch (A→Z), dann nach Länge (aufsteigend),
 * entfernt Duplikate und gruppiert nach Anfangsbuchstaben.
 *
 * Nutzt intern die zentrale sortNames()-Funktion.
 *
 * Rückgabe: Map<string, string[]>
 * Beispiel: { "A": ["Aela", "Alric"], "B": ["Bardok", "Bran"] }
 *
 * @param {string[]} names - unsortierte, unfiltrierte Namen
 * @returns {Map<string, string[]>}
 */
export function sortAndGroupOutput(names) {
  if (!names || names.length === 0) return new Map();

  // 1. Duplikate entfernen & normalisieren
  const unique = [...new Set(
    names
      .map(n => normalizeName(n))
      .filter(n => n.length > 0)
  )];

  // 2. Zentrale Sortierung
  const sorted = sortNames(unique);

  // 3. Gruppierung nach erstem Buchstaben
  const groups = new Map();
  for (const name of sorted) {
    const letter = name.charAt(0).toUpperCase();
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(name);
  }

  return groups;
}


/**
 * Gibt Namen als flaches, sortiertes Array zurück (ohne Gruppierung).
 * Zentrale Hilfsfunktion für Clipboard & Export — stellt sicher, dass
 * Kopieren und Exportieren dieselbe Reihenfolge wie die UI verwenden.
 *
 * Nutzt die zentrale sortNames()-Funktion direkt (effizienter als
 * Grouping + Flatten).
 *
 * @param {string[]} names
 * @returns {string[]}
 */
export function getSortedNames(names) {
  if (!names || names.length === 0) return [];
  const unique = [...new Set(
    names.map(n => normalizeName(n)).filter(n => n.length > 0)
  )];
  return sortNames(unique);
}


/**
 * Extrahiert alle möglichen Anfangsbuchstaben aus einem linguistischen
 * Datensatz. Durchsucht syllables.prefix, consonantCombinations.prefix
 * und vowelCombinations.prefix.
 *
 * Verwendung: dynamischer Letter-Picker, der nur Buchstaben zeigt,
 * die in den geladenen Daten tatsächlich vorkommen.
 *
 * @param {object|null} linguisticData
 * @returns {string[]} aufsteigend sortierte Großbuchstaben, z. B. ['A','B','D',…]
 */
export function extractPrefixLetters(linguisticData) {
  if (!linguisticData) return [];

  const firstChars = new Set();

  const sources = [
    linguisticData?.syllables?.prefix,
    linguisticData?.consonantCombinations?.prefix,
    linguisticData?.vowelCombinations?.prefix,
  ];

  for (const posMap of sources) {
    if (!posMap) continue;
    for (const entries of Object.values(posMap)) {
      for (const key of Object.keys(entries)) {
        if (key) firstChars.add(key[0].toUpperCase());
      }
    }
  }

  return [...firstChars].sort((a, b) => a.localeCompare(b, 'de'));
}
// ═══════════════════════════════════════════════════
// ALLGEMEINE HELFER
// ═══════════════════════════════════════════════════

/**
 * Debounce: Verhindert, dass eine Funktion zu häufig aufgerufen wird.
 * @param {Function} fn
 * @param {number} delay - ms
 * @returns {Function}
 */
export function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Formatiert eine Zahl als deutschen Tausend-Trenner.
 * @param {number} n
 * @returns {string}
 */
export function formatNumber(n) {
  return n.toLocaleString('de-DE');
}

/**
 * Zufällige Ganzzahl in [min, max] (inklusiv).
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randomInt(min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Prüft, ob ein String ein gültiger JSON-Inhalt ist.
 * @param {string} str
 * @returns {boolean}
 */
export function isValidJSON(str) {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}
