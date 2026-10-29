/**
 * app.js — Haupt-Einstiegspunkt des Namensgenerators
 *
 * Verantwortlich für:
 *  - Initialisierung aller Module beim DOM-Ready
 *  - Event-Wiring (Generate, Copy, Export, Theme, Import)
 *  - Orchestrierung des Datenflusses:
 *      Config lesen → Auswahl auflösen (System → Volk → Untergruppe → Geschlecht)
 *      → Daten laden → Namen generieren → Anzeigen
 *  - RNG-Verwaltung (Seed / Math.random)
 *  - JSON-Import benutzereigener Datensätze
 *  - Theme-Toggle (Dark/Light)
 *  - Namenslängen-UI (Segmented Control ↔ Sub-Inputs)
 *
 * Abhängigkeiten:
 *  - js/dataLoader.js
 *  - js/selection.js
 *  - js/generator.js
 *  - js/uiController.js
 *  - js/utils.js
 */

import {
	loadPeoples,
	loadSystems,
	loadLinguisticData,
	loadCompoundData,
	loadUserFile,
	registerUserData,
	probeFiles,
} from './dataLoader.js';

import {generateNames, generateSyllableName} from './generator.js';
import {
	initSpecialGenerators,
	specialGenerators,
	specialTypesWithBuiltInData,
} from './specialGenerators.js';

import {
	RANDOM,
	CUSTOM_SYSTEM,
	SelectionError,
	CatalogValidationError,
	createEmptyCatalog,
	buildCatalog,
	mergeIntoCatalog,
	normalizeImportPayload,
	collectDataPaths,
	resolveSelection,
	requiredParts,
	resolveGenderedFileDetailed,
	buildSystemOptions,
	buildPeopleOptions,
} from './selection.js';

import {createSeededRNG, setRNG, resetRNG, formatNumber} from './utils.js';

import {
	initLetterPicker,
	updateLetterPicker,
	initTabs,
	populateSystems,
	populatePeoples,
	getFormConfig,
	getNameTypeLabel,
	showLoading,
	showEmpty,
	showError,
	displayResults,
	initResultsForChunkedMode,
	appendSingleName,
	appendNameBatch,
	addToHistory,
	copyToClipboard,
	exportAsTxt,
	exportPerLetter,
	getFavorites,
	clearFavorites,
	showToast,
	switchTab,
} from './uiController.js';

// ═══════════════════════════════════════════════════
// MODUL-STATE
// ═══════════════════════════════════════════════════

/**
 * Katalog aus Systemen + systemgebundenen Völkern (systems.json + peoples.json
 * + Importe). Aufbau & Validierung: selection.js → buildCatalog().
 */
let _catalog = createEmptyCatalog();

/** Ergebnis der Dateiprüfung: Pfad → 'ok' | 'missing' | 'unknown' */
const _availability = new Map();

/** Promise der laufenden Dateiprüfung — handleGenerate() wartet darauf. */
let _availabilityReady = Promise.resolve();

/**
 * Angeforderte + tatsächlich aufgelöste Konfiguration der Generierung,
 * aus der _lastNames stammen (für Export-Dateinamen).
 * @type {{requestedConfig: object, resolvedConfig: object}|null}
 */
let _lastGeneration = null;

/** Anzahl der seit dem Seeden gezogenen Zufallszahlen (für den Worker). */
let _rngDraws = 0;

/** Zuletzt generierte Namen — für Export/Copy */
let _lastNames = [];

/** Aktiver Web Worker (für laufende Generierung, null wenn idle) */
let _activeWorker = null;

// ═══════════════════════════════════════════════════
// INITIALISIERUNG
// ═══════════════════════════════════════════════════

/**
 * Startet die gesamte Applikation.
 * Wird beim DOMContentLoaded aufgerufen.
 */
async function init() {
	// ── Sonderfälle initialisieren (Autognome braucht Silbengenerator) ──
	initSpecialGenerators({generateSyllableName});

	// ── UI-Komponenten aufbauen ─────────────────────
	initLetterPicker();
	initTabs();
	initThemeToggle();
	initLengthModeUI();

	// ── Systeme + Völker laden & Dropdowns befüllen ─
	const [systemsRes, peoplesRes] = await Promise.allSettled([loadSystems(), loadPeoples()]);

	if (peoplesRes.status === 'rejected') {
		// Kein Absturz — ohne peoples.json gibt es aber keine Namensdaten.
		console.warn('[app] peoples.json konnte nicht geladen werden:', peoplesRes.reason?.message);
		showToast('⚠ Völkerdaten (peoples.json) konnten nicht geladen werden.', 5000);
	}
	if (systemsRes.status === 'rejected') {
		console.warn('[app] systems.json konnte nicht geladen werden:', systemsRes.reason?.message);
		showToast('⚠ Systemverzeichnis konnte nicht geladen werden — Systeme ohne Anzeigenamen.', 5000);
	}

	const {catalog, issues} = buildCatalog(
		systemsRes.status === 'fulfilled' ? systemsRes.value : null,
		peoplesRes.status === 'fulfilled' ? peoplesRes.value : null,
	);
	_catalog = catalog;
	issues.forEach((msg) => console.warn('[app] Metadaten:', msg));

	_refreshSelectionUI();

	// Dateiprüfung im Hintergrund — Dropdowns werden danach aktualisiert.
	_availabilityReady = _probeAvailability(collectDataPaths(_catalog));

	// ── Event-Listener verdrahten ───────────────────
	wireEvents();

	// ── initiales Empty State zeigen ───────────────
	showEmpty();
}

