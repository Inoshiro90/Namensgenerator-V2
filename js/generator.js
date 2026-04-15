/**
 * generator.js — Kern-Generierungslogik des Namensgenerators
 *
 * Enthält:
 *  - Silbenbasierte Generierung  (generateSyllableName)
 *  - Clusterbasierte Generierung (generateClusterName)
 *  - Verbindungsnamen            (generateCompoundName) — dual-format
 *  - Komplett-zufällige Namen    (generateRandomName)
 *  - Dispatcher                  (generateName, generateNames)
 *
 * Alle Funktionen sind zustandslos — sie lesen aus dem globalen rng-State
 * (utils.js), der durch setRNG() ausgetauscht werden kann.
 *
 * DATENFORMAT (linguistische Daten):
 * {
 *   _version, profile, nameCount, names,
 *   nameLengths: { "<len>": { count, probability } },
 *   cvPatterns, vowelCombinations, consonantCombinations, syllables
 * }
 *
 * DATENFORMAT Verbindungsnamen — zwei Varianten werden automatisch erkannt:
 *
 *   Alt (einfach):
 *     { "Wolf": ["Wolf", "Wolfs"], "Stein": ["Stein"] }
 *
 *   Neu (strukturiert):
 *     { "Wolf": { wortart, position, stamm, formen, fuge }, ... }
 *     → Routing über isStructuredCompoundData() aus compoundBuilder.js
 */

import { weightedRandom, randomPick, randomInt, normalizeName, rng } from './utils.js';
import { specialGenerators } from './specialGenerators.js';
import {
  isStructuredCompoundData,
  generateStructuredCompound,
} from './compoundBuilder.js';

// ═══════════════════════════════════════════════════
// INTERNE HELFER
// ═══════════════════════════════════════════════════

/**
 * Ermittelt die Namenslänge anhand der gewählten Strategie.
 *
 * @param {object} data     - linguistische Daten (mit nameLengths)
 * @param {object} options  - { lengthMode, fixedLength, minLength, maxLength }
 * @returns {number} Ziel-Zeichenlänge des Namens
 */
/**
 * Gibt alle im JSON definierten Namenslängen als aufsteigend sortiertes
 * Zahlen-Array zurück. Grundwahrheit für alle Längenentscheidungen.
 *
 * @param {object|null} data
 * @returns {number[]}
 */
function getValidLengths(data) {
  if (!data?.nameLengths) return [];
  return Object.keys(data.nameLengths).map(Number).sort((a, b) => a - b);
}

function pickNameLength(data, options = {}) {
  const {
    lengthMode  = 'weighted',
    fixedLength = 6,
    minLength   = 4,
    maxLength   = 10,
  } = options;

  const validLengths = getValidLengths(data);

  switch (lengthMode) {
    // ── Feste Länge ───────────────────────────────────────────────────────
    // Wähle die im JSON vorhandene Länge, die dem Wunsch am nächsten kommt.
    case 'fixed': {
      if (validLengths.length === 0) return Math.max(2, fixedLength);
      const target = Math.max(2, fixedLength);
      return validLengths.reduce((best, l) =>
        Math.abs(l - target) < Math.abs(best - target) ? l : best
      );
    }

    // ── Min/Max-Bereich ──────────────────────────────────────────────────
    // Nur Längen verwenden, die (a) im JSON vorhanden UND (b) im Bereich sind.
    case 'range': {
      const lo = Math.min(minLength, maxLength);
      const hi = Math.max(minLength, maxLength);
      const inRange = validLengths.filter(l => l >= lo && l <= hi);
      if (inRange.length > 0) return randomPick(inRange);
      // Fallback: nächstgelegene JSON-Länge
      if (validLengths.length > 0) return randomPick(validLengths);
      return randomInt(lo, hi);
    }

    // ── Gewichtet (aus JSON) ─────────────────────────────────────────────
    case 'weighted': {
      if (validLengths.length === 0) return randomInt(4, 8);
      const entries = Object.entries(data.nameLengths);
      const picked  = weightedRandom(entries, ([, v]) => v.probability ?? v.count ?? 1);
      return picked ? parseInt(picked[0], 10) : validLengths[0];
    }

    // ── Komplett zufällig (gleichverteilt über JSON-Längen) ──────────────
    case 'random':
    default: {
      if (validLengths.length === 0) return randomInt(4, 10);
      return randomPick(validLengths);
    }
  }
}

