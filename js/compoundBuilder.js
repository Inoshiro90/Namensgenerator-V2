/**
 * compoundBuilder.js — Strukturierte Komposita-Generierung
 *
 * Unterstützt zwei JSON-Formate:
 *
 * (A) FLACH (Altformat) — alle Einträge direkt auf oberster Ebene:
 *   {
 *     "Wolf": { "wortart": "Nomen", "position": {...}, ... },
 *     "Kind": { ... }
 *   }
 *
 * (B) GRUPPIERT (neues Format) — Einträge nach Wortart gebündelt:
 *   {
 *     "nomen":      { "Wolf": { "wortart": "Nomen", ... }, "Kind": { ... } },
 *     "verben":     { "brennen": { "wortart": "Verb",  ... } },
 *     "adjektive":  { "dunkel":  { "wortart": "Adjektiv", ... } },
 *     ...
 *   }
 *
 * Beide Formate werden durch flattenData() auf eine einheitliche flache Map
 * normalisiert, bevor die eigentliche Kompositions-Logik greift.
 *
 * ── Architekturentscheidungen (unverändert) ─────────────────────────────────
 *
 * 1. REINES MODUL — keinerlei Abhängigkeit zu uiController, app oder DOM.
 *    Nur utils.js wird importiert (RNG, Hilfsfunktionen).
 *
 * 2. ZWEI ÖFFENTLICHE PFADE:
 *    - generateStructuredCompound()  → einen zufälligen Namen (für Generator-Loop)
 *    - getAllValidComposita()         → alle gültigen Kombinationen (exhaustiv)
 *
 * 3. FORMAT-DETEKTOR als eigenständige Funktion — ermöglicht das automatische
 *    Routing in generator.js ohne Änderung der Aufruf-Signaturen.
 *
 * 4. VOLLSTÄNDIG DATENGETRIEBEN — ausschließlich das `position`-Feld im JSON
 *    bestimmt, ob ein Wort als Erst- oder Zweitglied erlaubt ist.
 *    Die `wortart` hat keinen Einfluss auf Positionsentscheidungen.
 *
 * 5. KEINE HARD-CODED WORTART-REGELN — weder Whitelists noch Blacklists.
 *    Sämtliche Kompositions-Regeln laufen ausschließlich über position-Flags
 *    und SECOND_FORM_PRIORITY.
 *
 * Explizite Annahmen:
 * - Ein Wort darf Erstglied sein  ↔ position.erst  === true
 * - Ein Wort darf Zweitglied sein ↔ position.zweit === true
 * - Wortart ist reine Metainformation (z. B. für UI-Anzeige), kein Filter
 * - Als Zweitform gilt die erste vorhandene Form gemäß SECOND_FORM_PRIORITY
 * - Fugenelemente aus fuge.als_erst werden alle als gültige Varianten erzeugt
 * - Duplikate werden über ein Set dedupliziert
 */

import { randomPick, normalizeName } from './utils.js';

// ═══════════════════════════════════════════════════
// KONFIGURATION
// ═══════════════════════════════════════════════════

/**
 * Prioritätsliste: Welche Flexionsform wird als Zweitglied verwendet?
 * Erster Treffer aus entry.formen gewinnt; stamm ist absoluter Fallback.
 */
const SECOND_FORM_PRIORITY = [
  'nom_sg',
  'grundform',
  'infinitiv',
  'positiv',
  'stamm',
];

// ═══════════════════════════════════════════════════
// FORMAT-NORMALISIERUNG  ← NEU
// ═══════════════════════════════════════════════════

/**
 * Prüft, ob ein einzelner Wert ein gültiger Compound-Eintrag ist.
 * Interne Hilfsfunktion für isStructuredCompoundData() und flattenData().
 *
 * @param {any} val
 * @returns {boolean}
 */
function isCompoundEntry(val) {
  return (
    val !== null &&
    typeof val === 'object' &&
    !Array.isArray(val) &&
    typeof val.wortart  === 'string' &&
    typeof val.position === 'object'
  );
}

/**
 * Normalisiert beide JSON-Formate auf eine einheitliche flache Map
 * { Lemma → Eintrag }.
 *
 * Logik:
 *  - Ist der erste Wert bereits ein Compound-Eintrag (hat `wortart`) →
 *    Altformat (flach) → unverändert zurückgeben.
 *  - Anderenfalls: Wortart-Gruppen-Format → alle Untereinträge zusammenführen.
 *
 * Fehlertoleranz:
 *  - Gruppen, die keine Objekte sind, werden übersprungen.
 *  - Einträge ohne `wortart` / `position` werden übersprungen.
 *
 * @param {object} data — strukturiertes oder gruppiertes Compound-JSON
 * @returns {object}    — flache Map { Lemma → Eintrag }
 */
