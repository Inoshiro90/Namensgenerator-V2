/**
 * specialGenerators.js — Registry für Sonderfall-Generatoren
 *
 * Erweiterungspunkt für Völker, die nicht der Standard-Logik folgen
 * (Silben / Cluster / Compound).
 *
 * Verwendung in peoples.json:
 *   { "id": "warforged", "label": "Kriegsgeschmiedete", "specialType": "warforged", ... }
 *
 * Neue Völker einfach in die Registry eintragen:
 *   specialGenerators['meinVolk'] = (linguisticData, compoundData, options) => '...';
 */

import {normalizeName, randomPick, randomInt} from './utils.js';

// ═══════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════

/**
 * Map von specialType-Key → Generatorfunktion.
 * Jede Funktion hat die Signatur:
 *   (linguisticData, compoundData, options) → string
 *
 * Sind für einen Typ keine Daten vorhanden, sollte die Funktion
 * trotzdem einen plausiblen Fallback liefern.
 */
export const specialGenerators = {};

// ═══════════════════════════════════════════════════
// HILFSFUNKTIONEN
// ═══════════════════════════════════════════════════

/**
 * Transformiert einen Namen in Leetspeak.
 *
 * Zeichenersetzung (erweiterbar über das `rules`-Objekt):
 *   a → 4   e → 3   i → 1   o → 0
 *   s → 5   t → 7   b → 8   g → 9
 *
 * @param {string} name
 * @param {Object} [rules] - optionale Überschreibungen
 * @returns {string}
 */
export function toLeetspeak(name, rules = {}) {
	const DEFAULT_RULES = {
		a: '4',
		A: '4',
		e: '3',
		E: '3',
		i: '1',
		I: '1',
		o: '0',
		O: '0',
		s: '5',
		S: '5',
		t: '7',
		T: '7',
		b: '8',
		B: '8',
		g: '9',
		G: '9',
	};
	const map = {...DEFAULT_RULES, ...rules};
	return name
		.split('')
		.map((c) => map[c] ?? c)
		.join('');
}

/**
 * Generiert eine Kriegsgeschmiedeten-Seriennummer in einem konfigurierbaren
 * Format.
 *
 * Platzhalter im Format-String:
 *   XX  → 2-stellige Dezimalzahl   (00–99)
 *   XXX → 3-stellige Dezimalzahl  (000–999)
 *   HH  → 2-stellige Hexadezimalzahl (00–FF)
 *
 * @param {string} [format='XX.XX.XX.XXX']
 * @returns {string}
 */
export function generateSerialNumber(format = 'XX.XX.XX.XXX') {
	return format
		.replace(/XXX/g, () => String(randomInt(0, 999)).padStart(3, '0'))
		.replace(/HH/g, () => randomInt(0, 255).toString(16).toUpperCase().padStart(2, '0'))
		.replace(/XX/g, () => String(randomInt(0, 99)).padStart(2, '0'));
}

// ═══════════════════════════════════════════════════
// SONDERFALL 1: Kriegsgeschmiedete (Warforged)
// ═══════════════════════════════════════════════════

/** Vorname-Pool — kann über linguisticData.names überschrieben werden */
const WARFORGED_FIRST_NAMES = [
	'Schild',
	'Wächter',
	'Klinge',
	'Hammer',
	'Amboss',
	'Festung',
	'Panzer',
	'Bastion',
	'Treue',
	'Ordnung',
	'Pflicht',
	'Stärke',
	'Wille',
	'Schutz',
	'Kraft',
	'Ehre',
	'Stolz',
	'Mut',
	'Titan',
	'Ramme',
	'Säule',
	'Faust',
	'Sturm',
	'Stein',
];

/**
 * Generiert einen Kriegsgeschmiedeten-Namen.
 *
 * - Vorname: festes Wort aus dem Pool (oder aus linguisticData.names)
 * - Nachname: Seriennummer im Format XX.XX.XX.XXX
 *
 * @param {object|null} linguisticData
 * @param {object|null} compoundData   (wird nicht verwendet)
 * @param {object}      options        - { nameType, serialFormat? }
 * @returns {string}
 */