/**
 * Wählt einen Eintrag aus einem positions-basierten Bucket
 * (prefix | infix | suffix → { length → { entry: { probByLength, probOverall } } }).
 *
 * Strategie:
 * 1. Versuche, Einträge zur gewünschten Silbenlänge zu finden
 * 2. Fallback: alle Längen zusammenführen
 *
 * @param {object|undefined} positionMap  - z. B. syllables.prefix
 * @param {string}           probMode     - 'probByLength' | 'probOverall' | 'random'
 * @param {number|null}      targetLength - bevorzugte Länge (oder null)
 * @returns {string|null}
 */
/**
 * Wählt einen Eintrag aus einem Positions-Bucket.
 *
 * @param {object}      positionMap - z. B. syllables.prefix  { "2": {...}, "3": {...} }
 * @param {string}      probMode    - 'probByLength' | 'probOverall' | 'random'
 * @param {number|null} targetLength - wenn gesetzt: nur Einträge exakt dieser Länge
 *                                     (kein Fallback auf andere Längen)
 * @param {boolean}     strict      - true → gibt null zurück wenn Länge fehlt
 *                                    false (default) → Fallback auf alle Längen
 * @returns {string|null}
 */
function pickFromPositionBucket(positionMap, probMode, targetLength = null, strict = false) {
  if (!positionMap) return null;

  let candidates;

  if (targetLength !== null && positionMap[targetLength]) {
    candidates = Object.entries(positionMap[targetLength]);
  }

  if (!candidates || candidates.length === 0) {
    if (strict) return null; // keine Einträge für diese exakte Länge → null
    // Soft-Fallback: alle Längen zusammenführen
    candidates = Object.values(positionMap).flatMap(bucket => Object.entries(bucket));
  }

  if (!candidates || candidates.length === 0) return null;

  if (probMode === 'random') {
    return randomPick(candidates)?.[0] ?? null;
  }

  const weightKey = probMode === 'probOverall' ? 'probOverall' : 'probByLength';
  const picked = weightedRandom(candidates, ([, v]) => v[weightKey] ?? 1);
  return picked?.[0] ?? null;
}

/**
 * Prüft ob `name` mit einem bekannten Suffix aus dem Silben-Pool endet.
 *
 * Gibt true zurück wenn kein Suffix-Pool vorhanden ist (kein false-negative bei
 * fehlenden Daten). Stellt sicher, dass kein Infix oder Prefix fälschlicherweise
 * am Namens-Ende landet.
 *
 * @param {string}        name      - normalisierter Name
 * @param {object|null}   syllables - data.syllables  { prefix, infix, suffix }
 * @returns {boolean}
 */
function endsWithValidSuffix(name, syllables) {
  if (!syllables?.suffix) return true;
  const allSuffixes = Object.values(syllables.suffix)
    .flatMap(bucket => Object.keys(bucket));
  if (allSuffixes.length === 0) return true;
  const low = name.toLowerCase();
  return allSuffixes.some(s => low.endsWith(s));
}

// FALLBACK_VOWELS / FALLBACK_CONSONANTS wurden entfernt.
// Alle Generatoren müssen ausschließlich Daten aus den JSON-Dateien verwenden.
// Fehlen benötigte Cluster → Versuch abbrechen oder Error werfen.

// ═══════════════════════════════════════════════════
// GENERATOR 1: SILBENBASIERT
// Prefix → Infix(e) → Suffix
// ═══════════════════════════════════════════════════

/**
 * Baut einen Namen aus vordefinierten Silben zusammen.
 *
 * Strategie:
 * - Wählt ein Prefix-Silbe
 * - Fügt Infix-Silben hinzu, bis die Ziellänge annähernd erreicht ist
 * - Schließt mit einem Suffix ab
 *
 * @param {object} data     - linguistische Daten
 * @param {object} options
 * @returns {string}
 */