function flattenData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};

  const firstVal = Object.values(data)[0];

  // Bereits flaches Format — keine Transformation nötig
  if (isCompoundEntry(firstVal)) return data;

  // Gruppiertes Format: { nomen: { Wolf: {...} }, verben: {...}, ... }
  const flat = {};
  for (const group of Object.values(data)) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    for (const [lemma, entry] of Object.entries(group)) {
      if (isCompoundEntry(entry)) {
        flat[lemma] = entry;
      }
    }
  }
  return flat;
}

// ═══════════════════════════════════════════════════
// FORMAT-ERKENNUNG  ← GEÄNDERT
// ═══════════════════════════════════════════════════

/**
 * Prüft, ob `data` ein strukturiertes Compound-Format ist — flach ODER gruppiert.
 *
 * Flach:       { "Wolf": { "wortart": ..., "position": ... } }
 * Gruppiert:   { "nomen": { "Wolf": { "wortart": ..., "position": ... } } }
 *
 * Unterschied zum alten Array-Format:
 *  Alt:  { "Wolf": ["wolf", "wolfs"] }  → Wert ist Array
 *
 * @param {any} data
 * @returns {boolean}
 */
export function isStructuredCompoundData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const values = Object.values(data);
  if (values.length === 0) return false;

  const first = values[0];

  // Flaches Format: erster Wert ist direkt ein Compound-Eintrag
  if (isCompoundEntry(first)) return true;

  // Gruppiertes Format: erster Wert ist ein Objekt, dessen erster Wert ein Eintrag ist
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    const subValues = Object.values(first);
    if (subValues.length > 0 && isCompoundEntry(subValues[0])) return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════
// INTERNE HELFER
// ═══════════════════════════════════════════════════

/**
 * Alle Einträge, die als Erstglied erlaubt sind.
 * Einzige Bedingung: position.erst === true
 *
 * @param {object} flat — bereits normalisierte flache Map
 * @returns {Array<[string, object]>}
 */
function getErstglieder(flat) {
  return Object.entries(flat).filter(([, entry]) =>
    entry.position?.erst === true
  );
}

/**
 * Alle Einträge, die als Zweitglied erlaubt sind.
 * Einzige Bedingung: position.zweit === true
 *
 * @param {object} flat — bereits normalisierte flache Map
 * @returns {Array<[string, object]>}
 */
function getZweitglieder(flat) {
  return Object.entries(flat).filter(([, entry]) =>
    entry.position?.zweit === true
  );
}

/**
 * Ermittelt die passende Flexionsform für ein Zweitglied.
 * Durchläuft SECOND_FORM_PRIORITY, gibt den ersten vorhandenen Wert zurück.
 *
 * @param {object} entry
 * @returns {string}
 */
function getZweitForm(entry) {
  for (const key of SECOND_FORM_PRIORITY) {
    const val = entry.formen?.[key];
    if (val && typeof val === 'string') return val;
  }
  return entry.stamm ?? '';
}

/**
 * Gibt alle gültigen Fugenelemente für ein Erstglied zurück.
 * Leerer String "" ist explizit ein gültiges Fugenelement (= keine Fuge).
 *
 * @param {object} entry
 * @returns {string[]}
 */
function getFugenElemente(entry) {
  const list = entry.fuge?.als_erst;
  if (!Array.isArray(list)) return [''];
  return list.filter(f => f !== null && f !== undefined);
}

/**
 * Baut ein einzelnes Kompositum: stamm + fuge + zweitForm → normalisiert.
 *
 * Beispiel: "wolf" + "s" + "Dunkel" → "wolfsdunkel" → "Wolfsdunkel"
 *
 * @param {string} stamm
 * @param {string} fuge
 * @param {string} zweitForm
 * @returns {string}
 */
function buildKompositum(stamm, fuge, zweitForm) {
  const raw = stamm.toLowerCase() + fuge + zweitForm.toLowerCase();
  return normalizeName(raw);
}

// ═══════════════════════════════════════════════════
// KERNLOGIK — ALLE GÜLTIGEN KOMPOSITA
// ═══════════════════════════════════════════════════

/**
 * Generiert ALLE gültigen Komposita aus dem Datensatz.
 *
 * Ablauf:
 * 1. data → flattenData() → einheitliche flache Map          ← GEÄNDERT
 * 2. Alle Erstglieder (position.erst=true) ermitteln
 * 3. Alle Zweitglieder (position.zweit=true) ermitteln
 * 4. Für jede erlaubte Erst+Zweit-Kombination alle Fugen-Varianten erzeugen
 * 5. Duplikate über Set entfernen
 * 6. Selbstreferenzen entfernen (Erst- und Zweitglied identisch)
 *
 * @param {object} data        — strukturiertes Compound-JSON (flach oder gruppiert)
 * @param {object} [options]
 * @param {boolean} [options.allowSameWord=false]
 * @returns {string[]}
 */