// ═══════════════════════════════════════════════════
// EVENT-WIRING
// ═══════════════════════════════════════════════════

function wireEvents() {
	// Haupt-Generierung
	document.getElementById('generateBtn')?.addEventListener('click', handleGenerate);

	// Stop-Button: bricht laufenden Worker ab
	document.getElementById('stopBtn')?.addEventListener('click', () => {
		if (_activeWorker) {
			if (typeof _activeWorker.postMessage === 'function') {
				_activeWorker.postMessage({ type: 'abort' });
				_activeWorker.terminate();
			} else {
				// Fallback-Sentinel
				_activeWorker._aborted = true;
			}
			_activeWorker = null;
		}
		_setGeneratingState(false);
		showToast('Generierung abgebrochen');
	});

	// "Erneut versuchen" im Fehler-State
	document.getElementById('retryBtn')?.addEventListener('click', handleGenerate);

	// ── Ergebnis-Aktionen ───────────────────────────
	document.getElementById('copyBtn')?.addEventListener('click', () => {
		if (_lastNames.length > 0) {
			copyToClipboard(_lastNames);
		}
	});

	document.getElementById('exportBtn')?.addEventListener('click', () => {
		if (_lastNames.length > 0) {
			exportAsTxt(_lastNames, _buildExportFilename());
		}
	});

	document.getElementById('exportPerLetterBtn')?.addEventListener('click', () => {
		if (_lastNames.length > 0) {
			// Buchstabe wird als Präfix vor den Standard-Dateinamen gesetzt:
			// Ergebnis: A_reality_human_german_male_firstname_syllable_weighted_probbylength_kein-seed_TIMESTAMP.txt
			exportPerLetter(_lastNames, (letter) => `${letter}_${_buildExportFilename()}`);
		}
	});

	// Favoriten leeren
	document.getElementById('clearFavBtn')?.addEventListener('click', () => {
		clearFavorites();
	});

	// ── JSON-Import ─────────────────────────────────
	document.getElementById('importFile')?.addEventListener('change', handleImport);

	// ── System-/Namensart-Wechsel → Volksauswahl aktualisieren ──
	document.getElementById('selectSystem')?.addEventListener('change', () => _refreshSelectionUI(true));
	document.getElementById('selectNameType')?.addEventListener('change', () => _refreshSelectionUI());

	// ── "Alle Kombinationen"-Checkbox ───────────────
	document.getElementById('generateAll')?.addEventListener('change', (e) => {
		const countInput = document.getElementById('nameCount');
		if (countInput) {
			countInput.disabled = e.target.checked;
			countInput.style.opacity = e.target.checked ? '0.4' : '';
		}
	});

	// ── Seed: Validierung (nur positive Ganzzahl ≤ 2147483647) ──────────────
	const SEED_MAX = 2_147_483_647;
	document.getElementById('seedInput')?.addEventListener('input', (e) => {
		// Nicht-Ziffern entfernen
		e.target.value = e.target.value.replace(/[^0-9]/g, '');
		const v = parseInt(e.target.value, 10);
		if (!isNaN(v) && v > SEED_MAX) e.target.value = String(SEED_MAX);
	});

	// ── Seed: Zufallswert generieren ─────────────────────────────────────────
	document.getElementById('randomSeedBtn')?.addEventListener('click', () => {
		const seed = Math.floor(Math.random() * (SEED_MAX + 1));
		const input = document.getElementById('seedInput');
		if (input) {
			input.value = seed;
			// Kurzes visuelles Feedback
			input.classList.add('seed-flash');
			setTimeout(() => input.classList.remove('seed-flash'), 400);
		}
	});
}

// ═══════════════════════════════════════════════════
// GENERIERUNGS-FLOW
// ═══════════════════════════════════════════════════

/**
 * Haupt-Handler für den "Namen generieren"-Button.
 *
 * Ablauf:
 * 1. Config aus dem Formular lesen
 * 2. RNG konfigurieren (Seed oder Math.random)
 * 3. Loading-State zeigen
 * 4. Passende JSON-Dateien laden
 * 5. Namen generieren
 * 6. Ergebnis anzeigen + History-Eintrag
 */
