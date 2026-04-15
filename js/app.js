/**
 * app.js — Haupt-Einstiegspunkt des Namensgenerators
 *
 * Verantwortlich für:
 *  - Initialisierung aller Module beim DOM-Ready
 *  - Event-Wiring (Generate, Copy, Export, Theme, Import)
 *  - Orchestrierung des Datenflusses:
 *      Config lesen → Daten laden → Namen generieren → Anzeigen
 *  - RNG-Verwaltung (Seed / Math.random)
 *  - JSON-Import benutzereigener Datensätze
 *  - Theme-Toggle (Dark/Light)
 *  - Namenslängen-UI (Segmented Control ↔ Sub-Inputs)
 *
 * Abhängigkeiten:
 *  - js/dataLoader.js
 *  - js/generator.js
 *  - js/uiController.js
 *  - js/utils.js
 */

import {
	loadPeoples,
	loadLinguisticData,
	loadCompoundData,
	loadUserFile,
	registerUserData,
} from './dataLoader.js';

import {generateNames, generateSyllableName} from './generator.js';
import {initSpecialGenerators} from './specialGenerators.js';

import {createSeededRNG, setRNG, resetRNG, randomPick, formatNumber} from './utils.js';

import {
	initLetterPicker,
	updateLetterPicker,
	initTabs,
	populatePeoples,
	getFormConfig,
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

/** Geladene Völker-Metadaten (aus peoples.json) */
let _peoples = [];

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

	// ── Völker laden & Dropdown befüllen ───────────
	try {
		_peoples = await loadPeoples();
		populatePeoples(_peoples);
	} catch (err) {
		// Kein kritischer Fehler — die App läuft auch ohne peoples.json
		// (nur rein zufällige Generierung möglich)
		console.warn(
			'[app] peoples.json konnte nicht geladen werden:',
			err.message,
			'— Nur zufällige Generierung verfügbar.',
		);
	}

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
			// Ergebnis: A_human_de_male_firstname_syllable_weighted_probbylength_kein-seed_TIMESTAMP.txt
			exportPerLetter(_lastNames, (letter) => `${letter}_${_buildExportFilename()}`);
		}
	});

	// Favoriten leeren
	document.getElementById('clearFavBtn')?.addEventListener('click', () => {
		clearFavorites();
	});

	// ── JSON-Import ─────────────────────────────────
	document.getElementById('importFile')?.addEventListener('change', handleImport);

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
	if (config.seed !== null && config.seed !== '') {
		const numSeed = parseInt(config.seed, 10);
		setRNG(createSeededRNG(isNaN(numSeed) ? config.seed : numSeed));
	} else {
		resetRNG();
	}

	_setGeneratingState(true);
	showLoading();

	// Kurze Verzögerung: Browser-Paint-Tick abwarten
	await _tick(50);

	try {
		// ── Daten laden ─────────────────────────────────
		const {linguisticData, compoundData, specialType} = await _loadDataForConfig(config);

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

		addToHistory(_lastNames, config);
	} catch (err) {
		console.error('[app] Generierungsfehler:', err);
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
 * Lädt die benötigten JSON-Dateien anhand der aktuellen Konfiguration.
 *
 * Gibt ein Objekt zurück:
 * {
 *   linguisticData: object|null   — Silben/Cluster-Daten
 *   compoundData:   object|null   — Verbindungsnamen-Daten
 * }
 *
 * Für nameType === 'fullName' wird je ein firstName/lastName-Sub-Objekt
 * übergeben, damit generateNames() korrekt aufteilen kann.
 *
 * @param {object} config - aus getFormConfig()
 * @returns {Promise<{linguisticData, compoundData}>}
 */
async function _loadDataForConfig(config) {
	const {nameType, genMethod} = config;

	// ── Volk / Sprachfamilie auflösen ───────────────
	const resolvedPeopleId =
		config.peopleId === 'random' ? _resolveRandomPeople() : config.peopleId;

	const meta = _findPeopleMeta(resolvedPeopleId);

	// Kein Datensatz gefunden → rein zufällige Generierung
	if (!meta?.files) {
		return {linguisticData: null, compoundData: null, specialType: null};
	}

	// Sonderfall-Kennung aus den Metadaten übernehmen
	const specialType = meta.specialType ?? null;

	// ── Geschlecht auflösen ─────────────────────────
	const gender =
		config.gender === 'random' ? randomPick(['male', 'female', 'neutral']) : config.gender;

	const files = meta.files;

	// ── Dateipfade ermitteln & laden ────────────────
	if (nameType === 'fullName') {
		return {...(await _loadFullNameData(files, gender)), specialType};
	}

	if (nameType === 'firstName') {
		return {
			...(await _loadSingleTypeData(files.firstName, files.compound?.firstName, gender)),
			specialType,
		};
	}

	if (nameType === 'lastName') {
		return {
			...(await _loadSingleTypeData(files.lastName, files.compound?.lastName, gender)),
			specialType,
		};
	}

	return {linguisticData: null, compoundData: null, specialType: null};
}

/**
 * Lädt Daten für Vor- UND Nachname (nameType === 'fullName').
 * Gibt verschachtelte Objekte zurück, die generateNames() erwartet.
 */
async function _loadFullNameData(files, gender) {
	// Verbindungsnamen werden immer geladen — der Generator entscheidet
	// zur Laufzeit, ob und wie er sie einsetzt (Auto-Mix in generator.js).
	const [firstNameLing, firstNameComp, lastNameLing, lastNameComp] = await Promise.all([
		_loadLingSafe(_resolveGenderedFile(files.firstName, gender)),
		_loadCompSafe(files.compound?.firstName),
		_loadLingSafe(_resolveGenderedFile(files.lastName, gender)),
		_loadCompSafe(files.compound?.lastName),
	]);

	return {
		linguisticData: {firstName: firstNameLing, lastName: lastNameLing},
		compoundData: {firstName: firstNameComp, lastName: lastNameComp},
	};
}

/**
 * Lädt Daten für einen einzelnen Namentyp (firstName oder lastName).
 */
async function _loadSingleTypeData(filesForType, compoundFilePath, gender) {
	// Verbindungsnamen werden immer mitgeladen, wenn ein Pfad angegeben ist.
	const lingPath = _resolveGenderedFile(filesForType, gender);

	const [lingData, compData] = await Promise.all([
		_loadLingSafe(lingPath),
		_loadCompSafe(compoundFilePath), // immer laden — Auto-Mix im Generator
	]);

	return {linguisticData: lingData, compoundData: compData};
}

// ═══════════════════════════════════════════════════
// INTERNE HILFSFUNKTIONEN
// ═══════════════════════════════════════════════════

/**
 * Löst einen geschlechtsspezifischen Dateipfad auf.
 * Akzeptiert sowohl ein Objekt { male, female, neutral }
 * als auch einen direkten String-Pfad (genderunabhängig).
 *
 * Fallback-Reihenfolge bei fehlendem Gender: neutral → male → female → String
 *
 * @param {string|object|undefined} filesForType
 * @param {string} gender - 'male' | 'female' | 'neutral'
 * @returns {string|null}
 */
function _resolveGenderedFile(filesForType, gender) {
	if (!filesForType) return null;

	// Direkter String-Pfad (kein Gender-Split)
	if (typeof filesForType === 'string') return filesForType;

	// Objekt mit Gender-Keys
	return (
		filesForType[gender] ??
		filesForType.neutral ??
		filesForType.male ??
		filesForType.female ??
		null
	);
}

/**
 * Findet Volk-Metadaten anhand einer ID.
 * Durchsucht auch languageFamilies-Untergruppen.
 *
 * @param {string|null} id
 * @returns {object|null}
 */
function _findPeopleMeta(id) {
	if (!id) return null;

	for (const p of _peoples) {
		if (p.id === id) return p;

		// Sprachfamilien-Untergruppen durchsuchen
		if (p.languageFamilies?.length) {
			const sub = p.languageFamilies.find((l) => l.id === id);
			if (sub) return sub;
		}
	}

	return null;
}

/**
 * Wählt ein zufälliges Volk / eine Sprachfamilie aus den Metadaten.
 * Bevorzugt Blatt-Einträge (Sprachfamilien vor Obervölkern).
 *
 * @returns {string|null}
 */
function _resolveRandomPeople() {
	const ids = [];

	for (const p of _peoples) {
		if (p.id === 'random') continue;

		if (p.languageFamilies?.length) {
			// Sprachfamilien als wählbare Blätter
			ids.push(...p.languageFamilies.map((l) => l.id));
		} else if (p.files) {
			ids.push(p.id);
		}
	}

	if (ids.length === 0) return null;
	return ids[Math.floor(Math.random() * ids.length)];
}

/** Lädt linguistische Daten; gibt bei Fehler null zurück (kein throw). */
async function _loadLingSafe(filePath) {
	if (!filePath) return null;
	try {
		return await loadLinguisticData(filePath);
	} catch (err) {
		console.warn(`[app] Datei konnte nicht geladen werden: ${filePath}`, err.message);
		return null;
	}
}

/** Lädt Verbindungsnamen-Daten; gibt bei Fehler null zurück. */
async function _loadCompSafe(filePath) {
	if (!filePath) return null;
	try {
		return await loadCompoundData(filePath);
	} catch (err) {
		console.warn(`[app] Compound-Datei konnte nicht geladen werden: ${filePath}`, err.message);
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

    worker.postMessage({ type: 'generate', linguisticData, compoundData, config, letters });
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

/** Erzeugt einen Dateinamen für den Export basierend auf der Config. */
function _buildExportFilename() {
	const config = getFormConfig();

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
	const race      = _slug(config.peopleId !== 'random' ? config.peopleId : 'zufall');
	const gender    = _slug(config.gender   !== 'random' ? config.gender   : 'zufall');
	const nameType  = _slug(config.nameType,  'vorname');
	const genType   = _slug(config.genMethod, 'silben');
	const lengthMod = _slug(config.lengthMode, 'gewichtet');
	const syllMod   = _slug(config.probMode,   'gewichtet');
	const seed      = config.seed ? _slug(config.seed) : 'kein-seed';
	const ts        = _getTimestamp();

	return `${race}_${gender}_${nameType}_${genType}_${lengthMod}_${syllMod}_${seed}_${ts}.txt`;
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
 * 1. Völker-Metadaten (Array mit { id, label, files })
 *    → wird in das Völker-Dropdown eingetragen
 * 2. Linguistische Daten / Verbindungsnamen
 *    → werden mit einem virtuellen Key gecacht; der Nutzer
 *      kann sie manuell referenzieren (künftiger Plugin-Modus)
 *
 * @param {Event} e - change-Event des File-Inputs
 */
async function handleImport(e) {
	const file = e.target.files?.[0];
	if (!file) return;

	try {
		const data = await loadUserFile(file);
		const key = `user://${file.name}`;
		registerUserData(key, data);

		// Heuristik: Ist es eine Völker-Metadaten-Datei?
		if (_isPeoplesData(data)) {
			const newPeoples = Array.isArray(data) ? data : [data];
			_peoples = [..._peoples, ...newPeoples];
			populatePeoples(_peoples);
			showToast(`✓ ${newPeoples.length} Volk/Völker aus „${file.name}" hinzugefügt`, 3500);
		} else {
			showToast(`✓ „${file.name}" importiert — key: ${key}`, 3500);
		}
	} catch (err) {
		showToast(`⚠ Import fehlgeschlagen: ${err.message}`, 4000);
		console.error('[app] Import-Fehler:', err);
	}

	// Input zurücksetzen → dieselbe Datei kann erneut importiert werden
	e.target.value = '';
}

/**
 * Einfache Heuristik: Ist das ein Völker-Metadaten-Array?
 * @param {any} data
 * @returns {boolean}
 */
function _isPeoplesData(data) {
	if (!Array.isArray(data)) return false;
	if (data.length === 0) return false;
	const first = data[0];
	return (
		typeof first === 'object' && typeof first.id === 'string' && typeof first.label === 'string'
	);
}

// ═══════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', init);