export function generateSyllableName(data, options = {}) {
  const targetLength = pickNameLength(data, options);
  const probMode     = options.probMode ?? 'probByLength';
  const syl          = data?.syllables;

  // Gültige Längen aus dem JSON — einzige Wahrheitsquelle für Längenprüfung.
  // Leeres Array = keine Einschränkung (z. B. rein zufällige Daten ohne nameLengths).
  const validLengths = getValidLengths(data);

  if (!syl) {
    throw new Error('[generateSyllableName] Keine Silbendaten (data.syllables) vorhanden.');
  }

  // 20 Versuche (vorher: 8) — mehr Spielraum für kurze Silben-Pools,
  // bei denen Länge + Konsonant selten zusammentreffen.
  for (let attempt = 0; attempt < 20; attempt++) {
    let name = '';

    // 1. Prefix
    const prefix = pickFromPositionBucket(syl.prefix, probMode, null);
    if (prefix) name += prefix;

    // 2. Suffix-Kandidat vorab bestimmen, damit der Platz reserviert wird
    const suffixCandidate = pickFromPositionBucket(syl.suffix, probMode, null) ?? '';

    // 3. Infix einfügen bis (name + suffix) die Ziellänge EXAKT erreicht oder
    //    um max. 1 Zeichen unterschreitet (Suffix schließt dann ab).
    if (syl.infix) {
      let safety = 0;
      while ((name.length + suffixCandidate.length) < targetLength && safety < 20) {
        const infix = pickFromPositionBucket(syl.infix, probMode, null);
        if (!infix) break;
        if (name.length + infix.length + suffixCandidate.length > targetLength + 1) break;
        name += infix;
        safety++;
      }
    }

    // 4. Suffix anhängen
    name += suffixCandidate;

    const normalized = normalizeName(name);

    // ── Validierung ──────────────────────────────────────────────────────
    // a) Länge MUSS exakt in nameLengths vorhanden sein.
    //    ±1-Fuzzy entfernt — das war die direkte Ursache für "Ao" (len=2
    //    wurde bei targetLength=3 akzeptiert).
    if (validLengths.length > 0 && !validLengths.includes(normalized.length)) continue;

    // b) Vokal-only verhindern: Name muss mindestens einen Konsonanten enthalten.
    //    /[bcdfghjklmnpqrstvwxyzß]/i deckt Deutsch + Fantasy-Konsonanten ab.
    if (!/[bcdfghjklmnpqrstvwxyzß]/i.test(normalized)) continue;

    // c) Suffix-Validierung: Name MUSS mit einem bekannten Suffix enden.
    //    Verhindert, dass Infixe oder Prefixe fälschlicherweise am Ende stehen.
    if (!endsWithValidSuffix(normalized, syl)) continue;

    return normalized;
  }

  // Alle Versuche fehlgeschlagen → Minimalname aus Prefix + Suffix,
  // aber NUR wenn er die vollen Validierungsregeln (Länge + Konsonant) besteht.
  // Kein stilles Return mehr bei reinen Vokal-Kombinationen wie "a" + "o" → "Ao".
  if (syl?.prefix && syl?.suffix) {
    const allP = Object.values(syl.prefix).flatMap(b => Object.keys(b));
    const allS = Object.values(syl.suffix).flatMap(b => Object.keys(b));
    for (let t = 0; t < 30; t++) {
      const p         = randomPick(allP) ?? '';
      const s         = randomPick(allS) ?? '';
      const candidate = normalizeName(p + s);
      const lenOk     = validLengths.length === 0 || validLengths.includes(candidate.length);
      const conOk     = /[bcdfghjklmnpqrstvwxyzß]/i.test(candidate);
      if (lenOk && conOk) return candidate;
    }
  }
  // Alle 20 Versuche + 30 Fallback-Versuche fehlgeschlagen.
  // Kein stiller generateRandomName-Fallback mehr: Fehler werfen damit
  // resolveGenMethod die nächste Priorität wählen kann.
  throw new Error('[generateSyllableName] Konnte keinen validen Namen aus JSON-Daten erzeugen.');
}
// CV-Pattern → Vokale & Konsonanten gezielt einsetzen
// ═══════════════════════════════════════════════════

/**
 * Baut einen Namen anhand von CV-Patterns und Vokal-/Konsonantenclustern auf.
 *
 * Strategie:
 * - Wähle ein CV-Pattern für die Ziellänge (z. B. "CVCVC")
 * - Ersetze C durch Konsonanten-Cluster, V durch Vokal-Cluster
 * - Positions-Buckets (prefix/infix/suffix) werden je nach Fortschritt verwendet
 *
 * @param {object} data
 * @param {object} options
 * @returns {string}
 */
/**
 * Zählt aufeinanderfolgende gleiche Symbole ab Position `start` im Pattern.
 * Beispiel: countRun("CVCCC", 2, 'C') → 3
 */