async function handleGenerate() {
	const config = getFormConfig();

	// ── RNG Setup ─────────────────────────────────────────────────────────
	// Die Auflösung von System/Volk/Untergruppe/Geschlecht und die
	// anschließende Namensgenerierung nutzen denselben Zufallsstrom.
	if (config.seed !== null && config.seed !== '') {
		const numSeed = parseInt(config.seed, 10);
		const seeded = createSeededRNG(isNaN(numSeed) ? config.seed : numSeed);
		_rngDraws = 0;
		setRNG(() => {
			_rngDraws++;
			return seeded();
		});
	} else {
		_rngDraws = 0;
		resetRNG();
	}

	_setGeneratingState(true);
	showLoading();

	// Kurze Verzögerung: Browser-Paint-Tick abwarten
	await _tick(50);

	try {
		// Dateiprüfung muss abgeschlossen sein, bevor ausgewählt wird
		await _availabilityReady;

		// ── Auswahl auflösen & Daten laden ──────────────
		const {linguisticData, compoundData, specialType, resolvedConfig} =
			await _loadDataForConfig(config);

		// ── Letter-Picker dynamisch aktualisieren ───────────────────────────
		const primaryData = linguisticData?.firstName ?? linguisticData;
		updateLetterPicker(primaryData);

		// ── Namen generieren (specialType in config einmergen) ──────────────
		const genConfig = specialType ? {...config, specialType} : config;

		if (genConfig.generateAll) {
			await _generateAllChunked(linguisticData, compoundData, genConfig);
		} else {
			const names = generateNames(linguisticData, compoundData, genConfig);
			_lastNames = names;
			displayResults(names, genConfig.favoritesEnabled);
		}

		_lastGeneration = {requestedConfig: config, resolvedConfig};
		addToHistory(_lastNames, config, resolvedConfig);
	} catch (err) {
		// Ungültige/nicht bedienbare Auswahl ist ein erwarteter Fall → warn
		if (err instanceof SelectionError) console.warn('[app] Auswahl nicht möglich:', err.code, err.message);
		else console.error('[app] Generierungsfehler:', err);
		const isNoMethodError = err.message?.includes('Keine geeignete Generierungsart');
		const displayMessage = isNoMethodError
			? 'Keine geeignete Generierungsart für die gewählten Einstellungen vorhanden:' + JSON.stringify(config)
			: (err.message || 'Unbekannter Fehler bei der Generierung.');
		showError(displayMessage);
	} finally {
		_setGeneratingState(false);
	}
}

// ═══════════════════════════════════════════════════
// DATENLADEN — passend zur Config
// ═══════════════════════════════════════════════════

/**
 * Löst die Auswahl auf und lädt die benötigten JSON-Dateien.
 *
 * Gibt ein Objekt zurück:
 * {
 *   linguisticData: object|null   — Silben/Cluster-Daten
 *   compoundData:   object|null   — Verbindungsnamen-Daten
 *   specialType:    string|null   — Sonderfall-Generator
 *   resolvedConfig: object        — tatsächlich verwendete Werte
 *                                   (System, Volk, Untergruppe, Geschlecht …)
 * }
 *
 * Für nameType === 'fullName' wird je ein firstName/lastName-Sub-Objekt
 * übergeben, damit generateNames() korrekt aufteilen kann.
 *
 * Die Auswahl wird genau EINMAL aufgelöst (resolveSelection) — dieselben
 * Werte steuern das Laden, die Generierung und den Verlaufseintrag.
 *
 * @param {object} config - aus getFormConfig()
 * @returns {Promise<{linguisticData, compoundData, specialType, resolvedConfig}>}
 * @throws {SelectionError} bei ungültiger oder nicht bedienbarer Auswahl
 */
