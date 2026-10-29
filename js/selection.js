/**
 * selection.js — Systeme, Völker, Untergruppen & Auswahlauflösung
 *
 * Zentrale, DOM-freie Logik für die Hierarchie
 *
 *     System  →  Volk  →  (optionale) Untergruppe  →  Geschlecht
 *
 * Verantwortlich für:
 *  - Zusammenführen + Validieren von data/systems.json und data/peoples.json
 *    zu einem Katalog (eindeutige Identität = System-ID + Volks-ID)
 *  - Verfügbarkeitsprüfung: Welche Einträge besitzen für eine Namensart
 *    tatsächlich ladbare Namensdaten?
 *  - Auflösung zufälliger Auswahlen in fester Reihenfolge über den zentralen,
 *    seedbaren RNG aus utils.js (randomPick)
 *  - Auflösung geschlechtsspezifischer Dateipfade (inkl. Fallback-Kette)
 *  - Validierung & Zusammenführung von JSON-Importen
 *  - Aufbereitung der Dropdown-Optionen (View-Modelle für uiController.js)
 *
 * Datenmodell (siehe DATENMODELL.md):
 *  - Systeme:  data/systems.json  → [{ id, label, shortLabel? }]
 *  - Völker:   data/peoples.json  → [{ id, label, system, files? | languageFamilies?, specialType? }]
 *  - Untergruppen: languageFamilies[] eines Volkes → [{ id, label, files, specialType? }]
 *
 * Ein System gilt als „vorbereitet“, solange ihm kein Volk zugeordnet ist,
 * und als „ohne verwendbare Daten“, wenn keine seiner Datenreferenzen
 * erreichbar ist. Beides wird aus den Metadaten + der Dateiprüfung
 * abgeleitet — es gibt bewusst kein separates Verfügbarkeits-Flag.
 */

import {randomPick} from './utils.js';

// ═══════════════════════════════════════════════════
// KONSTANTEN
// ═══════════════════════════════════════════════════

/** Auswahlstrategie „Zufall“ — niemals eine echte System-/Volks-ID. */
export const RANDOM = 'random';

/** Bekannte Geschlechter-Schlüssel in den files-Objekten (feste Reihenfolge = RNG-stabil). */
export const GENDERS = ['male', 'female', 'neutral'];

/** Bekannte Namensarten. */
export const NAME_TYPES = ['firstName', 'lastName', 'fullName'];

/** Systemzuordnung für importierte Alt-Datensätze ohne `system`-Feld. */
export const CUSTOM_SYSTEM = Object.freeze({
	id: 'custom',
	label: 'Eigene Daten (Import)',
	shortLabel: 'Import',
});

const DEFAULT_NAME_TYPE_LABELS = {
	firstName: 'Vorname',
	lastName: 'Nachname',
	fullName: 'Vor- & Nachname',
};

// ═══════════════════════════════════════════════════
// FEHLERKLASSEN
// ═══════════════════════════════════════════════════

/** Benutzerverständlicher Fehler bei der Auflösung einer Auswahl. */
export class SelectionError extends Error {
	/**
	 * @param {string} message
	 * @param {string} code - maschinenlesbarer Fehlercode (für Tests/Diagnose)
	 */
	constructor(message, code) {
		super(message);
		this.name = 'SelectionError';
		this.code = code;
	}
}

/** Validierungsfehler eines Imports — enthält alle gefundenen Probleme. */
export class CatalogValidationError extends Error {
	/** @param {string[]} problems */
	constructor(problems) {
		super(problems.join(' · '));
		this.name = 'CatalogValidationError';
		this.problems = problems;
	}
}

// ═══════════════════════════════════════════════════
// KATALOG AUFBAUEN & VALIDIEREN
// ═══════════════════════════════════════════════════

/**
 * Erzeugt einen leeren Katalog.
 * @returns {{systems: object[], peoples: object[]}}
 */
export function createEmptyCatalog() {
	return {systems: [], peoples: []};
}