function generateWarforgedName(linguisticData, compoundData, options = {}) {
	const nameType = options.nameType ?? 'firstName';
	const serialFormat = options.serialFormat ?? 'XX.XX.XX.XXX';

	// Vorname-Pool: nutze vorhandene Daten wenn verfügbar
	const pool = linguisticData?.names ?? WARFORGED_FIRST_NAMES;
	const firstName = normalizeName(randomPick(pool) ?? 'Wächter');
	const lastName = generateSerialNumber(serialFormat);

	switch (nameType) {
		case 'firstName':
			return firstName;
		case 'lastName':
			return lastName;
		case 'fullName':
			return `${firstName} ${lastName}`;
		default:
			return firstName;
	}
}

specialGenerators['warforged'] = generateWarforgedName;

// ═══════════════════════════════════════════════════
// SONDERFALL 2: Autognome
// ═══════════════════════════════════════════════════

/**
 * Generiert einen Autognom-Namen.
 *
 * Strategie: normalen Namen per Silbengenerator erstellen, dann
 * Leetspeak-Transformation anwenden.
 *
 * Benötigt eine linguisticData-Quelle (z. B. Gnom-Daten).
 * Fallback: zufälliger Name aus AUTOGNOME_FALLBACK_NAMES.
 *
 * @param {object|null} linguisticData
 * @param {object|null} compoundData
 * @param {object}      options
 * @returns {string}
 */

const AUTOGNOME_FALLBACK_NAMES = [
	'Zapta',
	'Bimble',
	'Nix',
	'Cog',
	'Gizmo',
	'Ratchet',
	'Sprocket',
	'Tinker',
	'Widget',
	'Gadget',
	'Boltz',
	'Servo',
	'Vex',
	'Flux',
];

function generateAutognomeName(linguisticData, compoundData, options = {}) {
	const nameType = options.nameType ?? 'firstName';

	// Basis-Namen über Standardlogik oder Fallback
	let baseName;
	if (linguisticData?.syllables) {
		// Lazy-Import-Pattern: Standardgenerator aus demselben Bundle nutzen
		// (wird zur Laufzeit aufgelöst — kein Zirkelbezug)
		const {generateSyllableName} = _getStdGenerator();
		baseName = generateSyllableName(linguisticData, options);
	} else {
		baseName = normalizeName(randomPick(AUTOGNOME_FALLBACK_NAMES) ?? 'Cog');
	}

	if (nameType === 'lastName') {
		// Nachname bleibt normal (kein Leetspeak-Nachname)
		return baseName;
	}

	const leet = toLeetspeak(baseName);

	if (nameType === 'fullName') {
		const lastName = normalizeName(randomPick(AUTOGNOME_FALLBACK_NAMES) ?? 'Boltz');
		return `${leet} ${lastName}`;
	}

	return leet; // firstName
}

/**
 * Lazy-Accessor für den Standardgenerator — verhindert Zirkelbezüge
 * beim direkten Import von generator.js.
 * Wird beim ersten Aufruf gecacht.
 */
let _stdGeneratorCache = null;
function _getStdGenerator() {
	if (!_stdGeneratorCache) {
		// Dynamischer Import wäre ideal, aber da wir synchron in einem
		// ES-Modul-Kontext arbeiten, nutzen wir eine einfachere Lösung:
		// generateSyllableName wird von außen injiziert (siehe initSpecialGenerators).
		throw new Error(
			'[specialGenerators] _stdGenerator nicht initialisiert. ' +
				'initSpecialGenerators(generateSyllableName) aufrufen.',
		);
	}
	return _stdGeneratorCache;
}

/**
 * Injiziert den Standardgenerator in das specialGenerators-Modul.
 * Muss einmalig in app.js aufgerufen werden, bevor Autognome generiert werden.
 *
 * @param {{ generateSyllableName: Function }} generators
 */
export function initSpecialGenerators(generators) {
	_stdGeneratorCache = generators;
}

specialGenerators['autognome'] = generateAutognomeName;

// ═══════════════════════════════════════════════════
// ERWEITERUNGSPUNKT
// ═══════════════════════════════════════════════════
// Neue Sonderfälle hinzufügen:
//
//   import { specialGenerators } from './specialGenerators.js';
//
//   specialGenerators['meinVolk'] = (linguisticData, compoundData, options) => {
//     return 'Generierter Name';
//   };
//
// Und in peoples.json:
//   { "specialType": "meinVolk", ... }