async function _loadDataForConfig(config) {
	const {nameType} = config;

	if (!['firstName', 'lastName', 'fullName'].includes(nameType)) {
		throw new SelectionError(`Unbekannte Namensart „${nameType}“.`, 'UNKNOWN_NAME_TYPE');
	}

	const ctx = _selectionContext();

	// ── System → Volk → Untergruppe → Geschlecht (zentraler RNG) ──
	const {resolved, leaf} = resolveSelection(
		_catalog,
		{
			systemId: config.systemId ?? RANDOM,
			peopleId: config.peopleId ?? RANDOM,
			gender: config.gender ?? RANDOM,
			nameType,
		},
		ctx,
	);

	const specialType = resolved.specialType;
	const files = leaf.files ?? {};
	const gender = resolved.gender;

	// ── Dateipfade ermitteln & laden ────────────────
	let loaded;
	if (nameType === 'fullName') {
		loaded = await _loadFullNameData(files, gender, ctx.isAvailable);
	} else {
		loaded = await _loadSingleTypeData(files[nameType], files.compound?.[nameType], gender, ctx.isAvailable);
		loaded = {
			...loaded,
			usedFiles: {[nameType]: loaded.usedFile},
			dataGender: loaded.dataGender,
		};
	}

	// ── Sicherheitsnetz: Daten tatsächlich geladen? ─
	// (Die Dateiprüfung kann z. B. bei Servern ohne HEAD-Unterstützung
	// nichts aussagen.) Keine stille Ersatzquelle — klarer Fehler.
	if (!(specialType && specialTypesWithBuiltInData.has(specialType))) {
		const parts = requiredParts(nameType, specialType);
		const missing = parts.filter((part) => {
			const ling = nameType === 'fullName' ? loaded.linguisticData?.[part] : loaded.linguisticData;
			const comp = nameType === 'fullName' ? loaded.compoundData?.[part] : loaded.compoundData;
			return !ling && !comp;
		});
		if (missing.length > 0) {
			for (const p of loaded.failedPaths) _availability.set(p, 'missing');
			_refreshSelectionUI();
			throw new SelectionError(
				`Die Namensdaten für „${resolved.leafLabel}“ (${resolved.systemLabel}) konnten nicht geladen werden` +
					(loaded.failedPaths.length ? `: ${loaded.failedPaths.join(', ')}` : '.'),
				'LOAD_FAILED',
			);
		}
	}

	const resolvedConfig = {
		...resolved,
		/** Geschlechts-Schlüssel der tatsächlich geladenen Datei (Fallback-Kette) */
		dataGender: loaded.dataGender ?? null,
		files: loaded.usedFiles,
	};

	return {
		linguisticData: loaded.linguisticData,
		compoundData: loaded.compoundData,
		specialType,
		resolvedConfig,
	};
}

/**
 * Lädt Daten für Vor- UND Nachname (nameType === 'fullName').
 * Gibt verschachtelte Objekte zurück, die generateNames() erwartet.
 */
async function _loadFullNameData(files, gender, isAvailable) {
	const first = resolveGenderedFileDetailed(files.firstName, gender, isAvailable);
	const last = resolveGenderedFileDetailed(files.lastName, gender, isAvailable);
	const failedPaths = [];

	// Verbindungsnamen werden immer geladen — der Generator entscheidet
	// zur Laufzeit, ob und wie er sie einsetzt (Auto-Mix in generator.js).
	const [firstNameLing, firstNameComp, lastNameLing, lastNameComp] = await Promise.all([
		_loadLingSafe(first.path, failedPaths),
		_loadCompSafe(_availableOrNull(files.compound?.firstName, isAvailable), failedPaths),
		_loadLingSafe(last.path, failedPaths),
		_loadCompSafe(_availableOrNull(files.compound?.lastName, isAvailable), failedPaths),
	]);

	return {
		linguisticData: {firstName: firstNameLing, lastName: lastNameLing},
		compoundData: {firstName: firstNameComp, lastName: lastNameComp},
		usedFiles: {firstName: first.path, lastName: last.path},
		dataGender: first.gender ?? last.gender,
		failedPaths,
	};
}

/**
 * Lädt Daten für einen einzelnen Namentyp (firstName oder lastName).
 */
async function _loadSingleTypeData(filesForType, compoundFilePath, gender, isAvailable) {
	// Verbindungsnamen werden immer mitgeladen, wenn ein Pfad angegeben ist.
	const ling = resolveGenderedFileDetailed(filesForType, gender, isAvailable);
	const failedPaths = [];

	const [lingData, compData] = await Promise.all([
		_loadLingSafe(ling.path, failedPaths),
		_loadCompSafe(_availableOrNull(compoundFilePath, isAvailable), failedPaths), // Auto-Mix im Generator
	]);

	return {
		linguisticData: lingData,
		compoundData: compData,
		usedFile: ling.path,
		dataGender: ling.gender,
		failedPaths,
	};
}

// ═══════════════════════════════════════════════════
// INTERNE HILFSFUNKTIONEN
// ═══════════════════════════════════════════════════

/**
 * Kontext für selection.js: Verfügbarkeit + Sondergenerator-Registry.
 * Zufallsentscheidungen laufen über den Standard (randomPick → utils.rng).
 */
function _selectionContext() {
	return {
		isAvailable: (path) => _availability.get(path) !== 'missing',
		hasSpecialGenerator: (type) => typeof specialGenerators[type] === 'function',
		hasBuiltInData: (type) => specialTypesWithBuiltInData.has(type),
		nameTypeLabel: getNameTypeLabel,
	};
}

/** Pfad nur zurückgeben, wenn er nicht als fehlend bekannt ist. */
function _availableOrNull(path, isAvailable) {
	return typeof path === 'string' && isAvailable(path) ? path : null;
}

/**
 * Prüft die Erreichbarkeit der übergebenen Dateien und aktualisiert danach
 * System- und Volksauswahl (nicht erreichbare Einträge werden deaktiviert).
 *
 * @param {string[]} paths
 * @returns {Promise<void>}
 */