/**
 * Baut den Katalog aus den Rohdaten der beiden Metadatendateien.
 * Fehlerhafte Einträge werden übersprungen und als `issues` gemeldet
 * (nicht strikt — eine einzelne fehlerhafte Zeile legt die App nicht lahm).
 *
 * @param {Array|null} systemsRaw - Inhalt von systems.json (null = nicht ladbar)
 * @param {Array|null} peoplesRaw - Inhalt von peoples.json
 * @returns {{catalog: object, issues: string[]}}
 */
export function buildCatalog(systemsRaw, peoplesRaw) {
	const issues = [];
	let systems = systemsRaw;

	// Fall 1: Systemverzeichnis nicht ladbar → Systeme aus den Volkszuordnungen
	// ableiten (ID als Anzeigename), damit vorhandene Daten nutzbar bleiben.
	if (!Array.isArray(systems)) {
		issues.push('Systemverzeichnis (systems.json) fehlt oder ist ungültig — Systeme werden aus peoples.json abgeleitet.');
		const ids = [];
		for (const p of Array.isArray(peoplesRaw) ? peoplesRaw : []) {
			if (typeof p?.system === 'string' && p.system !== RANDOM && !ids.includes(p.system)) ids.push(p.system);
		}
		systems = ids.map((id) => ({id, label: id}));
	}

	const result = mergeIntoCatalog(
		createEmptyCatalog(),
		{systems, peoples: Array.isArray(peoplesRaw) ? peoplesRaw : []},
		{strict: false},
	);
	return {catalog: result.catalog, issues: [...issues, ...result.issues]};
}

/**
 * Fügt Systeme und Völker zu einem bestehenden Katalog hinzu.
 * Der übergebene Katalog wird NICHT verändert — es wird ein neuer erzeugt.
 *
 * Regeln:
 *  - Systeme: eindeutige ID; bereits vorhandene IDs werden nicht überschrieben.
 *  - Völker: benötigen `system` (Ausnahme: `defaultSystemId` gesetzt).
 *    Das System muss existieren (im Katalog oder in derselben Lieferung).
 *  - Eindeutigkeit: Volks- UND Untergruppen-IDs teilen sich einen Namensraum
 *    pro System. „human“ darf also in mehreren Systemen existieren, aber nicht
 *    zweimal im selben System.
 *  - strict = true: irgendein Problem → CatalogValidationError, nichts wird übernommen.
 *
 * @param {object} catalog
 * @param {{systems?: Array, peoples?: Array}} payload
 * @param {{strict?: boolean, defaultSystemId?: string|null}} [options]
 * @returns {{catalog: object, issues: string[], notes: string[], added: {systems: object[], peoples: object[]}}}
 */