function countRun(pattern, start, symbol) {
  let n = 0;
  for (let i = start; i < pattern.length && pattern[i] === symbol; i++) n++;
  return n;
}

/**
 * Clusterbasierte Generierung — strikt nach CV-Pattern.
 *
 * Kernregel: Das CV-Pattern ist die einzige Wahrheit.
 * - Zusammenhängende C-Runs (z. B. "CC", "CCC") werden als EIN Cluster
 *   der passenden Länge aus consonantCombinations gezogen.
 * - Zusammenhängende V-Runs ("V", "VV") analog aus vowelCombinations.
 * - Positions-Bucket wird nach Fortschritt im Pattern bestimmt.
 * - Wenn kein passender Cluster exakt der Run-Länge gefunden wird,
 *   wird auf die nächst-kürzere Länge ausgewichen (niemals auf falsche Länge).
 *
 * BUG-FIX gegenüber alter Version:
 *   Vorher: jedes C/V-Zeichen einzeln → erzeugte "ACHRRLH"-Monstrositäten
 *   Jetzt:  C-Runs werden als Block behandelt → "Thor", "Gro", "Bral"
 */
export function generateClusterName(data, options = {}) {
  const targetLength = pickNameLength(data, options);
  const probMode     = options.probMode ?? 'probByLength';

  // Gültige Längen aus dem JSON — dieselbe Quelle wie im Silbengenerator.
  const validLengths = getValidLengths(data);

  const vowelMap     = data?.vowelCombinations;
  const consonantMap = data?.consonantCombinations;

  if (!vowelMap && !consonantMap) {
    throw new Error('[generateClusterName] Keine Cluster-Daten (vowelCombinations / consonantCombinations) vorhanden.');
  }

  // ── CV-Patterns für die exakte Ziellänge ermitteln ───────────────────
  // Verwende NUR Patterns, die für genau `targetLength` definiert sind.
  const patternMap = data?.cvPatterns?.[targetLength]?.patterns;

  if (!patternMap) {
    // Keine Patterns für diese Länge → Silben-Fallback, kein random mehr.
    if (data?.syllables) return generateSyllableName(data, options);
    throw new Error(`[generateClusterName] Keine CV-Patterns für Länge ${targetLength} und keine Silbendaten vorhanden.`);
  }

  // Vokal-only Patterns herausfiltern (müssen mindestens ein C enthalten)
  const validPatterns = Object.entries(patternMap).filter(([pat]) => pat.includes('C'));
  if (validPatterns.length === 0) {
    if (data?.syllables) return generateSyllableName(data, options);
    throw new Error(`[generateClusterName] Keine gültigen CV-Patterns (mit Konsonant) für Länge ${targetLength}.`);
  }

  // Bis zu 6 Versuche mit unterschiedlichen Patterns/Chunks
  for (let attempt = 0; attempt < 6; attempt++) {
    // Gewichtetes Pattern wählen
    const picked = weightedRandom(validPatterns, ([, prob]) => prob);
    if (!picked) break;
    const pattern = picked[0];

    // ── Pattern blockweise abarbeiten ──────────────────────────────────
    // Jeder C-Run / V-Run wird als EIN Block verarbeitet.
    // Die chunk-Länge entspricht der Run-Länge im Pattern.
    let name = '';
    let pIdx = 0;
    let buildFailed = false;

    while (pIdx < pattern.length) {
      const sym    = pattern[pIdx];
      const runLen = countRun(pattern, pIdx, sym);
      const patLen = pattern.length;

      const progress = pIdx / (patLen || 1);
      const pos = progress < 0.25 ? 'prefix' : progress > 0.75 ? 'suffix' : 'infix';

      let chunk = null;

      if (sym === 'V') {
        // Erst exakte Run-Länge, dann kürzer, dann andere Positionen
        for (let tryLen = runLen; tryLen >= 1 && !chunk; tryLen--) {
          chunk = pickFromPositionBucket(vowelMap?.[pos], probMode, tryLen, true);
        }
        if (!chunk) {
          for (const fp of ['prefix', 'infix', 'suffix']) {
            chunk = pickFromPositionBucket(vowelMap?.[fp], probMode, 1, true);
            if (chunk) break;
          }
        }
        // Kein Vokal-Cluster im JSON gefunden → Versuch abbrechen.
        // FALLBACK_VOWELS entfernt: nur JSON-Daten erlaubt.
        if (!chunk) { buildFailed = true; break; }

      } else { // 'C'
        for (let tryLen = runLen; tryLen >= 1 && !chunk; tryLen--) {
          chunk = pickFromPositionBucket(consonantMap?.[pos], probMode, tryLen, true);
        }
        if (!chunk) {
          for (const fp of ['prefix', 'infix', 'suffix']) {
            chunk = pickFromPositionBucket(consonantMap?.[fp], probMode, 1, true);
            if (chunk) break;
          }
        }
        // Kein Konsonanten-Cluster im JSON gefunden → Versuch abbrechen.
        // FALLBACK_CONSONANTS entfernt: nur JSON-Daten erlaubt.
        if (!chunk) { buildFailed = true; break; }
      }

      name += chunk;
      pIdx += runLen;

      // Frühzeitiger Abbruch wenn Name schon zu lang
      if (name.length > targetLength + 2) { buildFailed = true; break; }
    }

    if (buildFailed) continue;

    const normalized = normalizeName(name);

    // ── Validierung ────────────────────────────────────────────────────
    // a) Länge MUSS exakt in nameLengths vorhanden sein — kein ±1-Fuzzy.
    if (validLengths.length > 0 && !validLengths.includes(normalized.length)) continue;

    // Vokal-only verhindern
    if (!/[bcdfghjklmnpqrstvwxyzß]/i.test(normalized)) continue;

    // Suffix-Validierung: kein Infix- oder Fallback-Cluster darf den Namen
    // beenden — nur bekannte Suffixe sind am Namens-Ende erlaubt.
    if (data?.syllables && !endsWithValidSuffix(normalized, data.syllables)) continue;

    return normalized;
  }

  // Alle 6 Versuche fehlgeschlagen → Silben-Fallback, kein random mehr.
  if (data?.syllables) return generateSyllableName(data, options);
  throw new Error('[generateClusterName] Konnte keinen validen Namen aus JSON-Cluster-Daten erzeugen.');
}