async function _probeAvailability(paths) {
	if (paths.length === 0) return;
	const result = await probeFiles(paths);
	const missing = [];
	for (const [path, status] of result) {
		_availability.set(path, status);
		if (status === 'missing') missing.push(path);
	}
	if (missing.length > 0) {
		console.warn(`[app] ${missing.length} referenzierte Datendatei(en) nicht erreichbar:`, missing);
	}
	_refreshSelectionUI();
}

/**
 * Baut System- und Volk-Dropdown aus dem Katalog neu auf.
 * Gültige Auswahlen bleiben erhalten; ungültige werden auf „Zufall“ korrigiert.
 *
 * @param {boolean} [notifyCorrection=false] - Toast bei automatischer Korrektur
 */
function _refreshSelectionUI(notifyCorrection = false) {
	const ctx = _selectionContext();
	const nameType = document.getElementById('selectNameType')?.value ?? 'firstName';

	const systemId = populateSystems(buildSystemOptions(_catalog, nameType, ctx));
	const systemLabel = _catalog.systems.find((s) => s.id === systemId)?.label ?? '';
	const {corrected, previousLabel} = populatePeoples(
		systemId === RANDOM ? null : buildPeopleOptions(_catalog, systemId, ctx),
		{systemLabel},
	);

	if (notifyCorrection && corrected) {
		showToast(`„${previousLabel}“ gibt es in „${systemLabel}“ nicht — Volk auf Zufall gesetzt`, 3500);
	}
}

/**
 * Lädt linguistische Daten; gibt bei Fehler null zurück (kein throw).
 * @param {string|null} filePath
 * @param {string[]} [failed] - sammelt fehlgeschlagene Pfade
 */
async function _loadLingSafe(filePath, failed = []) {
	if (!filePath) return null;
	try {
		return await loadLinguisticData(filePath);
	} catch (err) {
		console.warn(`[app] Datei konnte nicht geladen werden: ${filePath}`, err.message);
		failed.push(filePath);
		return null;
	}
}

/** Lädt Verbindungsnamen-Daten; gibt bei Fehler null zurück. */
async function _loadCompSafe(filePath, failed = []) {
	if (!filePath) return null;
	try {
		return await loadCompoundData(filePath);
	} catch (err) {
		console.warn(`[app] Compound-Datei konnte nicht geladen werden: ${filePath}`, err.message);
		failed.push(filePath);
		return null;
	}
}

/**
 * Generiert alle möglichen Namen buchstabenweise (A→Z) und
 * aktualisiert die UI nach jedem Buchstaben progressiv.
 *
 * Vorteile:
 *  - Kein UI-Freeze (Browser-Tick nach jedem Chunk)
 *  - Fortschritt sichtbar während der Generierung
 *  - Kein festes Mengenlimit — Konvergenz beendet jeden Chunk
 *
 * @param {object|null} linguisticData
 * @param {object|null} compoundData
 * @param {object}      config
 * @returns {Promise<string[]>}
 */
/**
 * Maximale Anzahl Namen pro Anfangsbuchstabe bei „Alle möglichen Namen".
 * Begrenzt CPU-Last und verhindert UI-Freezes bei großen Datensätzen.
 * Kann bei Bedarf erhöht werden (Richtwert: 500–2000).
 */
const MAX_NAMES_PER_LETTER = 1_000;

/**
 * Gibt eine Pause mit requestIdleCallback oder setTimeout(0).
 */