export function mergeIntoCatalog(catalog, payload, {strict = false, defaultSystemId = null} = {}) {
	const issues = [];
	const notes = [];
	const systems = [...catalog.systems];
	const peoples = [...catalog.peoples];
	const added = {systems: [], peoples: []};

	// ── Systeme ──────────────────────────────────────
	for (const raw of payload.systems ?? []) {
		const id = raw?.id;
		if (!_isValidId(id)) {
			issues.push(`System mit ungültiger ID ${JSON.stringify(id)} übersprungen.`);
			continue;
		}
		if (systems.some((s) => s.id === id)) {
			if (strict) notes.push(`System „${id}“ existiert bereits und wurde nicht verändert.`);
			else issues.push(`System „${id}“ ist doppelt definiert — zweiter Eintrag ignoriert.`);
			continue;
		}
		const system = {
			id,
			label: typeof raw.label === 'string' && raw.label.trim() ? raw.label : id,
			shortLabel: typeof raw.shortLabel === 'string' && raw.shortLabel.trim() ? raw.shortLabel : null,
		};
		systems.push(system);
		added.systems.push(system);
	}

	// System für Alt-Importe ohne Zuordnung bei Bedarf anlegen
	const needsDefault =
		defaultSystemId &&
		(payload.peoples ?? []).some((p) => p && p.system === undefined) &&
		!systems.some((s) => s.id === defaultSystemId);
	if (needsDefault) {
		const sys = defaultSystemId === CUSTOM_SYSTEM.id
			? {...CUSTOM_SYSTEM}
			: {id: defaultSystemId, label: defaultSystemId, shortLabel: null};
		systems.push(sys);
		added.systems.push(sys);
	}

	// ── Namensräume pro System (bestehende Einträge) ─
	const namespaces = new Map(); // systemId → Set<id>
	const ns = (sid) => {
		if (!namespaces.has(sid)) namespaces.set(sid, new Set());
		return namespaces.get(sid);
	};
	for (const p of peoples) {
		ns(p.systemId).add(p.id);
		for (const s of p.subgroups) ns(p.systemId).add(s.id);
	}

	// ── Völker ───────────────────────────────────────
	for (const raw of payload.peoples ?? []) {
		if (!raw || typeof raw !== 'object') {
			issues.push('Ungültiger Volkseintrag (kein Objekt) übersprungen.');
			continue;
		}
		const where = `Volk „${raw.label ?? raw.id ?? '?'}“`;

		if (!_isValidId(raw.id) || typeof raw.label !== 'string') {
			issues.push(`${where}: benötigt eine gültige „id“ und ein „label“.`);
			continue;
		}

		let systemId = raw.system;
		if (systemId === undefined && defaultSystemId) systemId = defaultSystemId;

		if (systemId === undefined || systemId === null) {
			issues.push(`${where}: keine Systemzuordnung („system“) — ignoriert.`);
			continue;
		}
		if (!systems.some((s) => s.id === systemId)) {
			issues.push(`${where}: verweist auf unbekanntes System „${systemId}“.`);
			continue;
		}

		const space = ns(systemId);
		if (space.has(raw.id)) {
			issues.push(`${where}: ID „${raw.id}“ existiert im System „${systemId}“ bereits.`);
			continue;
		}

		const people = {
			key: `${systemId}/${raw.id}`,
			id: raw.id,
			label: raw.label,
			systemId,
			specialType: typeof raw.specialType === 'string' ? raw.specialType : null,
			files: _sanitizeFiles(raw.files, where, issues),
			subgroups: [],
			hasSubgroups: false,
			leaves: [],
		};

		// Untergruppen (bisheriges Format: languageFamilies)
		const rawSubs = Array.isArray(raw.languageFamilies) ? raw.languageFamilies : [];
		const localIds = new Set([raw.id]);
		let subgroupProblem = false;
		for (const sub of rawSubs) {
			const subWhere = `${where} → Untergruppe „${sub?.label ?? sub?.id ?? '?'}“`;
			if (!sub || !_isValidId(sub.id) || typeof sub.label !== 'string') {
				issues.push(`${subWhere}: benötigt eine gültige „id“ und ein „label“.`);
				subgroupProblem = true;
				continue;
			}
			if (space.has(sub.id) || localIds.has(sub.id)) {
				issues.push(`${subWhere}: ID „${sub.id}“ existiert im System „${systemId}“ bereits.`);
				subgroupProblem = true;
				continue;
			}
			localIds.add(sub.id);
			people.subgroups.push({
				key: `${systemId}/${sub.id}`,
				id: sub.id,
				label: sub.label,
				systemId,
				parentId: raw.id,
				specialType: typeof sub.specialType === 'string' ? sub.specialType : null,
				files: _sanitizeFiles(sub.files, subWhere, issues),
			});
		}
		if (strict && subgroupProblem) continue;

		people.hasSubgroups = people.subgroups.length > 0;
		people.leaves = people.hasSubgroups ? people.subgroups : [people];

		for (const id of localIds) space.add(id);
		peoples.push(people);
		added.peoples.push(people);
	}

	if (strict && issues.length > 0) {
		throw new CatalogValidationError(issues);
	}

	return {catalog: {systems, peoples}, issues, notes, added};
}

