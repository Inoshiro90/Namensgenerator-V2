/**
 * compoundTaxonomy.js — Semantische Kategorien für die Komposita-Prüfung
 *
 * REINES MODUL (kein DOM). Liest die vom Lexikon-Generator exportierte
 * Taxonomie (`data._taxonomie`) und beantwortet eine Frage:
 * "Sind zwei Primärkategorien semantisch redundant?"
 *
 * Datenformat (Auszug aus dem Lexikon-JSON):
 *   "_taxonomie": {
 *     "version": 1,
 *     "knoten": {
 *       "material":           { "name": "Material",  "parent": null },
 *       "material.edelstein": { "name": "Edelstein",  "parent": "material" },
 *       "konzept.farbe":      { "name": "Farbe",      "parent": "konzept" }
 *     }
 *   }
 *   Eintrag: "semantik": { "primaer": "material.edelstein", "weitere": ["konzept.farbe"] }
 *
 * Regel (identisch zum Lexikon-Generator, js/taxonomy.js → taxCollides):
 *  - Nur die PRIMÄRkategorie blockiert; "weitere" Kategorien nie.
 *  - Redundant, wenn beide Primärkategorien derselbe Knoten sind ODER beide im
 *    Teilbaum eines Knotens mit `blockiereTeilbaum: true` liegen.
 *  - Fehlende oder unbekannte Kategorien blockieren nie (Altdaten bleiben gültig).
 */

const indexCache = new WeakMap();

/**
 * Baut aus data._taxonomie einen Lookup. Gibt null zurück, wenn keine
 * (gültige) Taxonomie vorhanden ist → dann findet keine Kategorieprüfung statt.
 *
 * @param {object} data — Compound-JSON (flach oder gruppiert)
 * @returns {{ parent: Map<string, string|null>, block: Set<string> } | null}
 */
export function getTaxonomyIndex(data) {
  if (!data || typeof data !== 'object') return null;
  if (indexCache.has(data)) return indexCache.get(data);

  let index = null;
  const knoten = data._taxonomie?.knoten;
  if (knoten && typeof knoten === 'object' && !Array.isArray(knoten)) {
    const parent = new Map();
    const block = new Set();
    for (const [id, node] of Object.entries(knoten)) {
      if (!node || typeof node !== 'object') continue;
      parent.set(id, typeof node.parent === 'string' ? node.parent : null);
      if (node.blockiereTeilbaum === true) block.add(id);
    }
    if (parent.size > 0) index = { parent, block };
  }

  indexCache.set(data, index);
  return index;
}

/** Pfad Knoten → Wurzel (inkl. Knoten selbst); zyklensicher. */
function ancestorsOf(index, id) {
  const out = [];
  const seen = new Set();
  let cur = id;
  while (typeof cur === 'string' && index.parent.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = index.parent.get(cur);
  }
  return out;
}

/**
 * @param {{ parent: Map, block: Set } | null} index
 * @param {string|null|undefined} idA — Primärkategorie Erstglied
 * @param {string|null|undefined} idB — Primärkategorie Zweitglied
 * @returns {boolean} true = semantisch redundant → Kombination blockieren
 */
export function categoriesCollide(index, idA, idB) {
  if (!index || !idA || !idB) return false;
  if (!index.parent.has(idA) || !index.parent.has(idB)) return false;
  if (idA === idB) return true;
  if (index.block.size === 0) return false;
  const pathB = new Set(ancestorsOf(index, idB));
  for (const anc of ancestorsOf(index, idA)) {
    if (pathB.has(anc) && index.block.has(anc)) return true;
  }
  return false;
}

/**
 * Primärkategorie eines Lexikoneintrags (oder null).
 * @param {object} entry
 * @returns {string|null}
 */
export function primaryCategory(entry) {
  const p = entry?.semantik?.primaer;
  return typeof p === 'string' && p ? p : null;
}