// ═══════════════════════════════════════════════════
// GENERATOR 3: VERBINDUNGSNAMEN (Compound Names)
// Unterstützt zwei Datenformate — automatische Erkennung via
// isStructuredCompoundData() aus compoundBuilder.js
// ═══════════════════════════════════════════════════

/**
 * Baut einen Verbindungsnamen aus compoundData.
 *
 * Unterstützt zwei Formate automatisch:
 *
 *  ── FORMAT A (alt, einfach) ──────────────────────────────────────────────
 *  { "Wolf": ["Wolf", "Wolfs"], "Stein": ["Stein", "Steins"] }
 *  → 2–3 zufällige Lemmata werden aneinandergehängt
 *  → Kein Lemma darf doppelt vorkommen
 *
 *  ── FORMAT B (neu, strukturiert) ─────────────────────────────────────────
 *  { "Wolf": { wortart, position, stamm, formen, fuge }, ... }
 *  → Routing an generateStructuredCompound() (compoundBuilder.js)
 *  → Respektiert position.erst/zweit, Fugenelemente, Wortart-Regeln
 *
 * @param {object} compoundData
 * @param {object} options
 * @returns {string}
 */
export function generateCompoundName(compoundData, options = {}) {
  if (!compoundData || Object.keys(compoundData).length === 0) {
    throw new Error('[generateCompoundName] Keine Verbindungsnamen-Daten (compoundData) vorhanden.');
  }

  // ── Format B: strukturiertes Compound-JSON → compoundBuilder ──────────
  if (isStructuredCompoundData(compoundData)) {
    const result = generateStructuredCompound(compoundData, options);
    if (result) return result;
    throw new Error('[generateCompoundName] Konnte kein Kompositum aus strukturierten Daten bilden.');
  }

  // ── Format A: einfaches Lemma→Varianten-Format (Bestandslogik) ────────
  const lemmas    = Object.keys(compoundData);
  const partCount = randomInt(2, 3);

  const usedLemmas = new Set();
  const parts      = [];

  let attempts = 0;
  while (parts.length < partCount && attempts < lemmas.length * 3) {
    attempts++;

    const available = lemmas.filter(l => !usedLemmas.has(l));
    if (available.length === 0) break;

    const lemma    = randomPick(available);
    const variants = compoundData[lemma];

    if (!variants || variants.length === 0) continue;

    usedLemmas.add(lemma);
    parts.push(randomPick(variants));
  }

  if (parts.length === 0) {
    throw new Error('[generateCompoundName] Konnte keine Lemmata aus compoundData kombinieren.');
  }

  return normalizeName(parts.join(''));
}