/**
 * Erkennt und normalisiert Import-Inhalte mit Völker-Metadaten.
 *
 * Unterstützte Formate:
 *  1. Bisheriges Format: Array von Völkern  → [{ id, label, files | languageFamilies, system? }]
 *  2. Neues Format: { systems?: [...], peoples: [...] }
 *
 * @param {any} data
 * @returns {{systems: Array, peoples: Array, legacy: boolean}|null} null = keine Völker-Metadaten
 */
export function normalizeImportPayload(data) {
	if (Array.isArray(data)) {
		if (data.length === 0) return null;
		const first = data[0];
		if (!(first && typeof first === 'object' && typeof first.id === 'string' && typeof first.label === 'string')) {
			return null;
		}
		return {systems: [], peoples: data, legacy: data.some((p) => p?.system === undefined)};
	}
	if (data && typeof data === 'object' && Array.isArray(data.peoples)) {
		return {
			systems: Array.isArray(data.systems) ? data.systems : [],
			peoples: data.peoples,
			legacy: data.peoples.some((p) => p?.system === undefined),
		};
	}
	return null;
}

/**
 * Sammelt alle im Katalog referenzierten Dateipfade (Vor-/Nachname, Compound).
 * @param {object} catalog
 * @param {object[]} [peoples] - optional nur diese Völker
 * @returns {string[]}
 */
export function collectDataPaths(catalog, peoples = catalog.peoples) {
	const paths = new Set();
	const addFiles = (files) => {
		if (!files) return;
		for (const part of ['firstName', 'lastName']) {
			for (const p of _lingPaths(files[part])) paths.add(p);
			const comp = files.compound?.[part];
			if (typeof comp === 'string') paths.add(comp);
		}
	};
	for (const p of peoples) {
		addFiles(p.files);
		for (const s of p.subgroups) addFiles(s.files);
	}
	return [...paths];
}

// ═══════════════════════════════════════════════════
// VERFÜGBARKEIT
// ═══════════════════════════════════════════════════

/**
 * Welche Datenteile benötigt eine Namensart?
 * Sondergeneratoren erzeugen einen vollständigen Namen aus den
 * Vornamen-Daten (siehe generateNames in generator.js).
 *
 * @param {string} nameType
 * @param {string|null} effectiveSpecialType
 * @returns {string[]}
 */
export function requiredParts(nameType, effectiveSpecialType = null) {
	if (nameType === 'fullName') return effectiveSpecialType ? ['firstName'] : ['firstName', 'lastName'];
	if (nameType === 'lastName') return ['lastName'];
	return ['firstName'];
}

/**
 * Hat ein Eintrag für einen Namensteil verwertbare Daten
 * (linguistische Datei ODER Verbindungsnamen-Datei)?
 */
export function partHasData(files, part, isAvailable) {
	if (!files) return false;
	if (_lingPaths(files[part]).some((p) => isAvailable(p))) return true;
	const comp = files.compound?.[part];
	return typeof comp === 'string' && isAvailable(comp);
}

/**
 * Prüft, ob ein Blatt-Eintrag (Volk ohne Untergruppen oder Untergruppe)
 * für die Namensart verwendbar ist.
 *
 * @param {object} leaf
 * @param {string} nameType
 * @param {SelectionContext} ctx
 * @returns {boolean}
 */
export function leafSupports(leaf, nameType, ctx) {
	const special = effectiveSpecialType(leaf, ctx);
	if (special && ctx.hasBuiltInData?.(special)) return true;
	return requiredParts(nameType, special).every((part) => partHasData(leaf.files, part, ctx.isAvailable));
}

/** Liefert alle Namensarten, für die ein Blatt verwendbar ist. */
export function supportedNameTypes(leaf, ctx) {
	return NAME_TYPES.filter((nt) => leafSupports(leaf, nt, ctx));
}

/**
 * specialType nur dann, wenn tatsächlich ein Generator registriert ist —
 * entspricht dem Verhalten von generateName() in generator.js.
 */
