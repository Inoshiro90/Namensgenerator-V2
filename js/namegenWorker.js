/**
 * namegenWorker.js — Web Worker für CPU-intensive Namensgenerierung
 *
 * Verlagert die gesamte Generierungslogik aus dem Haupt-Thread —
 * UI bleibt während großer Generierungsläufe (10k+ Namen) komplett flüssig.
 *
 * Protokoll (postMessage):
 *
 *   Main → Worker:
 *     { type: 'generate', linguisticData, compoundData, config, letters: string[] }
 *     { type: 'abort' }
 *
 *   Worker → Main:
 *     { type: 'batch',    letter, names: string[], generated: number, letterIndex: number, totalLetters: number }
 *     { type: 'progress', message: string, generated: number }
 *     { type: 'done',     totalGenerated: number }
 *     { type: 'error',    message: string }
 */

import { generateNames, generateSyllableName } from './generator.js';
import { setRNG, resetRNG, createSeededRNG }   from './utils.js';
import { initSpecialGenerators }                from './specialGenerators.js';

// Special Generators benötigen generateSyllableName — einmalig injizieren
initSpecialGenerators({ generateSyllableName });

// ─────────────────────────────────────────────────
// Konfiguration
// ─────────────────────────────────────────────────

export const MAX_NAMES_PER_LETTER = 5_000;
const MEMORY_LIMIT         = 250_000; // Maximale Namen im globalen Seen-Set

// ─────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────

let _aborted = false;

// ─────────────────────────────────────────────────
// Message Handler
// ─────────────────────────────────────────────────

self.addEventListener('message', async (e) => {
  const { type } = e.data;

  if (type === 'abort') {
    _aborted = true;
    return;
  }

  if (type === 'generate') {
    _aborted = false;
    await _runGeneration(e.data);
  }
});

// ─────────────────────────────────────────────────
// Generierungslogik
// ─────────────────────────────────────────────────

async function _runGeneration({ linguisticData, compoundData, config, letters }) {
  try {
    // ── RNG Setup ──────────────────────────────────────────────────────────
    if (config.seed !== null && config.seed !== '') {
      const numSeed = parseInt(config.seed, 10);
      setRNG(createSeededRNG(isNaN(numSeed) ? config.seed : numSeed));
    } else {
      resetRNG();
    }

    // ── Deduplizierungs-Set ───────────────────────────────────────────────
    const seen = new Set();
    let totalGenerated = 0;

    for (let i = 0; i < letters.length; i++) {
      if (_aborted) break;

      const letter = letters[i];

      // Fortschrittsmeldung an den Main-Thread
      self.postMessage({
        type:         'progress',
        message:      `Generiere ${letter}… (${i + 1} / ${letters.length})`,
        generated:    totalGenerated,
        letterIndex:  i,
        totalLetters: letters.length,
      });

      // Config für diesen Buchstaben
      const chunkConfig = {
        ...config,
        generateAll:     false,
        count:           MAX_NAMES_PER_LETTER,
        // Set ist structured-cloneable — direkt übergeben
        startingLetters: new Set([letter]),
      };

      // Namen generieren (synchron, im Worker-Thread)
      const names = generateNames(linguisticData, compoundData, chunkConfig);

      // Deduplizierung + Memory-Limit
      const unique = [];
      for (const name of names) {
        if (seen.size >= MEMORY_LIMIT) break; // Speicherlimit
        if (!seen.has(name)) {
          seen.add(name);
          unique.push(name);
        }
      }

      if (unique.length > 0) {
        totalGenerated += unique.length;
        self.postMessage({
          type:         'batch',
          letter,
          names:        unique,
          generated:    totalGenerated,
          letterIndex:  i,
          totalLetters: letters.length,
        });
      }

      // Yield → Worker-Eventloop kann abort-Nachrichten verarbeiten
      await new Promise(r => setTimeout(r, 0));
    }

    self.postMessage({
      type:           'done',
      totalGenerated,
      aborted:        _aborted,
    });

  } catch (err) {
    self.postMessage({
      type:    'error',
      message: err.message ?? 'Unbekannter Worker-Fehler',
    });
  }
}