function _yieldToUI() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(resolve, { timeout: 50 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Schaltet zwischen Generierungs- und Idle-Zustand um.
 * Zeigt/versteckt Generate-Button, Stop-Button und Progress-Bar.
 * @param {boolean} generating
 */
function _setGeneratingState(generating) {
  const genBtn      = document.getElementById('generateBtn');
  const stopBtn     = document.getElementById('stopBtn');
  const progressEl  = document.getElementById('genProgress');
  const progressBar = document.getElementById('genProgressBar');
  const progressLbl = document.getElementById('genProgressLabel');

  if (genBtn)  genBtn.style.display  = generating ? 'none' : '';
  if (stopBtn) stopBtn.style.display = generating ? ''     : 'none';

  if (progressEl) {
    progressEl.style.display = generating ? '' : 'none';
    if (!generating && progressBar) progressBar.style.width = '0%';
    if (!generating && progressLbl) progressLbl.textContent = '';
  }
}

/**
 * Aktualisiert Progress-Bar und Zähler-Label.
 * @param {number} current   — aktueller Buchstaben-Index (abgeschlossen)
 * @param {number} total     — Gesamtanzahl Buchstaben
 * @param {number} generated — bisher generierte Namen
 */
function _updateProgress(current, total, generated) {
  const bar = document.getElementById('genProgressBar');
  const lbl = document.getElementById('genProgressLabel');
  if (bar) bar.style.width = `${total > 0 ? Math.round((current / total) * 100) : 0}%`;
  if (lbl) lbl.textContent = `${formatNumber(generated)} Namen generiert`;
}

/**
 * Koordiniert die Generierung aller Kombinationen.
 * Bevorzugt Worker (UI-Thread frei), fällt auf Haupt-Thread zurück.
 */
async function _generateAllChunked(linguisticData, compoundData, config) {
  const dataLetters = _extractDataLetters(linguisticData);
  const filtered    = config.startingLetters
    ? dataLetters.filter(l => config.startingLetters.has(l))
    : dataLetters;
  const letters = filtered.sort((a, b) => a.localeCompare(b, 'de'));

  initResultsForChunkedMode();
  _updateProgress(0, letters.length, 0);

  if (typeof Worker !== 'undefined') {
    await _generateWithWorker(linguisticData, compoundData, config, letters);
  } else {
    // Fallback: Sentinel-Objekt mit abort-Signal
    _activeWorker = { _aborted: false };
    await _generateFallback(linguisticData, compoundData, config, letters);
    _activeWorker = null;
  }

  return _lastNames;
}

/**
 * Worker-basierte Generierung — UI-Thread bleibt vollständig frei.
 * Empfängt Batches per postMessage, übergibt sie an appendNameBatch().
 */
async function _generateWithWorker(linguisticData, compoundData, config, letters) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(
        new URL('./namegenWorker.js', import.meta.url),
        { type: 'module' }
      );
    } catch {
      // Worker-Erstellung fehlgeschlagen (file://, CSP, o. ä.)
      _generateFallback(linguisticData, compoundData, config, letters)
        .then(resolve).catch(reject);
      return;
    }

    _activeWorker = worker;
    const allNames = new Set();

    worker.onmessage = ({ data }) => {
      switch (data.type) {

        case 'batch': {
          const unique = data.names.filter(n => !allNames.has(n));
          unique.forEach(n => allNames.add(n));
          _lastNames = [...allNames];
          if (unique.length > 0) {
            appendNameBatch(data.letter, unique, config.favoritesEnabled);
          }
          _updateProgress(data.letterIndex + 1, data.totalLetters, allNames.size);
          const loadingText = document.getElementById('loadingText');
          if (loadingText) {
            loadingText.textContent =
              `Generiere ${data.letter}\u2026 (${data.letterIndex + 1} / ${data.totalLetters})`;
          }
          break;
        }

        case 'done':
          worker.terminate();
          _activeWorker = null;
          _updateProgress(letters.length, letters.length, allNames.size);
          resolve();
          break;

        case 'error':
          worker.terminate();
          _activeWorker = null;
          reject(new Error(data.message));
          break;
      }
    };

    worker.onerror = (e) => {
      worker.terminate();
      _activeWorker = null;
      console.warn('[app] Worker-Fehler, Fallback auf Haupt-Thread:', e.message);
      _generateFallback(linguisticData, compoundData, config, letters)
        .then(resolve).catch(reject);
    };

    // rngSkip: Der Worker seedet neu und überspringt die bereits für die
    // Auswahlauflösung gezogenen Zufallszahlen → derselbe Zufallsstrom.
    const workerConfig = { ...config, rngSkip: config.seed ? _rngDraws : 0 };
    worker.postMessage({ type: 'generate', linguisticData, compoundData, config: workerConfig, letters });
  });
}

/**
 * Fallback-Generierung im Haupt-Thread mit requestIdleCallback-Pausen.
 * Identisch mit der ursprünglichen Logik, jetzt mit appendNameBatch
 * statt appendSingleName × n (deutlich weniger DOM-Operationen).
 */
async function _generateFallback(linguisticData, compoundData, config, letters) {
  const allNames    = new Set();
  const loadingText = document.getElementById('loadingText');

  for (let i = 0; i < letters.length; i++) {
    // Abbruch: Stop-Button terminiert Worker oder setzt Sentinel._aborted
    if (!_activeWorker || _activeWorker._aborted) break;

    const letter = letters[i];
    if (loadingText) {
      loadingText.textContent = `Generiere ${letter}… (${i + 1} / ${letters.length})`;
    }

    const chunkConfig = {
      ...config,
      generateAll:     false,
      count:           MAX_NAMES_PER_LETTER,
      startingLetters: new Set([letter]),
    };

    const chunk  = generateNames(linguisticData, compoundData, chunkConfig);
    const unique = chunk.filter(n => !allNames.has(n));
    unique.forEach(n => allNames.add(n));
    _lastNames = [...allNames];

    if (unique.length > 0) {
      appendNameBatch(letter, unique, config.favoritesEnabled);
    }
    _updateProgress(i + 1, letters.length, allNames.size);

    await _yieldToUI();
  }
}