export function effectiveSpecialType(leaf, ctx) {
	const st = leaf?.specialType ?? null;
	if (!st) return null;
	return ctx.hasSpecialGenerator ? (ctx.hasSpecialGenerator(st) ? st : null) : st;
}

/**
 * Ermittelt die Geschlechter, für die ein Blatt bei der gewählten Namensart
 * explizite, erreichbare Daten besitzt.
 *
 *  - Teile mit einem einzigen String-Pfad sind geschlechtsunabhängig.
 *  - Mehrere gegenderte Teile → Schnittmenge (z. B. Vorname + Nachname).
 *  - Leere Schnittmenge → Vereinigungsmenge (dann greift die Fallback-Kette).
 *  - Keine gegenderten Daten → [] (Name ist geschlechtsunabhängig).
 *
 * @returns {string[]}
 */
export function genderOptions(leaf, nameType, ctx) {
	const parts = requiredParts(nameType, effectiveSpecialType(leaf, ctx));
	const sets = [];
	for (const part of parts) {
		const f = leaf.files?.[part];
		if (!f || typeof f !== 'object') continue;
		const s = GENDERS.filter((g) => typeof f[g] === 'string' && ctx.isAvailable(f[g]));
		if (s.length > 0) sets.push(s);
	}
	if (sets.length === 0) return [];
	const inter = GENDERS.filter((g) => sets.every((s) => s.includes(g)));
	if (inter.length > 0) return inter;
	return GENDERS.filter((g) => sets.some((s) => s.includes(g)));
}

/**
 * Löst einen geschlechtsspezifischen Dateipfad auf (bisherige Logik aus app.js,
 * erweitert um die Verfügbarkeitsprüfung).
 *
 * Akzeptiert ein Objekt { male, female, neutral } oder einen String-Pfad.
 * Fallback-Reihenfolge: gewünschtes Geschlecht → neutral → male → female.
 * Nicht erreichbare Dateien werden übersprungen.
 *
 * @param {string|object|undefined|null} filesForType
 * @param {string|null} gender
 * @param {(path: string) => boolean} [isAvailable]
 * @returns {{path: string|null, gender: string|null}} gender = tatsächlich verwendeter Schlüssel
 */
export function resolveGenderedFileDetailed(filesForType, gender, isAvailable = () => true) {
	if (!filesForType) return {path: null, gender: null};
	if (typeof filesForType === 'string') {
		return {path: isAvailable(filesForType) ? filesForType : null, gender: null};
	}
	const order = [gender, 'neutral', 'male', 'female'].filter((g, i, a) => g && a.indexOf(g) === i);
	for (const g of order) {
		const p = filesForType[g];
		if (typeof p === 'string' && isAvailable(p)) return {path: p, gender: g};
	}
	return {path: null, gender: null};
}

/** Kurzform: nur den Pfad zurückgeben. */
export function resolveGenderedFile(filesForType, gender, isAvailable) {
	return resolveGenderedFileDetailed(filesForType, gender, isAvailable).path;
}

// ═══════════════════════════════════════════════════
// AUSWAHL-AUFLÖSUNG
// ═══════════════════════════════════════════════════

/**
 * @typedef {object} SelectionContext
 * @property {(path: string) => boolean} isAvailable
 * @property {(type: string) => boolean} [hasSpecialGenerator]
 * @property {(type: string) => boolean} [hasBuiltInData]
 * @property {(items: any[], level: 'system'|'people'|'subgroup'|'gender') => any} [pick]
 *           Auswahlfunktion pro Ebene. Standard: Gleichverteilung über randomPick()
 *           (zentraler, seedbarer RNG). Gewichtungen lassen sich hier pro Ebene einhängen.
 * @property {(nameType: string) => string} [nameTypeLabel]
 */

/** Alle Völker eines Systems in Katalog-Reihenfolge. */
export function peoplesOfSystem(catalog, systemId) {
	return catalog.peoples.filter((p) => p.systemId === systemId);
}

