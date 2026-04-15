/**
 * compoundBuilder.js — Strukturierte Komposita-Generierung
 *
 * Verarbeitet das erweiterte Compound-Datenformat:
 * {
 *   "Wolf": {
 *     "wortart": "Nomen",
 *     "position": { "erst": true, "zweit": true },
 *     "stamm": "wolf",
 *     "formen": { "nom_sg": "Wolf", "gen_sg": "Wolfs", "plural": "Wölfe" },
 *     "fuge": { "als_erst": ["", "s"], "als_zweit": [""] }
 *   },
 *   ...
 * }
 *
 * Architekturentscheidungen:
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
 *
 * Reihenfolge bewusst wortart-agnostisch gewählt:
 *  nom_sg    → Nomen-Grundform    ("Wolf"   → Wolfsdunkel)
 *  grundform → unveränderliche WA ("über"   → Überwolf)
 *  infinitiv → Verbform           ("laufen" → Laufschuhe)
 *  positiv   → Adjektiv-Grundform ("dunkel" → Wolfsdunkel)
 *  stamm     → Absoluter Fallback (immer vorhanden)
 */
const SECOND_FORM_PRIORITY = [
  'nom_sg',
  'grundform',
  'infinitiv',
  'positiv',
  'stamm',
];

// ═══════════════════════════════════════════════════
// FORMAT-ERKENNUNG
// ═══════════════════════════════════════════════════

/**
 * Prüft, ob `data` das strukturierte Compound-Format ist.
 *
 * Unterschied zum alten Format:
 *  - Alt:  { "Wolf": ["wolf", "wolfs"] }       → Wert ist Array
 *  - Neu:  { "Wolf": { "wortart": ..., ... } }  → Wert ist Objekt mit "wortart"
 *
 * @param {any} data
 * @returns {boolean}
 */
export function isStructuredCompoundData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  if (keys.length === 0) return false;
  const first = data[keys[0]];
  return (
    typeof first === 'object' &&
    !Array.isArray(first) &&
    typeof first.wortart === 'string' &&
    typeof first.position === 'object'
  );
}

// ═══════════════════════════════════════════════════
// INTERNE HELFER
// ═══════════════════════════════════════════════════

/**
 * Alle Einträge, die als Erstglied erlaubt sind.
 *
 * Einzige Bedingung: position.erst === true
 * Die Wortart hat keinen Einfluss.
 *
 * @param {object} data
 * @returns {Array<[string, object]>}
 */
function getErstglieder(data) {
  return Object.entries(data).filter(([, entry]) =>
    entry.position?.erst === true
  );
}

/**
 * Alle Einträge, die als Zweitglied erlaubt sind.
 *
 * Einzige Bedingung: position.zweit === true
 * Die Wortart hat keinen Einfluss.
 *
 * @param {object} data
 * @returns {Array<[string, object]>}
 */
function getZweitglieder(data) {
  return Object.entries(data).filter(([, entry]) =>
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
 * 1. Alle Erstglieder (position.erst=true) ermitteln
 * 2. Alle Zweitglieder (position.zweit=true) ermitteln
 * 3. Für jede erlaubte Erst+Zweit-Kombination alle Fugen-Varianten erzeugen
 * 4. Duplikate über Set entfernen
 * 5. Selbstreferenzen entfernen (Erst- und Zweitglied identisch)
 *
 * @param {object} data        — strukturiertes Compound-JSON
 * @param {object} [options]
 * @param {boolean} [options.allowSameWord=false] — Erlaubt gleiche Wörter in Erst + Zweit?
 * @returns {string[]}         — deduplizierte Liste aller Komposita
 */
export function getAllValidComposita(data, options = {}) {
  const { allowSameWord = false } = options;

  if (!isStructuredCompoundData(data)) return [];

  const erstglieder  = getErstglieder(data);
  const zweitglieder = getZweitglieder(data);

  const seen   = new Set();
  const result = [];

  for (const [erstLemma, erst] of erstglieder) {
    const stamm       = erst.stamm ?? '';
    const fugen       = getFugenElemente(erst);

    for (const [zweitLemma, zweit] of zweitglieder) {
      // Selbstreferenz vermeiden (optional konfigurierbar)
      if (!allowSameWord && erstLemma === zweitLemma) continue;

      const zweitForm = getZweitForm(zweit);

      // Alle Fugen-Varianten erzeugen
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
 * 1. Zufälliges Erstglied wählen (position.erst=true)
 * 2. Zufälliges Zweitglied wählen (position.zweit=true)
 * 3. Zufälliges Fugenelement aus fuge.als_erst wählen
 * 4. Kompositum bauen & normalisieren
 *
 * Gibt null zurück wenn keine gültige Kombination gefunden wurde
 * (z. B. Datensatz hat keine Zweitglieder).
 *
 * @param {object} data       — strukturiertes Compound-JSON
 * @param {object} [options]
 * @param {boolean} [options.allowSameWord=false]
 * @param {number}  [options.maxAttempts=50]
 * @returns {string|null}
 */
export function generateStructuredCompound(data, options = {}) {
  const { allowSameWord = false, maxAttempts = 50 } = options;

  if (!isStructuredCompoundData(data)) return null;

  const erstglieder  = getErstglieder(data);
  const zweitglieder = getZweitglieder(data);

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
 *   wortarten:  string,   — z. B. "Nomen + Nomen"
 * }>}
 */
export function explainComposita(data) {
  if (!isStructuredCompoundData(data)) return [];

  const erstglieder  = getErstglieder(data);
  const zweitglieder = getZweitglieder(data);
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
