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
 * Beide Formate werden durch collectEntries() auf eine einheitliche Liste von
 * Einträgen normalisiert, bevor die eigentliche Kompositions-Logik greift.
 * Schlüssel mit führendem "_" (z. B. "_taxonomie") sind Metadaten und werden
 * nie als Einträge oder Gruppen gelesen.
 * Gleiche Lemmata in verschiedenen Gruppen (z. B. Nomen "Kupfer" und Adjektiv
 * "Kupfer") bleiben als getrennte Einträge erhalten.
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
 * 6. EINE GEMEINSAME PAARPRÜFUNG (checkPair) für alle Pfade. Ein Paar wird
 *    verworfen, wenn
 *      a) beide Glieder dasselbe Lemma haben      (Fraufrau, Steinstein)
 *      b) beide Glieder denselben Stamm haben     (Frau + Frauen → Fraufrauen)
 *      c) ihre semantischen Primärkategorien redundant sind (Rubin + Smaragd,
 *         beide Material > Edelstein); siehe compoundTaxonomy.js
 *    Die Kategorieprüfung ist unabhängig von position/Fuge und lässt Einträge
 *    ohne Kategorie unberührt (Rückwärtskompatibilität).
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
import { getTaxonomyIndex, categoriesCollide, primaryCategory } from './compoundTaxonomy.js';

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
// FORMAT-NORMALISIERUNG
// ═══════════════════════════════════════════════════

/**
 * Prüft, ob ein einzelner Wert ein gültiger Compound-Eintrag ist.
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
    typeof val.position === 'object' &&
    val.position !== null
  );
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

/**
 * Normalisiert beide JSON-Formate (flach / gruppiert) auf eine Liste von
 * Eintrags-Datensätzen.
 *
 * Jeder Datensatz: { id, lemma, entry, stammKey, primaer }
 *  - id        eindeutig (Gruppe + Lemma), damit gleiche Lemmata verschiedener
 *              Wortarten nicht überschreiben
 *  - stammKey  kleingeschriebener, getrimmter Stamm ('' wenn keiner)
 *  - primaer   semantische Primärkategorie oder null
 *
 * Fehlertoleranz:
 *  - Metadaten-Schlüssel ("_…") werden übersprungen.
 *  - Gruppen/Einträge, die keine Objekte bzw. keine gültigen Einträge sind,
 *    werden übersprungen.
 *
 * @param {object} data
 * @returns {Array<{id:string, lemma:string, entry:object, stammKey:string, primaer:string|null}>}
 */
function collectEntries(data) {
  if (!isPlainObject(data)) return [];

  const records = [];
  const push = (id, lemma, entry) => {
    records.push({
      id,
      lemma,
      entry,
      stammKey: String(entry.stamm ?? '').trim().toLowerCase(),
      primaer: primaryCategory(entry),
    });
  };

  for (const [topKey, value] of Object.entries(data)) {
    if (topKey.startsWith('_')) continue;            // Metadaten (z. B. _taxonomie)
    if (!isPlainObject(value)) continue;

    if (isCompoundEntry(value)) {
      // Flaches Format: { Wolf: { wortart, position, … } }
      push(topKey, topKey, value);
    } else {
      // Gruppiertes Format: { nomen: { Wolf: { … } } }
      for (const [lemma, entry] of Object.entries(value)) {
        if (isCompoundEntry(entry)) push(`${topKey}:${lemma}`, lemma, entry);
      }
    }
  }
  return records;
}

// ═══════════════════════════════════════════════════
// FORMAT-ERKENNUNG
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
 * Es genügt ein einziger gültiger Eintrag irgendwo: leere Gruppen (z. B.
 * "nomen": {}) und Metadaten-Schlüssel ("_taxonomie") stören die Erkennung nicht.
 *
 * @param {any} data
 * @returns {boolean}
 */