/**
 * Sucht eine Volks- oder Untergruppen-ID ausschließlich innerhalb eines Systems.
 * @returns {{people: object, leaf: object|null}|null} leaf = null → Untergruppe noch offen
 */
export function findInSystem(catalog, systemId, id) {
	for (const p of peoplesOfSystem(catalog, systemId)) {
		if (p.id === id) return {people: p, leaf: p.hasSubgroups ? null : p};
		const sub = p.subgroups.find((s) => s.id === id);
		if (sub) return {people: p, leaf: sub};
	}
	return null;
}

/**
 * Löst die angeforderte Auswahl in feste Werte auf.
 *
 * Reihenfolge (jeweils nur aus gültigen Optionen, kein Wiederholungsversuch):
 *   1. System       — bei „Zufall“ gleichverteilt über Systeme mit verwendbaren Völkern
 *   2. Volk         — bei „Zufall“ gleichverteilt über verwendbare Völker DIESES Systems
 *   3. Untergruppe  — falls vorhanden, gleichverteilt über verwendbare Untergruppen DIESES Volks
 *   4. Geschlecht   — bei „Zufall“ nur aus Geschlechtern mit vorhandenen Daten
 *
 * Alle Zufallsentscheidungen laufen über ctx.pick (Standard: randomPick → utils.rng),
 * also über denselben seedbaren Zufallsstrom wie die anschließende Namensgenerierung.
 *
 * @param {object} catalog
 * @param {{systemId?: string, peopleId?: string, gender?: string, nameType?: string}} request
 * @param {SelectionContext} ctx
 * @returns {{resolved: object, leaf: object}}
 * @throws {SelectionError}
 */