// ═══════════════════════════════════════════════════
// GENERATOR 4: KOMPLETT ZUFÄLLIG
// Nur für explizit gewähltes genMethod:'random'.
// KEIN stiller Fallback für Syllable / Cluster mehr.
// ═══════════════════════════════════════════════════

/**
 * Erzeugt einen phonetisch lesbaren Zufallsnamen ohne JSON-Basis.
 * Darf NUR aufgerufen werden, wenn der Nutzer genMethod:'random' explizit
 * gewählt hat — niemals als stiller Fallback für Syllable/Cluster.
 *
 * @param {number} length - Ziel-Zeichenlänge (grob)
 * @returns {string}
 */
export function generateRandomName(length = 6) {
  // Minimale phonetische Basis — KEIN Import aus entfernten FALLBACK_*-Konstanten.
  const vowels     = ['a','e','i','o','u','ae','ie','ei'];
  const consonants = ['b','d','f','g','h','k','l','m','n','p','r','s','t','v','w','z',
                      'br','dr','gr','kl','kr','st','tr','sch','ch'];

  let name = '';
  let wantConsonant = rng() > 0.4;

  while (name.length < length) {
    const chunk = wantConsonant ? randomPick(consonants) : randomPick(vowels);
    name += chunk;
    wantConsonant = !wantConsonant;
    if (name.length > length + 3) break;
  }

  if (name.length > length + 2) name = name.substring(0, length + 1);
  return normalizeName(name);
}


// ═══════════════════════════════════════════════════
// GENERATOR 5: APOSTROPH-NAMEN
// Zwei Teilnamen mit Apostroph verbinden (z. B. Kael'Thas)
// ═══════════════════════════════════════════════════

/**
 * Erzeugt einen Apostroph-Namen aus zwei unabhängig generierten Teilnamen.
 *
 * Strategie:
 * - Teil A: kurze Länge (2–4 Zeichen) — bevorzugt die kleinste JSON-Länge
 * - Teil B: mittlere Länge (4–7 Zeichen) — bevorzugt mittlere JSON-Längen
 * - Verbindung: partA + "'" + partB
 * - Beide Teile nutzen denselben Generator wie der Rest, aber mit
 *   überschriebener Länge, damit sie nicht identisch lang sind.
 *
 * @param {object|null} linguisticData
 * @param {object|null} compoundData
 * @param {object}      options  - { genMethod, probMode, … }
 * @returns {string}
 */
export function generateApostropheName(linguisticData, compoundData, options = {}) {
  const validLengths = getValidLengths(linguisticData);

  // Teile A und B bekommen eigene, unterschiedliche Ziellängen
  const shortLengths  = validLengths.filter(l => l >= 2 && l <= 4);
  const mediumLengths = validLengths.filter(l => l >= 3 && l <= 7);

  const lenA = shortLengths.length  > 0 ? randomPick(shortLengths)  : 3;
  const lenB = mediumLengths.length > 0 ? randomPick(mediumLengths) : 5;

  const optA = { ...options, lengthMode: 'fixed', fixedLength: lenA };
  const optB = { ...options, lengthMode: 'fixed', fixedLength: lenB };

  const method = options.genMethod ?? 'syllable';

  let partA, partB;

  if (method === 'cluster') {
    partA = generateClusterName(linguisticData, optA);
    partB = generateClusterName(linguisticData, optB);
  } else if (method === 'random') {
    partA = generateRandomName(lenA);
    partB = generateRandomName(lenB);
  } else {
    // syllable + auto-mix fallback
    partA = linguisticData?.syllables
      ? generateSyllableName(linguisticData, optA)
      : generateRandomName(lenA);
    partB = linguisticData?.syllables
      ? generateSyllableName(linguisticData, optB)
      : generateRandomName(lenB);
  }

  // Ersten Buchstaben von Teil B großschreiben (nach dem Apostroph)
  const normalA = normalizeName(partA);
  const normalB = normalizeName(partB);

  return `${normalA}'${normalB}`;
}