export function getAllValidComposita(data, options = {}) {
  const { allowSameWord = false } = options;

  if (!isStructuredCompoundData(data)) return [];

  const flat = flattenData(data); // ← NEU: Normalisierung vor Weiterverarbeitung

  const erstglieder  = getErstglieder(flat);
  const zweitglieder = getZweitglieder(flat);

  const seen   = new Set();
  const result = [];

  for (const [erstLemma, erst] of erstglieder) {
    const stamm = erst.stamm ?? '';
    const fugen = getFugenElemente(erst);

    for (const [zweitLemma, zweit] of zweitglieder) {
      if (!allowSameWord && erstLemma === zweitLemma) continue;

      const zweitForm = getZweitForm(zweit);

      for (const fuge of fugen) {
        const kompositum = buildKompositum(stamm, fuge, zweitForm);
        if (kompositum && !seen.has(kompositum)) {
          seen.add(kompositum);
          result.push(kompositum);
        }
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════
// KERNLOGIK — EINZELNES KOMPOSITUM (ZUFÄLLIG)
// ═══════════════════════════════════════════════════

/**
 * Generiert ein einzelnes zufälliges Kompositum.
 *
 * Strategie:
 * 1. data → flattenData() → einheitliche flache Map          ← GEÄNDERT
 * 2. Zufälliges Erstglied wählen (position.erst=true)
 * 3. Zufälliges Zweitglied wählen (position.zweit=true)
 * 4. Zufälliges Fugenelement aus fuge.als_erst wählen
 * 5. Kompositum bauen & normalisieren
 *
 * Gibt null zurück wenn keine gültige Kombination gefunden wurde.
 *
 * @param {object} data       — strukturiertes Compound-JSON (flach oder gruppiert)
 * @param {object} [options]
 * @param {boolean} [options.allowSameWord=false]
 * @param {number}  [options.maxAttempts=50]
 * @returns {string|null}
 */
export function generateStructuredCompound(data, options = {}) {
  const { allowSameWord = false, maxAttempts = 50 } = options;

  if (!isStructuredCompoundData(data)) return null;

  const flat = flattenData(data); // ← NEU: Normalisierung vor Weiterverarbeitung

  const erstglieder  = getErstglieder(flat);
  const zweitglieder = getZweitglieder(flat);

  if (erstglieder.length === 0 || zweitglieder.length === 0) return null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [erstLemma, erst]   = randomPick(erstglieder);
    const [zweitLemma, zweit] = randomPick(zweitglieder);

    if (!allowSameWord && erstLemma === zweitLemma) continue;

    const fugen     = getFugenElemente(erst);
    const fuge      = randomPick(fugen) ?? '';
    const zweitForm = getZweitForm(zweit);
    const stamm     = erst.stamm ?? '';

    const kompositum = buildKompositum(stamm, fuge, zweitForm);
    if (kompositum) return kompositum;
  }

  // Letzter Ausweg: deterministisch erste gültige Kombination nehmen
  const allCombinations = getAllValidComposita(data, { allowSameWord });
  return allCombinations.length > 0 ? randomPick(allCombinations) : null;
}

// ═══════════════════════════════════════════════════
// HILFSFUNKTION: DETAILLIERTE KOMBINATIONS-ANALYSE
// ═══════════════════════════════════════════════════

/**
 * Gibt eine strukturierte Aufschlüsselung aller Kombinationen zurück.
 * Nützlich für Debugging, UI-Vorschau oder "Explain"-Modus.
 *
 * @param {object} data
 * @returns {Array<{
 *   erstLemma:  string,
 *   zweitLemma: string,
 *   fuge:       string,
 *   kompositum: string,
 *   wortarten:  string,
 * }>}
 */
export function explainComposita(data) {
  if (!isStructuredCompoundData(data)) return [];

  const flat = flattenData(data); // ← NEU: Normalisierung vor Weiterverarbeitung

  const erstglieder  = getErstglieder(flat);
  const zweitglieder = getZweitglieder(flat);
  const seen         = new Set();
  const result       = [];

  for (const [erstLemma, erst] of erstglieder) {
    for (const [zweitLemma, zweit] of zweitglieder) {
      if (erstLemma === zweitLemma) continue;

      const zweitForm = getZweitForm(zweit);

      for (const fuge of getFugenElemente(erst)) {
        const kompositum = buildKompositum(erst.stamm ?? '', fuge, zweitForm);
        if (kompositum && !seen.has(kompositum)) {
          seen.add(kompositum);
          result.push({
            erstLemma,
            zweitLemma,
            fuge: fuge === '' ? '∅' : `"${fuge}"`,
            kompositum,
            wortarten: `${erst.wortart} + ${zweit.wortart}`,
          });
        }
      }
    }
  }

  return result;
}