export function resolveSelection(catalog, request, ctx) {
	const systemId = request.systemId ?? RANDOM;
	const peopleId = request.peopleId ?? RANDOM;
	const gender = request.gender ?? RANDOM;
	const nameType = request.nameType ?? 'firstName';

	const pick = ctx.pick ?? ((items) => randomPick(items));
	const ntLabel = ctx.nameTypeLabel?.(nameType) ?? DEFAULT_NAME_TYPE_LABELS[nameType] ?? nameType;
	const usableLeaves = (people) => people.leaves.filter((l) => leafSupports(l, nameType, ctx));

	// ── 1. System ────────────────────────────────────
	let system;
	if (systemId === RANDOM) {
		const candidates = catalog.systems.filter((s) =>
			peoplesOfSystem(catalog, s.id).some((p) => usableLeaves(p).length > 0),
		);
		if (candidates.length === 0) {
			throw new SelectionError(
				`Für die Namensart „${ntLabel}“ sind in keinem System verwendbare Namensdaten vorhanden.`,
				'NO_USABLE_SYSTEM',
			);
		}
		system = pick(candidates, 'system');
	} else {
		system = catalog.systems.find((s) => s.id === systemId);
		if (!system) {
			throw new SelectionError(`Das System „${systemId}“ ist unbekannt.`, 'UNKNOWN_SYSTEM');
		}
		const systemPeoples = peoplesOfSystem(catalog, system.id);
		if (systemPeoples.length === 0) {
			throw new SelectionError(
				`Für „${system.label}“ sind noch keine Namensdaten hinterlegt — das System ist nur vorbereitet.`,
				'SYSTEM_PLACEHOLDER',
			);
		}
		if (!systemPeoples.some((p) => usableLeaves(p).length > 0)) {
			throw new SelectionError(
				`„${system.label}“ enthält keine verwendbaren Namensdaten für „${ntLabel}“.`,
				'SYSTEM_NO_DATA',
			);
		}
	}

	// ── 2. Volk ──────────────────────────────────────
	let people;
	let leaf = null;
	if (peopleId === RANDOM) {
		const candidates = peoplesOfSystem(catalog, system.id).filter((p) => usableLeaves(p).length > 0);
		people = pick(candidates, 'people');
	} else {
		const hit = findInSystem(catalog, system.id, peopleId);
		if (!hit) {
			const elsewhere = catalog.peoples.find(
				(p) => p.systemId !== system.id && (p.id === peopleId || p.subgroups.some((s) => s.id === peopleId)),
			);
			const otherSystem = elsewhere && catalog.systems.find((s) => s.id === elsewhere.systemId);
			throw new SelectionError(
				otherSystem
					? `Die Auswahl „${peopleId}“ gehört zum System „${otherSystem.label}“, nicht zu „${system.label}“.`
					: `Das Volk „${peopleId}“ ist im System „${system.label}“ nicht vorhanden.`,
				'PEOPLE_NOT_IN_SYSTEM',
			);
		}
		people = hit.people;
		leaf = hit.leaf;
	}

	// ── 3. Untergruppe ───────────────────────────────
	const randomSubgroup = people.hasSubgroups && leaf === null;
	if (leaf === null) {
		const candidates = usableLeaves(people);
		if (candidates.length === 0) {
			throw new SelectionError(
				`Für „${people.label}“ (${system.label}) sind keine Namensdaten für „${ntLabel}“ vorhanden.`,
				'PEOPLE_NO_DATA',
			);
		}
		leaf = people.hasSubgroups ? pick(candidates, 'subgroup') : candidates[0];
	} else if (!leafSupports(leaf, nameType, ctx)) {
		throw new SelectionError(
			`Für „${leaf.label}“ (${system.label}) sind keine Namensdaten für „${ntLabel}“ vorhanden.`,
			'PEOPLE_NO_DATA',
		);
	}

	// ── 4. Geschlecht ────────────────────────────────
	let resolvedGender;
	if (gender === RANDOM) {
		const options = genderOptions(leaf, nameType, ctx);
		resolvedGender = options.length > 0 ? pick(options, 'gender') : null;
	} else {
		resolvedGender = gender;
	}

	const isSub = people.hasSubgroups;
	return {
		leaf,
		resolved: {
			systemId: system.id,
			systemLabel: system.label,
			systemShortLabel: system.shortLabel ?? null,
			peopleId: people.id,
			peopleLabel: people.label,
			subgroupId: isSub ? leaf.id : null,
			subgroupLabel: isSub ? leaf.label : null,
			/** ID des tatsächlich verwendeten Datensatzes (entspricht der bisherigen peopleId-Semantik) */
			leafId: leaf.id,
			leafLabel: leaf.label,
			gender: resolvedGender,
			nameType,
			specialType: effectiveSpecialType(leaf, ctx),
			randomized: {
				system: systemId === RANDOM,
				people: peopleId === RANDOM,
				subgroup: randomSubgroup,
				gender: gender === RANDOM,
			},
		},
	};
}

// ═══════════════════════════════════════════════════
// VIEW-MODELLE FÜR DIE DROPDOWNS
// ═══════════════════════════════════════════════════

/**
 * Optionen für das System-Dropdown (ohne „Zufall“).
 * @returns {{id: string, label: string, disabled: boolean, title: string}[]}
 */
export function buildSystemOptions(catalog, nameType, ctx) {
	const ntLabel = ctx.nameTypeLabel?.(nameType) ?? DEFAULT_NAME_TYPE_LABELS[nameType] ?? nameType;
	return catalog.systems.map((s) => {
		const ps = peoplesOfSystem(catalog, s.id);
		if (ps.length === 0) {
			return {id: s.id, label: `${s.label} (in Vorbereitung)`, disabled: true,
				title: 'Für dieses System sind noch keine Namensdaten hinterlegt.'};
		}
		const anyData = ps.some((p) => p.leaves.some((l) => supportedNameTypes(l, ctx).length > 0));
		if (!anyData) {
			return {id: s.id, label: `${s.label} (keine Daten verfügbar)`, disabled: true,
				title: 'Die referenzierten Namensdaten dieses Systems sind nicht erreichbar.'};
		}
		const forType = ps.some((p) => p.leaves.some((l) => leafSupports(l, nameType, ctx)));
		return forType
			? {id: s.id, label: s.label, disabled: false, title: ''}
			: {id: s.id, label: `${s.label} (keine Daten für ${ntLabel})`, disabled: false,
				title: `Für „${ntLabel}“ sind in diesem System keine Namensdaten vorhanden.`};
	});
}

