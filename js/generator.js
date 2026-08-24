/**
 * generator.js — Kern-Generierungslogik des Namensgenerators
 *
 * Enthält:
 *  - Silbenbasierte Generierung  (generateSyllableName) — nutzt optional
 *    CV-Patterns für Silbenanzahl & Sonderzeichen (Fallback ohne Patterns)
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
// CV-PATTERN-HELFER (gemeinsam genutzt von Silben- UND Cluster-Generator)
// ═══════════════════════════════════════════════════

/**
 * Klassifiziert ein einzelnes Pattern-Symbol.
 *
 * 'C'/'c' → Konsonant, 'V'/'v' → Vokal, alles andere → Sonderzeichen
 * (wird wörtlich übernommen, z. B. Apostroph, Bindestrich, …).
 *
 * @param {string} ch - ein einzelnes Zeichen aus dem CV-Pattern
 * @returns {'C'|'V'|'SPECIAL'}
 */
function getSymbolType(ch) {
  if (ch === 'V' || ch === 'v') return 'V';
  if (ch === 'C' || ch === 'c') return 'C';
  return 'SPECIAL';
}

/**
 * Zählt aufeinanderfolgende Symbole DESSELBEN TYPS (Konsonant/Vokal) ab
 * Position `start` im Pattern — unabhängig von Groß-/Kleinschreibung.
 * Beispiel: countTypedRun("CcVcvcvc", 0) → 2  ("Cc" ist ein Konsonanten-Run)
 *
 * Sonderzeichen werden NIE zu einem Block zusammengefasst — jedes
 * Sonderzeichen bildet einen eigenen "Run" der Länge 1.
 */
function countTypedRun(pattern, start) {
  const type = getSymbolType(pattern[start]);
  if (type === 'SPECIAL') return 1;
  let n = 0;
  for (let i = start; i < pattern.length && getSymbolType(pattern[i]) === type; i++) n++;
  return n;
}

/**
 * Überträgt die Groß-/Kleinschreibung der Pattern-Symbole auf einen aus dem
 * JSON gezogenen Cluster-String.
 *
 * Beispiel: Pattern-Run "Cc" + Cluster "th" → "Th"
 * (erstes Zeichen groß, weil 'C' im Pattern groß war; zweites klein, weil 'c')
 *
 * Wird der Cluster kürzer als der Pattern-Run gewählt (Fallback auf kürzere
 * Länge), wird nur für die tatsächlich vorhandenen Zeichen Case übernommen.
 *
 * @param {string} chunk    - Cluster-String aus dem JSON (z. B. "th")
 * @param {string} pattern  - das vollständige CV-Pattern
 * @param {number} start    - Startindex des Runs im Pattern
 * @returns {string}
 */
function applyCasePattern(chunk, pattern, start) {
  let out = '';
  // Fallback-Symbol, falls der Cluster laenger ist als der Pattern-Run
  // (z. B. bei inkonsistenten JSON-Daten, wo ein Cluster im falschen
  // Laengen-Bucket abgelegt wurde). In diesem Fall wird die Gross-/
  // Kleinschreibung des zuletzt bekannten Pattern-Symbols fortgesetzt,
  // statt mit "Cannot read properties of undefined" abzustuerzen.
  let lastSymCh = pattern[start] ?? 'c';
  for (let i = 0; i < chunk.length; i++) {
    const symCh = pattern[start + i] ?? lastSymCh;
    lastSymCh = symCh;
    const wantsUpper = symCh === symCh.toUpperCase();
    out += wantsUpper ? chunk[i].toUpperCase() : chunk[i].toLowerCase();
  }
  return out;
}

/**
 * Wählt (gewichtet nach der im JSON hinterlegten Pattern-Wahrscheinlichkeit)
 * ein CV-Pattern für die angegebene Ziellänge aus `data.cvPatterns`.
 *
 * Liefert `null`, wenn für diese Länge keine Patterns vorhanden sind — der
 * aufrufende Generator fällt dann auf sein bisheriges, pattern-loses
 * Verhalten zurück (volle Abwärtskompatibilität).
 *
 * Zusätzlich zum Pattern-String selbst werden zwei abgeleitete Infos
 * geliefert, die der Silben-Generator nutzt, um Struktur und Sonderzeichen
 * eines Silben-Namens am Pattern auszurichten:
 *
 *  - syllableCount: Anzahl der Vokal-Runs (V/v-Blöcke) im Pattern.
 *    Linguistische Faustregel: jeder Vokal-Nukleus trägt eine Silbe.
 *  - specials: Sonderzeichen im Pattern mit ihrer relativen Position
 *    (0..1) innerhalb des Patterns, z. B. { char: "-", relPos: 0.375 }.
 *
 * @param {object} data
 * @param {number} targetLength
 * @returns {{pattern:string, syllableCount:number, specials:Array<{char:string, relPos:number}>}|null}
 */