/**
 * Extrahiert alle möglichen Startbuchstaben aus den geladenen Daten.
 * Unterstützt sowohl einfache linguisticData als auch das fullName-Format
 * { firstName: data, lastName: data }.
 *
 * @param {object|null} linguisticData
 * @returns {string[]}
 */
function _extractDataLetters(linguisticData) {
  // fullName-Format: { firstName, lastName }
  const data = linguisticData?.firstName ?? linguisticData;

  // extractPrefixLetters ist in utils.js und wird von uiController importiert.
  // Hier rufen wir die gleiche Logik inline auf (kein Zirkelbezug).
  if (!data) return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  const firstChars = new Set();
  const sources = [
    data?.syllables?.prefix,
    data?.consonantCombinations?.prefix,
    data?.vowelCombinations?.prefix,
  ];
  for (const posMap of sources) {
    if (!posMap) continue;
    for (const entries of Object.values(posMap)) {
      for (const key of Object.keys(entries)) {
        if (key) firstChars.add(key[0].toUpperCase());
      }
    }
  }

  const sorted = [...firstChars].sort((a, b) => a.localeCompare(b, 'de'));
  return sorted.length > 0 ? sorted : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
}

/**
 * Erzeugt einen Dateinamen für den Export.
 *
 * Grundlage ist die Generierung, aus der die exportierten Namen stammen:
 * System, Volk/Untergruppe und Geschlecht werden mit den TATSÄCHLICH
 * verwendeten (aufgelösten) Werten benannt — nicht mit „zufall“ und nicht
 * mit einer inzwischen geänderten Formularauswahl.
 */
function _buildExportFilename() {
	const config = _lastGeneration?.requestedConfig ?? getFormConfig();
	const resolved = _lastGeneration?.resolvedConfig ?? null;

	// ── Hilfsfunktionen ─────────────────────────────────────────────────
	/** ISO-Timestamp ohne Doppelpunkte, geeignet als Dateiname. */
	function _getTimestamp() {
		return new Date().toISOString()
			.replace('T', '-')
			.replace(/:/g, '-')
			.split('.')[0];                 // → YYYY-MM-DD-HH-MM-SS
	}

	/** Normalisiert einen Wert für den Dateinamen (lowercase, keine Leerzeichen). */
	function _slug(value, fallback = 'unbekannt') {
		return (value ?? fallback).toString().toLowerCase().replace(/\s+/g, '-');
	}

	// ── Parameter sammeln ───────────────────────────────────────────────
	const system    = _slug(resolved?.systemId ?? (config.systemId && config.systemId !== 'random' ? config.systemId : 'zufall'));
	const race      = _slug(resolved?.leafId   ?? (config.peopleId !== 'random' ? config.peopleId : 'zufall'));
	const gender    = _slug(resolved
		? (resolved.gender ?? 'unabhaengig')
		: (config.gender !== 'random' ? config.gender : 'zufall'));
	const nameType  = _slug(config.nameType,  'vorname');
	const genType   = _slug(config.genMethod, 'silben');
	const lengthMod = _slug(config.lengthMode, 'gewichtet');
	const syllMod   = _slug(config.probMode,   'gewichtet');
	const seed      = config.seed ? _slug(config.seed) : 'kein-seed';
	const ts        = _getTimestamp();

	return `${system}_${race}_${gender}_${nameType}_${genType}_${lengthMod}_${syllMod}_${seed}_${ts}.txt`;
}

/** Gibt einen Promise zurück, der nach `ms` Millisekunden resolved. */
function _tick(ms = 0) {
	return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════
// THEME TOGGLE
// ═══════════════════════════════════════════════════

/**
 * Initialisiert den Dark/Light-Mode-Schalter.
 *
 * Priorität der Theme-Bestimmung beim Start:
 * 1. localStorage ('ng-theme')
 * 2. OS-Präferenz (prefers-color-scheme)
 * 3. Fallback: light
 */
function initThemeToggle() {
	const html = document.documentElement;
	const toggle = document.getElementById('themeToggle');
	const iconSun = document.getElementById('iconSun');
	const iconMoon = document.getElementById('iconMoon');

	if (!toggle) return;

	function applyTheme(theme) {
		html.setAttribute('data-theme', theme);
		const isDark = theme === 'dark';

		if (iconSun) iconSun.style.display = isDark ? 'none' : '';
		if (iconMoon) iconMoon.style.display = isDark ? '' : 'none';

		toggle.setAttribute(
			'aria-label',
			isDark ? 'Zu Light Mode wechseln' : 'Zu Dark Mode wechseln',
		);
	}

	// Initiales Theme
	const saved = localStorage.getItem('ng-theme');
	const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
	applyTheme(saved ?? (systemDark ? 'dark' : 'light'));

	// Klick → wechseln & persistieren
	toggle.addEventListener('click', () => {
		const current = html.getAttribute('data-theme');
		const next = current === 'dark' ? 'light' : 'dark';
		applyTheme(next);
		localStorage.setItem('ng-theme', next);
	});

	// OS-Präferenz live synchronisieren (nur wenn kein manuelles Override)
	window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
		if (!localStorage.getItem('ng-theme')) {
			applyTheme(e.matches ? 'dark' : 'light');
		}
	});
}