/**
 * Optionen für das Volk-Dropdown eines Systems (ohne „Zufall“).
 * Völker mit Untergruppen werden als Gruppe geliefert — mit einer ersten
 * Option „zufällige Untergruppe“ (value = Volks-ID).
 *
 * @returns {Array<{type: 'option', value, label, disabled, title}|{type: 'group', label, options: Array}>}
 */
export function buildPeopleOptions(catalog, systemId, ctx) {
	const items = [];
	for (const p of peoplesOfSystem(catalog, systemId)) {
		if (p.hasSubgroups) {
			const subOptions = p.subgroups.map((s) => _leafOption(s.id, s.label, supportedNameTypes(s, ctx), ctx));
			const union = NAME_TYPES.filter((nt) => p.subgroups.some((s) => leafSupports(s, nt, ctx)));
			items.push({
				type: 'group',
				label: p.label,
				options: [_leafOption(p.id, `${p.label} — Zufällige Untergruppe`, union, ctx), ...subOptions],
			});
		} else {
			items.push(_leafOption(p.id, p.label, supportedNameTypes(p, ctx), ctx));
		}
	}
	return items;
}

function _leafOption(value, label, supported, ctx) {
	const lbl = (nt) => ctx.nameTypeLabel?.(nt) ?? DEFAULT_NAME_TYPE_LABELS[nt] ?? nt;
	if (supported.length === 0) {
		return {type: 'option', value, label: `${label} (keine Daten)`, disabled: true,
			title: 'Die referenzierten Namensdaten sind nicht erreichbar.'};
	}
	if (supported.length < NAME_TYPES.length) {
		return {type: 'option', value, label: `${label} (nur ${supported.map(lbl).join(', ')})`, disabled: false,
			title: `Namensdaten nur für: ${supported.map(lbl).join(', ')}`};
	}
	return {type: 'option', value, label, disabled: false, title: ''};
}

// ═══════════════════════════════════════════════════
// INTERNE HELFER
// ═══════════════════════════════════════════════════

function _isValidId(id) {
	return typeof id === 'string' && id.trim() !== '' && id !== RANDOM;
}

function _lingPaths(f) {
	if (!f) return [];
	if (typeof f === 'string') return [f];
	if (typeof f !== 'object') return [];
	return GENDERS.map((g) => f[g]).filter((p) => typeof p === 'string' && p !== '');
}

/**
 * Prüft die Struktur eines files-Objekts. Ungültige Werte (keine Strings)
 * werden entfernt und gemeldet; gültige Pfade bleiben unverändert.
 */
function _sanitizeFiles(files, where, issues) {
	if (files === undefined || files === null) return null;
	if (typeof files !== 'object') {
		issues.push(`${where}: „files“ muss ein Objekt sein.`);
		return null;
	}
	const checkPath = (v, label) => {
		if (v === null || v === undefined) return null;
		if (typeof v === 'string' && v.trim() !== '') return v;
		issues.push(`${where}: ungültiger Dateipfad bei ${label}.`);
		return null;
	};
	const out = {};
	for (const part of ['firstName', 'lastName']) {
		const v = files[part];
		if (v && typeof v === 'object') {
			out[part] = {};
			for (const g of GENDERS) out[part][g] = checkPath(v[g], `${part}.${g}`);
		} else {
			out[part] = checkPath(v, part);
		}
	}
	out.compound = {
		firstName: checkPath(files.compound?.firstName, 'compound.firstName'),
		lastName: checkPath(files.compound?.lastName, 'compound.lastName'),
	};
	return out;
}