function pickCvPatternForLength(data, targetLength) {
  const patternMap = data?.cvPatterns?.[targetLength]?.patterns;
  if (!patternMap) return null;

  const entries = Object.entries(patternMap);
  if (entries.length === 0) return null;

  const picked = weightedRandom(entries, ([, prob]) => prob);
  if (!picked) return null;
  const pattern = picked[0];

  let syllableCount = 0;
  const specials    = [];
  let idx = 0;
  while (idx < pattern.length) {
    const type    = getSymbolType(pattern[idx]);
    const runLen  = countTypedRun(pattern, idx);
    if (type === 'V') syllableCount++;
    if (type === 'SPECIAL') specials.push({ char: pattern[idx], relPos: idx / pattern.length });
    idx += runLen;
  }

  return { pattern, syllableCount: Math.max(1, syllableCount), specials };
}

/**
 * Fügt Sonderzeichen aus einem CV-Pattern an ihren relativen Positionen
 * (0..1) in einen bereits zusammengesetzten Silben-Namen ein.
 *
 * Die relative Position wird auf die aktuelle Namenslänge projiziert.
 * Damit kein Sonderzeichen den Namen eröffnet, beendet oder einen
 * bekannten Suffix zerschneidet, wird die Einfügeposition auf den
 * Bereich [1, name.length - reservedTailLength] geklemmt.
 *
 * @param {string} name              - Silben-Name OHNE Sonderzeichen
 * @param {Array<{char:string, relPos:number}>} specials
 * @param {number} reservedTailLength - Länge des Suffix-Endes, das frei
 *                                      von Sonderzeichen bleiben soll
 * @param {number[]} [syllableBoundaries] - Zeichenpositionen in `name`, an
 *   denen eine Silbe endet/beginnt (z. B. nach dem Prefix, nach jedem
 *   Infix). Wird NUR für das Leerzeichen-Sonderzeichen genutzt: ein
 *   Leerzeichen darf ausschließlich an einer solchen Grenze landen, nie
 *   mitten in einer Silbe — sonst entstehen Artefakte wie "Klei N" aus
 *   "Klein" (das "van"/"de"-Leerzeichen aus mehrteiligen Quellnamen wie
 *   "de Boer" traf sonst per Zufallsposition mitten ins Wort).
 *   Andere Sonderzeichen (Apostroph, Bindestrich, …) sind davon nicht
 *   betroffen und werden weiterhin frei positioniert — dort ist eine
 *   Position mitten im Wort sprachlich normal (z. B. "O'Brien").
 *
 *   Zusätzlich gilt für Leerzeichen: die dadurch entstehenden Wortteile
 *   (davor UND danach) müssen mindestens MIN_ISOLATED_SEGMENT_LENGTH
 *   Zeichen lang sein — verhindert kosmetisch auffällige Einzelbuchstaben-
 *   "Wörter" wie "E Brands" oder "Schoen De".
 * @returns {string}
 */
function insertSpecialsByRelativePosition(name, specials, reservedTailLength = 0, syllableBoundaries = null) {
  if (!specials || specials.length === 0) return name;

  // Mindestlänge für ein isoliert (durch Leerzeichen abgetrennt) stehendes
  // Namenssegment. Gilt für beide Seiten des Leerzeichens.
  const MIN_ISOLATED_SEGMENT_LENGTH = 2;

  let result = name;
  let offset = 0;
  const baseLength = name.length;
  // Position (im aktuellen `result`), ab der das laufende Segment beginnt —
  // wird nach jedem eingefügten Leerzeichen aktualisiert.
  let segmentStart = 0;

  for (const { char, relPos } of specials) {
    const basePos = Math.round(relPos * baseLength) + offset;
    const maxPos  = result.length - reservedTailLength;
    if (maxPos < 1) continue; // Name zu kurz, um sicher einzufügen → überspringen

    let insertPos = Math.min(maxPos, Math.max(1, basePos));

    // Leerzeichen dürfen nur an bekannten Silbengrenzen landen — sonst
    // lieber ganz weglassen als eine Silbe zerschneiden. Zusätzlich müssen
    // beide entstehenden Wortteile mindestens MIN_ISOLATED_SEGMENT_LENGTH
    // Zeichen lang sein.
    if (char === ' ') {
      const validBoundaries = (syllableBoundaries ?? [])
        .map(b => b + offset)
        .filter(b =>
          b >= 1 &&
          b <= maxPos &&
          (b - segmentStart) >= MIN_ISOLATED_SEGMENT_LENGTH &&
          (result.length - b) >= MIN_ISOLATED_SEGMENT_LENGTH
        );

      if (validBoundaries.length === 0) continue; // kein sicherer Platz → überspringen

      insertPos = validBoundaries.reduce((best, b) =>
        Math.abs(b - insertPos) < Math.abs(best - insertPos) ? b : best
      );
      segmentStart = insertPos + 1; // +1: das eingefügte Leerzeichen selbst zählt nicht mit
    }

    result = result.slice(0, insertPos) + char + result.slice(insertPos);
    offset += char.length;
  }

  return result;
}