// ═══════════════════════════════════════════════════
// NAMENSLÄNGEN-UI
// ═══════════════════════════════════════════════════

/**
 * Steuert die Sichtbarkeit der Längen-Sub-Inputs basierend auf dem
 * gewählten Längen-Modus (Segmented Control).
 *
 * Modi:
 * - weighted → kein extra Input
 * - random   → kein extra Input
 * - fixed    → Eingabefeld "Feste Länge"
 * - range    → Eingabefelder "Minimum" / "Maximum"
 */
function initLengthModeUI() {
	const radios = document.querySelectorAll('[name="lengthMode"]');
	const fixedSection = document.getElementById('lengthFixed');
	const rangeSection = document.getElementById('lengthRange');

	if (!radios.length) return;

	function update(value) {
		if (fixedSection) fixedSection.style.display = value === 'fixed' ? '' : 'none';
		if (rangeSection) rangeSection.style.display = value === 'range' ? '' : 'none';
	}

	radios.forEach((radio) => {
		radio.addEventListener('change', (e) => update(e.target.value));
	});

	// Initialzustand aus dem checked-Radio lesen
	const checked = document.querySelector('[name="lengthMode"]:checked');
	if (checked) update(checked.value);
}

// ═══════════════════════════════════════════════════
// JSON-IMPORT
// ═══════════════════════════════════════════════════

/**
 * Verarbeitet einen vom Benutzer hochgeladenen JSON-Import.
 *
 * Zwei Verwendungsfälle werden automatisch erkannt:
 * 1. Völker-Metadaten
 *    a) bisheriges Format: Array mit { id, label, files | languageFamilies, system? }
 *    b) neues Format:      { systems?: [...], peoples: [...] }
 *    → werden validiert und in System-/Volksauswahl eingetragen.
 *      Einträge ohne „system“ landen im System „Eigene Daten (Import)“.
 *      Doppelte IDs oder unbekannte Systeme → Import wird vollständig
 *      abgelehnt (nichts wird überschrieben oder teilweise übernommen).
 * 2. Linguistische Daten / Verbindungsnamen
 *    → werden mit einem virtuellen Key (user://<Dateiname>) gecacht und
 *      können von importierten Völkern über diesen Pfad referenziert werden.
 *
 * @param {Event} e - change-Event des File-Inputs
 */
async function handleImport(e) {
	const file = e.target.files?.[0];
	if (!file) return;

	try {
		const data = await loadUserFile(file);
		const key = `user://${file.name}`;
		const payload = normalizeImportPayload(data);

		if (payload) {
			// Strikt: jedes Problem → CatalogValidationError, Katalog bleibt unverändert
			const {catalog, added, notes} = mergeIntoCatalog(_catalog, payload, {
				strict: true,
				defaultSystemId: CUSTOM_SYSTEM.id,
			});
			registerUserData(key, data);
			_catalog = catalog;
			_refreshSelectionUI();

			// Neue Datenreferenzen prüfen (spätere Generierungen warten darauf)
			const probe = _probeAvailability(collectDataPaths(_catalog, added.peoples));
			_availabilityReady = Promise.all([_availabilityReady, probe]).then(() => {});
			await probe;

			const systemNames = [...new Set(added.peoples.map(
				(p) => _catalog.systems.find((s) => s.id === p.systemId)?.label ?? p.systemId,
			))].join(', ');
			const extra = notes.length ? ` (${notes.join(' ')})` : '';
			showToast(
				`✓ ${added.peoples.length} Volk/Völker aus „${file.name}“ hinzugefügt → ${systemNames}${extra}`,
				4500,
			);
		} else {
			registerUserData(key, data);
			// Bereits importierte Völker können auf diesen Key verweisen
			if (_availability.get(key) === 'missing') {
				_availability.set(key, 'ok');
				_refreshSelectionUI();
			}
			showToast(`✓ „${file.name}“ importiert — key: ${key}`, 3500);
		}
	} catch (err) {
		if (err instanceof CatalogValidationError) {
			const shown = err.problems.slice(0, 2).join(' · ');
			const more = err.problems.length > 2 ? ` (+${err.problems.length - 2} weitere)` : '';
			showToast(`⚠ Import abgelehnt: ${shown}${more}`, 7000);
			console.warn('[app] Import-Validierung fehlgeschlagen:', err.problems);
		} else {
			showToast(`⚠ Import fehlgeschlagen: ${err.message}`, 4000);
			console.error('[app] Import-Fehler:', err);
		}
	}

	// Input zurücksetzen → dieselbe Datei kann erneut importiert werden
	e.target.value = '';
}

// ═══════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', init);