export function isStructuredCompoundData(data) {
  if (!isPlainObject(data)) return false;

  for (const [topKey, value] of Object.entries(data)) {
    if (topKey.startsWith('_')) continue;
    if (!isPlainObject(value)) continue;
    if (isCompoundEntry(value)) return true;                          // flach
    for (const sub of Object.values(value)) {
      if (isCompoundEntry(sub)) return true;                          // gruppiert
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════
// INTERNE HELFER
// ═══════════════════════════════════════════════════

/** Alle Datensätze, die als Erstglied erlaubt sind (position.erst === true). */
function getErstglieder(records) {
  return records.filter(r => r.entry.position?.erst === true);
}

/** Alle Datensätze, die als Zweitglied erlaubt sind (position.zweit === true). */
function getZweitglieder(records) {
  return records.filter(r => r.entry.position?.zweit === true);
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
// PAARPRÜFUNG (gemeinsam für alle Pfade)
// ═══════════════════════════════════════════════════

/**
 * Prüft, ob ein Erst-/Zweitglied-Paar kombiniert werden darf.
 *
 * Reihenfolge:
 *  1. gleiches Lemma   → 'lemma'     (Fraufrau, Steinstein)
 *  2. gleicher Stamm   → 'stamm'     (Frau + Frauen)
 *     Beide entfallen mit options.allowSameWord = true; solche Paare gelten dann
 *     als "dasselbe Wort" und werden NICHT zusätzlich über die Kategorie blockiert.
 *  3. redundante Primärkategorien → 'kategorie' (Rubin + Smaragd)
 *     Abschaltbar mit options.useCategories = false.
 *
 * Frauenstein / Steinsfrau: andere Lemmata und Stämme, andere Kategorien →
 * erlaubt. Ähnliche Bestandteile oder die Position allein blockieren nichts.
 *
 * @param {{lemma:string, stammKey:string, primaer:string|null}} erst
 * @param {{lemma:string, stammKey:string, primaer:string|null}} zweit
 * @param {{ index: object|null, allowSameWord: boolean, useCategories: boolean }} ctx
 * @returns {null|'lemma'|'stamm'|'kategorie'} null = erlaubt, sonst der Grund
 */
function checkPair(erst, zweit, ctx) {
  const sameLemma = erst.lemma === zweit.lemma;
  const sameStamm = erst.stammKey !== '' && erst.stammKey === zweit.stammKey;

  if (sameLemma || sameStamm) {
    if (ctx.allowSameWord) return null;
    return sameLemma ? 'lemma' : 'stamm';
  }

  if (ctx.useCategories && ctx.index && categoriesCollide(ctx.index, erst.primaer, zweit.primaer)) {
    return 'kategorie';
  }
  return null;
}

/**
 * @param {object} data
 * @param {object} options
 * @returns {{ index: object|null, allowSameWord: boolean, useCategories: boolean }}
 */
function buildContext(data, options = {}) {
  const { allowSameWord = false, useCategories = true } = options;
  return {
    index: useCategories ? getTaxonomyIndex(data) : null,
    allowSameWord,
    useCategories,
  };
}

// ═══════════════════════════════════════════════════
// KERNLOGIK — ALLE GÜLTIGEN KOMPOSITA
// ═══════════════════════════════════════════════════

/**
 * Generiert ALLE gültigen Komposita aus dem Datensatz.
 *
 * Ablauf:
 * 1. data → collectEntries() → einheitliche Eintragsliste
 * 2. Alle Erstglieder (position.erst=true) ermitteln
 * 3. Alle Zweitglieder (position.zweit=true) ermitteln
 * 4. Pro Paar checkPair(): Lemma, Stamm, Kategorie
 * 5. Für jede erlaubte Kombination alle Fugen-Varianten erzeugen
 * 6. Duplikate über Set entfernen
 *
 * @param {object} data        — strukturiertes Compound-JSON (flach oder gruppiert)
 * @param {object} [options]
 * @param {boolean} [options.allowSameWord=false]   gleiches Wort/gleicher Stamm erlaubt
 * @param {boolean} [options.useCategories=true]    semantische Kategorieprüfung
 * @returns {string[]}
 */
export function getAllValidComposita(data, options = {}) {
  if (!isStructuredCompoundData(data)) return [];

  const ctx     = buildContext(data, options);
  const records = collectEntries(data);

  const erstglieder  = getErstglieder(records);
  const zweitglieder = getZweitglieder(records);

  const seen   = new Set();
  const result = [];

  for (const erst of erstglieder) {
    const stamm = erst.entry.stamm ?? '';
    const fugen = getFugenElemente(erst.entry);

    for (const zweit of zweitglieder) {
      if (checkPair(erst, zweit, ctx)) continue;

      const zweitForm = getZweitForm(zweit.entry);

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
 * 1. data → collectEntries() → einheitliche Eintragsliste
 * 2. Zufälliges Erstglied wählen (position.erst=true)
 * 3. Zufälliges Zweitglied wählen (position.zweit=true)
 * 4. checkPair(): bei Ablehnung neuer Versuch
 * 5. Zufälliges Fugenelement aus fuge.als_erst wählen
 * 6. Kompositum bauen & normalisieren
 *
 * Nach maxAttempts erfolglosen Versuchen wird exhaustiv über
 * getAllValidComposita() gewählt. Gibt null zurück, wenn keine gültige
 * Kombination existiert.
 *
 * @param {object} data       — strukturiertes Compound-JSON (flach oder gruppiert)
 * @param {object} [options]
 * @param {boolean} [options.allowSameWord=false]
 * @param {boolean} [options.useCategories=true]
 * @param {number}  [options.maxAttempts=50]
 * @returns {string|null}
 */
export function generateStructuredCompound(data, options = {}) {
  const { maxAttempts = 50 } = options;

  if (!isStructuredCompoundData(data)) return null;

  const ctx     = buildContext(data, options);
  const records = collectEntries(data);

  const erstglieder  = getErstglieder(records);
  const zweitglieder = getZweitglieder(records);

  if (erstglieder.length === 0 || zweitglieder.length === 0) return null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const erst  = randomPick(erstglieder);
    const zweit = randomPick(zweitglieder);

    if (checkPair(erst, zweit, ctx)) continue;

    const fugen     = getFugenElemente(erst.entry);
    const fuge      = randomPick(fugen) ?? '';
    const zweitForm = getZweitForm(zweit.entry);
    const stamm     = erst.entry.stamm ?? '';

    const kompositum = buildKompositum(stamm, fuge, zweitForm);
    if (kompositum) return kompositum;
  }

  // Letzter Ausweg: aus allen gültigen Kombinationen wählen
  const allCombinations = getAllValidComposita(data, options);
  return allCombinations.length > 0 ? randomPick(allCombinations) : null;
}

// ═══════════════════════════════════════════════════
// HILFSFUNKTIONEN: ANALYSE
// ═══════════════════════════════════════════════════

/**
 * Gibt eine strukturierte Aufschlüsselung aller erlaubten Kombinationen zurück.
 * Nützlich für Debugging, UI-Vorschau oder "Explain"-Modus.
 *
 * @param {object} data
 * @param {object} [options] — wie getAllValidComposita
 * @returns {Array<{
 *   erstLemma:  string,
 *   zweitLemma: string,
 *   fuge:       string,
 *   kompositum: string,
 *   wortarten:  string,
 * }>}
 */
export function explainComposita(data, options = {}) {
  if (!isStructuredCompoundData(data)) return [];

  const ctx     = buildContext(data, options);
  const records = collectEntries(data);

  const erstglieder  = getErstglieder(records);
  const zweitglieder = getZweitglieder(records);
  const seen         = new Set();
  const result       = [];

  for (const erst of erstglieder) {
    for (const zweit of zweitglieder) {
      if (checkPair(erst, zweit, ctx)) continue;

      const zweitForm = getZweitForm(zweit.entry);

      for (const fuge of getFugenElemente(erst.entry)) {
        const kompositum = buildKompositum(erst.entry.stamm ?? '', fuge, zweitForm);
        if (kompositum && !seen.has(kompositum)) {
          seen.add(kompositum);
          result.push({
            erstLemma:  erst.lemma,
            zweitLemma: zweit.lemma,
            fuge: fuge === '' ? '∅' : `"${fuge}"`,
            kompositum,
            wortarten: `${erst.entry.wortart} + ${zweit.entry.wortart}`,
          });
        }
      }
    }
  }

  return result;
}

/**
 * Trockenlauf: welche Paare werden erlaubt, welche blockiert — und warum?
 * Dient der Prüfung, dass bestehende, sinnvolle Namen durch die Regeln nicht
 * ungewollt verloren gehen (Regressionsprüfung nach Kategorie-Änderungen).
 *
 * @param {object} data
 * @param {object} [options] — wie getAllValidComposita
 * @returns {{
 *   erlaubt:   string[],
 *   blockiert: Array<{ erstLemma:string, zweitLemma:string, grund:'lemma'|'stamm'|'kategorie', beispiel:string }>
 * }}
 */
export function analyzePairs(data, options = {}) {
  const empty = { erlaubt: [], blockiert: [] };
  if (!isStructuredCompoundData(data)) return empty;

  const ctx     = buildContext(data, options);
  const records = collectEntries(data);

  const erstglieder  = getErstglieder(records);
  const zweitglieder = getZweitglieder(records);
  const seen         = new Set();
  const erlaubt      = [];
  const blockiert    = [];

  for (const erst of erstglieder) {
    const fugen = getFugenElemente(erst.entry);
    for (const zweit of zweitglieder) {
      const zweitForm = getZweitForm(zweit.entry);
      const grund = checkPair(erst, zweit, ctx);

      if (grund) {
        const beispiel = buildKompositum(erst.entry.stamm ?? '', fugen[0] ?? '', zweitForm);
        blockiert.push({ erstLemma: erst.lemma, zweitLemma: zweit.lemma, grund, beispiel });
        continue;
      }

      for (const fuge of fugen) {
        const kompositum = buildKompositum(erst.entry.stamm ?? '', fuge, zweitForm);
        if (kompositum && !seen.has(kompositum)) {
          seen.add(kompositum);
          erlaubt.push(kompositum);
        }
      }
    }
  }

  return { erlaubt, blockiert };
}