// ── Apostroph-Generator in die Registry eintragen ────────────────────────────
// Registrierung hier (nicht in specialGenerators.js), um einen zirkulären
// Import zu vermeiden: generator.js importiert bereits specialGenerators.
// Der Early-Return in generateName() greift jetzt sauber über specialType.
specialGenerators['apostrophe'] = generateApostropheName;

// ═══════════════════════════════════════════════════
// DISPATCHER: generateName / generateNames
// ═══════════════════════════════════════════════════

// ═══════════════════════════════════════════════════
// PRIORITÄTS-RESOLVER: Generierungsart
// ═══════════════════════════════════════════════════

/**
 * Ermittelt die tatsächlich verwendbare Generierungsart anhand der
 * vorhandenen Daten. Gibt die höchste verfügbare Priorität zurück,
 * wenn die angeforderte Methode nicht bedient werden kann.
 *
 * Priorität:
 *   1. syllable   (linguisticData.syllables vorhanden)
 *   2. cluster    (linguisticData.vowelCombinations oder consonantCombinations)
 *   3. compound   (compoundData mit mindestens einem Lemma)
 *   4. special    (specialType in Registry vorhanden)
 *   5. random     (immer möglich — explizit gewählt, nie als stiller Fallback)
 *
 * @param {string}      requestedMethod  - 'syllable' | 'cluster' | 'compound' | 'random'
 * @param {object|null} linguisticData
 * @param {object|null} compoundData
 * @param {string|null} specialType
 * @returns {string}  aufgelöste Methode
 * @throws {Error}    wenn keine einzige Methode verfügbar ist
 */
export function resolveGenMethod(requestedMethod, linguisticData, compoundData, specialType) {
  const hasSyllables = Boolean(linguisticData?.syllables);
  const hasClusters  = Boolean(
    linguisticData?.vowelCombinations || linguisticData?.consonantCombinations
  );
  const hasCompounds = Boolean(
    compoundData != null && Object.keys(compoundData).length > 0
  );
  const hasSpecial   = Boolean(
    specialType && specialGenerators[specialType]
  );

  // 'random' ist immer erlaubt — explizit angefragt, kein stiller Fallback.
  if (requestedMethod === 'random') return 'random';

  // Angeforderte Methode direkt prüfen
  if (requestedMethod === 'syllable' && hasSyllables) return 'syllable';
  if (requestedMethod === 'cluster'  && hasClusters)  return 'cluster';
  if (requestedMethod === 'compound' && hasCompounds) return 'compound';

  // Prioritäts-Fallback: nächste verfügbare Methode
  if (hasSyllables) return 'syllable';
  if (hasClusters)  return 'cluster';
  if (hasCompounds) return 'compound';
  if (hasSpecial)   return 'special';

  throw new Error(
    `Keine geeignete Generierungsart für die gewählten Einstellungen vorhanden. ` +
    `(Angefordert: "${requestedMethod}", vorhanden: keine)`
  );
}

// ═══════════════════════════════════════════════════
// DISPATCHER: generateName / generateNames
// ═══════════════════════════════════════════════════

/**
 * Erzeugt einen einzelnen Namen mit der konfigurierten Methode.
 *
 * Ablauf:
 *  1. specialType → Early Return über Registry
 *  2. resolveGenMethod → ermittelt tatsächlich verwendbare Methode
 *  3. Auto-Mix (50/50 compound) wenn linguistische Daten + compound vorhanden
 *  4. Generator aufrufen — kein stiller Fallback mehr
 *
 * @param {object|null} linguisticData
 * @param {object|null} compoundData
 * @param {object}      options  - { genMethod, specialType, probMode, … }
 * @returns {string}
 * @throws {Error}  wenn keine Daten für die Generierung vorhanden sind
 */
