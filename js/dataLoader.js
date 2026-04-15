/**
 * dataLoader.js — Lazy Loading & Caching aller JSON-Datendateien
 *
 * Verantwortlich für:
 *  - fetch() aller externen JSON-Dateien
 *  - Caching via Map (jede URL wird nur einmal geladen)
 *  - Laden der Völker-Metadaten (peoples.json)
 *  - Laden von Sprach-/Silbendaten
 *  - Laden von Verbindungsnamen-Daten
 *  - Import benutzereigener JSON-Dateien
 *  - Fehlerbehandlung & Statusreporting
 */

// ─────────────────────────────────────────────────
// Interner Cache: URL → geparste JSON-Daten
// ─────────────────────────────────────────────────
/** @type {Map<string, any>} */
const cache = new Map();

// ═══════════════════════════════════════════════════
// KERN: generisches JSON-Laden mit Caching
// ═══════════════════════════════════════════════════

/**
 * Lädt JSON von einer URL, cached das Ergebnis automatisch.
 * Wirft einen Fehler, wenn die Antwort nicht OK ist.
 *
 * @param {string} url
 * @returns {Promise<any>}
 * @throws {Error} bei Netzwerkfehler oder ungültigem JSON
 */
async function loadJSON(url) {
  // Cache-Hit
  if (cache.has(url)) {
    return cache.get(url);
  }

  let response;
  try {
    response = await fetch(url);
  } catch (networkError) {
    throw new Error(
      `Netzwerkfehler beim Laden von „${url}": ${networkError.message}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} beim Laden von „${url}"`
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (parseError) {
    throw new Error(
      `Ungültiges JSON in „${url}": ${parseError.message}`
    );
  }

  cache.set(url, data);
  return data;
}

// ═══════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════

/**
 * Lädt die Metadaten zu Völkern & Sprachfamilien aus peoples.json.
 *
 * Struktur:
 * [
 *   {
 *     id: "human",
 *     label: "Mensch",
 *     languageFamilies: [
 *       { id: "human_de", label: "Mensch — Deutsch", files: { ... } }
 *     ]
 *   },
 *   { id: "dwarf", label: "Zwerg", files: { ... } }
 * ]
 *
 * @returns {Promise<Array>}
 */
export async function loadPeoples() {
  return loadJSON('data/peoples.json');
}

/**
 * Lädt linguistische Daten (Silben, Cluster, CV-Patterns, Wahrscheinlichkeiten).
 *
 * @param {string} filePath - z. B. "data/dwarf_firstName_male.json"
 * @returns {Promise<object>}
 */
export async function loadLinguisticData(filePath) {
  return loadJSON(filePath);
}

/**
 * Lädt Verbindungsnamen-Daten (Lemma → Varianten).
 *
 * @param {string} filePath - z. B. "data/dwarf_compound.json"
 * @returns {Promise<object>}
 */
export async function loadCompoundData(filePath) {
  return loadJSON(filePath);
}

/**
 * Lädt mehrere Dateien parallel (Promise.allSettled — einzelne Fehler
 * verwerfen das gesamte Ergebnis nicht).
 *
 * @param {string[]} filePaths
 * @returns {Promise<Array<{status: 'fulfilled'|'rejected', value?, reason?}>>}
 */
export async function preloadFiles(filePaths) {
  return Promise.allSettled(filePaths.map(p => loadJSON(p)));
}

/**
 * Speichert benutzereigene JSON-Daten direkt im Cache unter einem
 * virtuellen URL-Key, sodass sie wie reguläre Datendateien verwendet
 * werden können.
 *
 * @param {string} virtualKey - interner Key (z. B. "user://custom_data")
 * @param {any} data - die geparsten JSON-Daten
 */
export function registerUserData(virtualKey, data) {
  cache.set(virtualKey, data);
}

/**
 * Liest eine vom Benutzer hochgeladene Datei und parst sie als JSON.
 * Gibt die geparsten Daten zurück (ohne Caching — der Aufrufer
 * entscheidet, ob/wie er sie speichert).
 *
 * @param {File} file - Browser File-Objekt
 * @returns {Promise<any>}
 */
export async function loadUserFile(file) {
  return new Promise((resolve, reject) => {
    if (!file.name.endsWith('.json')) {
      reject(new Error('Nur .json-Dateien werden unterstützt.'));
      return;
    }

    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        resolve(data);
      } catch (err) {
        reject(new Error(`Ungültiger JSON-Inhalt in „${file.name}": ${err.message}`));
      }
    };

    reader.onerror = () => {
      reject(new Error(`Fehler beim Lesen der Datei „${file.name}"`));
    };

    reader.readAsText(file, 'UTF-8');
  });
}

/**
 * Löscht den gesamten Cache (z. B. nach dem Laden einer neuen Datei).
 * Achtung: Bewirkt, dass alle Daten neu geladen werden.
 */
export function clearCache() {
  cache.clear();
}

/**
 * Entfernt einen einzelnen Eintrag aus dem Cache.
 * @param {string} key
 */
export function invalidateCache(key) {
  cache.delete(key);
}

/**
 * Gibt aktuelle Cache-Statistiken zurück (für Debugging).
 * @returns {{ size: number, keys: string[] }}
 */
export function getCacheStats() {
  return {
    size: cache.size,
    keys: [...cache.keys()],
  };
}