// ═══════════════════════════════════════════════════
// GENERATOR 1: SILBENBASIERT
// Prefix → Infix(e) → Suffix
// ═══════════════════════════════════════════════════

/**
 * Baut einen Namen aus vordefinierten Silben zusammen.
 *
 * Strategie:
 * - Wählt eine Prefix-Silbe
 * - Fügt Infix-Silben hinzu, bis die Ziellänge annähernd erreicht ist
 * - Schließt mit einem Suffix ab
 *
 * CV-Pattern-Anbindung (optional, mit Fallback):
 * - Ist für die Ziellänge ein CV-Pattern vorhanden, wird daraus die
 *   ungefähre Silbenanzahl (= Anzahl der Vokal-Runs im Pattern) abgeleitet
 *   und begrenzt, wie viele Infixe maximal angehängt werden — der Aufbau
 *   bleibt damit näher an der im Pattern vorgesehenen Struktur.
 * - Enthält das Pattern Sonderzeichen (Apostroph, Bindestrich, …), werden
 *   diese an ihrer relativen Pattern-Position in den fertigen Silben-Namen
 *   eingefügt (Suffix-Ende bleibt dabei immer unangetastet).
 * - Fehlt ein passendes Pattern für die Ziellänge, verhält sich der
 *   Generator exakt wie zuvor — keine Pflicht-Abhängigkeit von cvPatterns.
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

  // ── CV-Pattern für die Ziellänge ermitteln (optional) ────────────────
  // Liefert null, wenn keine Patterns vorhanden sind → Generator arbeitet
  // dann unverändert wie bisher (reine Längensteuerung, keine Sonderzeichen).
  const patternInfo    = pickCvPatternForLength(data, targetLength);
  const specialsCount  = patternInfo?.specials?.length ?? 0;
  // Silben-Aufbau zielt auf (Ziellänge − Sonderzeichen), die Sonderzeichen
  // werden danach separat eingefügt, um exakt auf targetLength zu kommen.
  const syllableTarget = Math.max(1, targetLength - specialsCount);
  // Maximal erlaubte Infix-Anzahl aus der Pattern-Silbenzahl (Prefix + Suffix
  // zählen bereits als 2 Silben). Ohne Pattern: keine Begrenzung (Altverhalten).
  const maxInfixes     = patternInfo ? Math.max(0, patternInfo.syllableCount - 2) : Infinity;

  // 20 Versuche (vorher: 8) — mehr Spielraum für kurze Silben-Pools,
  // bei denen Länge + Konsonant selten zusammentreffen.
  for (let attempt = 0; attempt < 20; attempt++) {
    let name = '';
    // Positionen, an denen eine Silbe endet/beginnt (nach Prefix, nach
    // jedem Infix). Wird nur gebraucht, damit ein Leerzeichen-Sonderzeichen
    // niemals mitten in eine Silbe eingefügt wird — siehe
    // insertSpecialsByRelativePosition().
    const syllableBoundaries = [];

    // 1. Prefix
    const prefix = pickFromPositionBucket(syl.prefix, probMode, null);
    if (prefix) name += prefix;
    syllableBoundaries.push(name.length);

    // 2. Suffix-Kandidat vorab bestimmen, damit der Platz reserviert wird
    const suffixCandidate = pickFromPositionBucket(syl.suffix, probMode, null) ?? '';

    // 3. Infix einfügen bis (name + suffix) die Ziellänge EXAKT erreicht oder
    //    um max. 1 Zeichen unterschreitet (Suffix schließt dann ab).
    //    Zusätzlich durch maxInfixes begrenzt, wenn ein CV-Pattern vorliegt.
    if (syl.infix) {
      let safety = 0;
      let infixesUsed = 0;
      while (
        (name.length + suffixCandidate.length) < syllableTarget &&
        safety < 20 &&
        infixesUsed < maxInfixes
      ) {
        const infix = pickFromPositionBucket(syl.infix, probMode, null);
        if (!infix) break;
        if (name.length + infix.length + suffixCandidate.length > syllableTarget + 1) break;
        name += infix;
        syllableBoundaries.push(name.length);
        safety++;
        infixesUsed++;
      }
    }

    // 4. Suffix anhängen
    name += suffixCandidate;

    // 5. Sonderzeichen aus dem CV-Pattern einfügen (falls vorhanden).
    //    reservedTailLength = suffixCandidate.length stellt sicher, dass
    //    der Suffix am Namensende intakt bleibt (wichtig für Schritt c
    //    der Validierung weiter unten).
    if (specialsCount > 0) {
      name = insertSpecialsByRelativePosition(
        name,
        patternInfo.specials,
        suffixCandidate.length,
        syllableBoundaries
      );
    }

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
    //    Verhindert, dass Infixe, Prefixe oder Sonderzeichen fälschlicherweise
    //    am Ende stehen.
    if (!endsWithValidSuffix(normalized, syl)) continue;

    return normalized;
  }

  // Alle Versuche fehlgeschlagen → Minimalname aus Prefix + Suffix,
  // aber NUR wenn er die vollen Validierungsregeln (Länge + Konsonant) besteht.
  // Kein stilles Return mehr bei reinen Vokal-Kombinationen wie "a" + "o" → "Ao".
  // (Pattern-Anbindung greift hier bewusst nicht — reiner Notfall-Fallback.)
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

  // Vokal-only Patterns herausfiltern (müssen mindestens einen Konsonanten
  // enthalten — Groß- ODER Kleinschreibung, also 'C' oder 'c').
  const validPatterns = Object.entries(patternMap).filter(([pat]) => /[Cc]/.test(pat));
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
      const sym  = pattern[pIdx];
      const type = getSymbolType(sym);

      // ── Sonderzeichen: wörtlich übernehmen, kein Cluster-Lookup ────────
      // z. B. Apostroph, Bindestrich, … werden 1:1 aus dem Pattern in den
      // Namen kopiert und brechen jeden laufenden C/V-Run ab.
      if (type === 'SPECIAL') {
        name += sym;
        pIdx += 1;
        continue;
      }

      const runLen = countTypedRun(pattern, pIdx);
      const patLen = pattern.length;

      const progress = pIdx / (patLen || 1);
      const pos = progress < 0.25 ? 'prefix' : progress > 0.75 ? 'suffix' : 'infix';

      let chunk = null;

      // Verwirft Cluster, die trotz Bucket-Anfrage laenger sind als der
      // Platz, der im Pattern ab pIdx tatsaechlich noch zur Verfuegung
      // steht (Schutz gegen inkonsistente/zukuenftige JSON-Daten, bei
      // denen ein Cluster im falschen Laengen-Bucket liegt).
      const fitsRemainingPattern = (c) => !!c && (pIdx + c.length) <= patLen;

      if (type === 'V') {
        // Erst exakte Run-Länge, dann kürzer, dann andere Positionen
        for (let tryLen = runLen; tryLen >= 1 && !chunk; tryLen--) {
          const candidate = pickFromPositionBucket(vowelMap?.[pos], probMode, tryLen, true);
          if (fitsRemainingPattern(candidate)) chunk = candidate;
        }
        if (!chunk) {
          for (const fp of ['prefix', 'infix', 'suffix']) {
            const candidate = pickFromPositionBucket(vowelMap?.[fp], probMode, 1, true);
            if (fitsRemainingPattern(candidate)) { chunk = candidate; break; }
          }
        }
        // Kein passender Vokal-Cluster im JSON gefunden → Versuch abbrechen.
        // FALLBACK_VOWELS entfernt: nur JSON-Daten erlaubt.
        if (!chunk) { buildFailed = true; break; }

      } else { // 'C'
        for (let tryLen = runLen; tryLen >= 1 && !chunk; tryLen--) {
          const candidate = pickFromPositionBucket(consonantMap?.[pos], probMode, tryLen, true);
          if (fitsRemainingPattern(candidate)) chunk = candidate;
        }
        if (!chunk) {
          for (const fp of ['prefix', 'infix', 'suffix']) {
            const candidate = pickFromPositionBucket(consonantMap?.[fp], probMode, 1, true);
            if (fitsRemainingPattern(candidate)) { chunk = candidate; break; }
          }
        }
        // Kein passender Konsonanten-Cluster im JSON gefunden → Versuch abbrechen.
        // FALLBACK_CONSONANTS entfernt: nur JSON-Daten erlaubt.
        if (!chunk) { buildFailed = true; break; }
      }

      // Groß-/Kleinschreibung jedes Zeichens gemäß Pattern-Symbol übertragen
      // (C/V → groß, c/v → klein) — zeichenweise über den Run hinweg.
      name += applyCasePattern(chunk, pattern, pIdx);
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