export function generateName(linguisticData, compoundData, options = {}) {
  // ── 1. Sonderfall-Prüfung: Registry vor Standardlogik ─────────────────
  const specialType = options.specialType ?? null;
  if (specialType && specialGenerators[specialType]) {
    return specialGenerators[specialType](linguisticData, compoundData, options);
  }

  const requestedMethod = options.genMethod ?? 'syllable';

  // ── 2. Methode auflösen ────────────────────────────────────────────────
  // Wirft einen Error wenn keinerlei Daten vorhanden sind.
  const method = resolveGenMethod(requestedMethod, linguisticData, compoundData, specialType);

  const hasCompound = Boolean(compoundData != null && Object.keys(compoundData).length > 0);

  // ── 3. Auto-Mix ────────────────────────────────────────────────────────
  // Bei syllable/cluster + vorhandenen Verbindungsnamen 50/50 mischen.
  // Gilt nicht für 'random' (kein JSON-Bezug) und nicht für 'compound' (schon ausgewählt).
  if ((method === 'syllable' || method === 'cluster') && hasCompound) {
    if (rng() < 0.5) return generateCompoundName(compoundData, options);
  }

  // ── 4. Generator aufrufen ──────────────────────────────────────────────
  switch (method) {
    case 'syllable':
      return generateSyllableName(linguisticData, options);

    case 'cluster':
      return generateClusterName(linguisticData, options);

    case 'compound':
      return generateCompoundName(compoundData, options);

    case 'random':
      return generateRandomName(pickNameLength(linguisticData ?? {}, options));

    default:
      // Sollte durch resolveGenMethod nie erreicht werden
      throw new Error(`[generateName] Unbekannte Methode: "${method}"`);
  }
}

/**
 * Erzeugt eine Liste von Namen mit Duplikat-Entfernung und
 * optionalem Anfangsbuchstaben-Filter.
 *
 * @param {object|null} linguisticData
 * @param {object|null} compoundData
 * @param {object}      options
 * @param {object}      options.count          - Anzahl (Standard: 10)
 * @param {boolean}     options.generateAll    - alle Kombinationen
 * @param {Set<string>} options.startingLetters - Filter-Set oder null
 * @param {string}      options.nameType       - 'firstName' | 'lastName' | 'fullName'
 * @returns {string[]}
 */
export function generateNames(linguisticData, compoundData, options = {}) {
  const {
    count           = 10,
    generateAll     = false,
    startingLetters = null,   // null = kein Filter
    nameType        = 'firstName',
  } = options;

  const results = new Set();

  // hardMax: obere Schranke für Versuche insgesamt (verhindert Endlosschleife).
  // convergenceLimit: nach N aufeinanderfolgenden Fehlversuchen gilt der
  // Namensraum als erschöpft — frühzeitiger, sauberer Abbruch.
  // Bei generateAll steuert app.js die Menge (MAX_NAMES_PER_LETTER);
  // generateNames selbst bleibt zustandslos und limit-agnostisch.
  const hardMax          = Math.max(count * 60, 500);
  const convergenceLimit = Math.max(count * 6, 60);

  let attempts         = 0;
  let consecutiveNoNew = 0;

  while (attempts < hardMax) {
    attempts++;

    let name = '';

    if (nameType === 'fullName') {
      // Spezialfall: Spezialgenerator liefert bereits einen vollständigen Namen.
      // Nur EINMAL aufrufen — kein firstName+lastName-Split, da der Generator
      // nameType intern verarbeitet und sonst doppelt kombiniert würde.
      if (options.specialType && specialGenerators[options.specialType]) {
        name = generateName(
          linguisticData?.firstName ?? null,
          compoundData?.firstName   ?? null,
          options
        );
      } else {
        const firstName = generateName(
          linguisticData?.firstName ?? null,
          compoundData?.firstName   ?? null,
          options
        );
        const lastName = generateName(
          linguisticData?.lastName ?? null,
          compoundData?.lastName  ?? null,
          options
        );
        name = `${firstName} ${lastName}`.trim();
      }
    } else {
      name = generateName(linguisticData, compoundData, options);
    }

    if (!name || name.length < 2) {
      consecutiveNoNew++;
      continue;
    }

    // Anfangsbuchstaben-Filter
    if (startingLetters && startingLetters.size > 0) {
      const firstLetter = name.charAt(0).toUpperCase();
      if (!startingLetters.has(firstLetter)) {
        consecutiveNoNew++;
        continue;
      }
    }

    const prevSize = results.size;
    results.add(name);

    if (results.size > prevSize) {
      consecutiveNoNew = 0; // neuer eindeutiger Name → Zähler zurücksetzen
    } else {
      consecutiveNoNew++;
    }

    // Ziel erreicht (count-Modus)
    if (!generateAll && results.size >= count) break;

    // Konvergenz: der Namensraum ist erschöpft
    if (consecutiveNoNew >= convergenceLimit) break;
  }

  return [...results];
}
