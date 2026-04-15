/**
 * uiController.js — UI-Controller: DOM-Manipulation & Rendering
 *
 * Verantwortlich für:
 *  - Initialisierung interaktiver Komponenten (Letter Picker, Tabs)
 *  - Befüllen von Dropdowns (Völker, Sprachfamilien)
 *  - Auslesen aller Formularwerte → Config-Objekt
 *  - Rendern der generierten Namen (alphabetisch, gruppiert)
 *  - Zustands-Management (loading / empty / error / results)
 *  - Tab-Steuerung (Ergebnisse / Favoriten / Verlauf)
 *  - Clipboard-Aktionen & Export
 *  - Toast-Benachrichtigungen
 */

import { sortAndGroupOutput, getSortedNames, sortNames, formatNumber, extractPrefixLetters } from './utils.js';
import { VirtualList, VIRTUAL_THRESHOLD } from './virtualList.js';

// ─────────────────────────────────────────────────
// Modul-interner State
// ─────────────────────────────────────────────────
let _favorites  = new Set(); // Set<string> — gespeicherte Favoriten
let _history    = [];        // Array<{ names, config, timestamp }>
let _activeTab  = 'results';
/** Buchstaben→Anzahl während chunkweiser Generierung */
const _chunkedTotals = new Map();

/** Map<letter, VirtualList> — aktive Virtual-List-Instanzen pro Buchstabe */
const _virtualLists = new Map();

// ═══════════════════════════════════════════════════
// LETTER PICKER
// ═══════════════════════════════════════════════════

/**
 * Erzeugt die A–Z Buchstabenauswahl dynamisch.
 * Buttons erhalten die Klasse .letter-btn; aktive bekommen .is-active.
 */
/**
 * Erstellt Buchstaben-Buttons für den Letter-Picker.
 * Interne Hilfsfunktion — wird von initLetterPicker und updateLetterPicker
 * gemeinsam genutzt.
 *
 * @param {string[]} letters
 * @param {Set<string>} activeLetters - aktuell aktive Buchstaben (werden übernommen)
 * @returns {DocumentFragment}
 */
function _buildLetterButtons(letters, activeLetters = new Set()) {
  const frag = document.createDocumentFragment();
  for (const letter of letters) {
    const btn = document.createElement('button');
    btn.type           = 'button';
    btn.className      = 'letter-btn';
    btn.textContent    = letter;
    btn.dataset.letter = letter;
    const isActive = activeLetters.has(letter);
    btn.setAttribute('aria-pressed', String(isActive));
    if (isActive) btn.classList.add('is-active');
    btn.title = `Filter: ${letter}`;
    btn.addEventListener('click', () => {
      const active = btn.classList.toggle('is-active');
      btn.setAttribute('aria-pressed', String(active));
    });
    frag.appendChild(btn);
  }
  return frag;
}

/**
 * Initialisiert den A–Z Letter-Picker (statisch, beim App-Start).
 * Beim Wechsel des Datensatzes updateLetterPicker() aufrufen.
 */
export function initLetterPicker() {
  const container = document.getElementById('letterPicker');
  if (!container) return;

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  container.innerHTML = '';
  container.appendChild(_buildLetterButtons(letters));

  // Doppelklick → alle abwählen
  container.addEventListener('dblclick', (e) => {
    if (e.target.classList.contains('letter-btn')) {
      container.querySelectorAll('.letter-btn.is-active').forEach(b => {
        b.classList.remove('is-active');
        b.setAttribute('aria-pressed', 'false');
      });
    }
  });
}

/**
 * Aktualisiert den Letter-Picker dynamisch anhand der geladenen Datensätze.
 * Zeigt nur Buchstaben, die in den linguistischen Daten als Präfixe vorhanden
 * sind — plus alle Buchstaben, für die bereits Namen generiert wurden.
 *
 * Aktive Auswahl wird erhalten, soweit die Buchstaben noch vorhanden sind.
 *
 * @param {object|null} linguisticData - aktuell geladene linguistische Daten
 */
export function updateLetterPicker(linguisticData) {
  const container = document.getElementById('letterPicker');
  if (!container) return;

  // Aktuelle Auswahl merken
  const prevActive = new Set(
    [...container.querySelectorAll('.letter-btn.is-active')].map(b => b.dataset.letter)
  );

  // Dynamische Buchstaben aus den Daten
  const fromData = extractPrefixLetters(linguisticData);

  // Fallback: A–Z wenn keine Daten vorhanden
  const letters = fromData.length > 0
    ? fromData
    : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

  // Nur noch gültige aktive Buchstaben behalten
  const stillActive = new Set([...prevActive].filter(l => letters.includes(l)));

  container.innerHTML = '';
  container.appendChild(_buildLetterButtons(letters, stillActive));
}

/**
 * Gibt die aktiven Anfangsbuchstaben als Set zurück.
 * @returns {Set<string>|null} — null wenn kein Filter aktiv
 */
export function getSelectedLetters() {
  const active = document.querySelectorAll('.letter-btn.is-active');
  if (active.length === 0) return null;
  return new Set([...active].map(btn => btn.dataset.letter));
}

// ═══════════════════════════════════════════════════
// VÖLKER / SPRACHFAMILIEN
// ═══════════════════════════════════════════════════

/**
 * Befüllt den Völker-Select mit Einträgen aus der peoples.json.
 * Völker mit languageFamilies erhalten ein <optgroup>.
 *
 * @param {Array} peoples - Metadaten-Array
 */
export function populatePeoples(peoples) {
  const select = document.getElementById('selectPeople');
  if (!select) return;

  // "Zufall"-Option beibehalten, Rest ersetzen
  select.innerHTML = '<option value="random">Zufall</option>';

  for (const people of peoples) {
    if (people.id === 'random') continue;

    if (people.languageFamilies?.length > 0) {
      // Mit Untergruppen → <optgroup>
      const group = document.createElement('optgroup');
      group.label = people.label;

      for (const lang of people.languageFamilies) {
        const opt        = document.createElement('option');
        opt.value        = lang.id;
        opt.textContent  = lang.label;
        group.appendChild(opt);
      }
      select.appendChild(group);
    } else {
      const opt        = document.createElement('option');
      opt.value        = people.id;
      opt.textContent  = people.label;
      select.appendChild(opt);
    }
  }
}

// ═══════════════════════════════════════════════════
// FORMULAR-WERTE AUSLESEN
// ═══════════════════════════════════════════════════

/**
 * Sammelt alle Formularwerte in ein einheitliches Config-Objekt.
 *
 * @returns {{
 *   peopleId:       string,
 *   gender:         string,
 *   nameType:       string,
 *   genMethod:      string,
 *   count:          number,
 *   generateAll:    boolean,
 *   lengthMode:     string,
 *   fixedLength:    number,
 *   minLength:      number,
 *   maxLength:      number,
 *   probMode:       string,
 *   startingLetters: Set<string>|null,
 *   seed:           string|null,
 *   favoritesEnabled: boolean,
 * }}
 */
export function getFormConfig() {
  /**
   * Liest einen Feldwert aus: zuerst aus einem <select name="...">,
   * dann aus einem checked Radio-Input. Unterstützt dadurch beide
   * UI-Muster ohne doppelte Logik.
   */
  const getField = (name) => {
    const select = document.querySelector(`select[name="${name}"]`);
    if (select) return select.value;
    return document.querySelector(`[name="${name}"]:checked`)?.value ?? null;
  };

  const getNum = (id, fallback) => {
    const v = parseInt(document.getElementById(id)?.value ?? '', 10);
    return isNaN(v) ? fallback : v;
  };

  return {
    peopleId:         document.getElementById('selectPeople')?.value  ?? 'random',
    gender:           getField('gender')     ?? 'random',
    nameType:         getField('nameType')   ?? 'firstName',
    genMethod:        getField('genMethod')  ?? 'syllable',
    count:            getNum('nameCount', 10),
    generateAll:      document.getElementById('generateAll')?.checked  ?? false,
    lengthMode:       getField('lengthMode') ?? 'weighted',
    fixedLength:      getNum('fixedLength', 6),
    minLength:        getNum('minLength', 4),
    maxLength:        getNum('maxLength', 10),
    probMode:         getField('probMode')   ?? 'probByLength',
    startingLetters:  getSelectedLetters(),
    seed:             document.getElementById('seedInput')?.value?.trim() || null,
    favoritesEnabled: document.getElementById('favoritesEnabled')?.checked ?? false,
  };
}

// ═══════════════════════════════════════════════════
// ZUSTAND (Loading / Empty / Error / Results)
// ═══════════════════════════════════════════════════

const STATE_IDS = ['loadingState', 'emptyState', 'errorState', 'resultsOutput'];

function _showState(id) {
  for (const sid of STATE_IDS) {
    const el = document.getElementById(sid);
    if (el) el.style.display = (sid === id) ? '' : 'none';
  }
}

export function showLoading()           { _showState('loadingState'); }
export function showEmpty()             { _showState('emptyState'); }

export function showError(message) {
  const el = document.getElementById('errorMessage');
  if (el) el.textContent = message;
  _showState('errorState');
  _updateResultsCount(null);
  _setActionButtonsEnabled(false);
}

// ═══════════════════════════════════════════════════
// RESULTS RENDERN
// ═══════════════════════════════════════════════════

/**
 * Rendert die generierten Namen in alphabetischen Gruppen (vollständiger Rebuild).
 * Für chunkweise Generierung stattdessen initResultsForChunkedMode() +
 * appendLetterGroup() verwenden, um Flackern zu vermeiden.
 *
 * @param {string[]} names
 * @param {boolean}  favoritesEnabled
 */
export function displayResults(names, favoritesEnabled = false) {
  if (!names || names.length === 0) {
    showEmpty();
    _updateResultsCount(0);
    return;
  }

  const output = document.getElementById('resultsOutput');
  if (!output) return;

  const groups = sortAndGroupOutput(names);

  // DocumentFragment verhindert mehrfache Reflows
  const frag = document.createDocumentFragment();
  let delay = 0;
  for (const [letter, letterNames] of groups) {
    const section = _buildLetterGroup(letter, letterNames, favoritesEnabled, delay);
    frag.appendChild(section);
    delay += 30;
  }

  output.innerHTML = '';       // einmaliger Reflow
  output.appendChild(frag);   // einmaliges Paint

  _showState('resultsOutput');
  _updateResultsCount(names.length);
  _setActionButtonsEnabled(true);
  _setTabCount('tabResultsCount', names.length);
}

/**
 * Bereitet den Ergebniscontainer für chunkweise Generierung vor.
 * Muss einmalig zu Beginn einer „Alle Kombinationen"-Generierung aufgerufen
 * werden — leert den Container und setzt den internen Buchstaben-Zähler zurück.
 */
export function initResultsForChunkedMode() {
  const output = document.getElementById('resultsOutput');
  if (output) output.innerHTML = '';
  _chunkedTotals.clear();
  // VirtualList-Instanzen zerstören — vermeidet Scroll-Listener-Leaks
  _virtualLists.forEach(vl => vl.destroy());
  _virtualLists.clear();
  _updateResultsCount(0);
  _setActionButtonsEnabled(false);
  _setTabCount('tabResultsCount', 0);
}

/**
 * Hängt einen einzelnen Buchstaben-Chunk inkrementell ans DOM an.
 * Erzeugt bei neuem Buchstaben eine komplette <section>,
 * bei bestehendem Buchstaben werden nur die neuen Namen-<li> per
 * DocumentFragment angehängt — kein kompletter Re-Render, kein Flackern.
 *
 * @param {string}   letter           - Anfangsbuchstabe ('A'…'Z')
 * @param {string[]} names            - Namen dieses Chunks
 * @param {boolean}  favoritesEnabled
 */
export function appendLetterGroup(letter, names, favoritesEnabled = false) {
  if (!names || names.length === 0) return;

  const output = document.getElementById('resultsOutput');
  if (!output) return;

  // Namen innerhalb des Chunks sortieren — zentrale Sortierfunktion
  const sorted = sortNames(names);

  const existingSection = document.getElementById(`group-${letter}`);

  if (!existingSection) {
    // Neue Buchstabengruppe — vollständige Section aufbauen
    const section = _buildLetterGroup(letter, sorted, favoritesEnabled, 0);
    output.appendChild(section);
    _chunkedTotals.set(letter, sorted.length);
  } else {
    // Bestehende Gruppe — nur neue Namen anhängen, kein Rebuild
    const list  = existingSection.querySelector('.name-list');
    const badge = existingSection.querySelector('.letter-group-count');

    const nameFrag = document.createDocumentFragment();
    sorted.forEach(name => nameFrag.appendChild(_buildNameItem(name, favoritesEnabled)));
    if (list) list.appendChild(nameFrag);

    const newCount = (_chunkedTotals.get(letter) ?? 0) + sorted.length;
    _chunkedTotals.set(letter, newCount);
    if (badge) badge.textContent = newCount;
  }

  // Globalen Zähler + Header aktualisieren
  const total = [..._chunkedTotals.values()].reduce((s, c) => s + c, 0);
  _showState('resultsOutput');
  _updateResultsCount(total);
  _setActionButtonsEnabled(true);
  _setTabCount('tabResultsCount', total);
}

/**
 * Baut einen <section> für eine Buchstabengruppe.
 */
function _buildLetterGroup(letter, names, favoritesEnabled, animDelay) {
  const section = document.createElement('section');
  section.className = 'letter-group';
  section.id        = `group-${letter}`;
  section.style.animationDelay = `${animDelay}ms`;

  // Header
  const header = document.createElement('div');
  header.className = 'letter-group-header';

  const h3 = document.createElement('h3');
  h3.className   = 'letter-group-title';
  h3.textContent = letter;

  const badge = document.createElement('span');
  badge.className   = 'letter-group-count';
  badge.textContent = names.length;

  header.appendChild(h3);
  header.appendChild(badge);
  section.appendChild(header);

  // Namen-Liste
  const list = document.createElement('ul');
  list.className    = 'name-list';
  list.setAttribute('aria-label', `Namen mit ${letter}`);

  for (const name of names) {
    list.appendChild(_buildNameItem(name, favoritesEnabled));
  }

  section.appendChild(list);
  return section;
}

/**
 * Baut ein einzelnes Namens-Element.
 * - Klick → Name in Zwischenablage kopieren
 * - Langer Klick / ⭐-Button → Favorit umschalten (wenn aktiviert)
 */
function _buildNameItem(name, favoritesEnabled) {
  const li = document.createElement('li');
  // .visible sofort setzen → kein Fade für Batch-Rendering (kein Flackern bei Bulk-Display)
  li.className   = 'name-item visible';
  li.textContent = name;

  if (_favorites.has(name)) li.classList.add('is-favorite');

  // Klick → kopieren
  li.addEventListener('click', () => {
    navigator.clipboard?.writeText(name)
      .then(() => showToast(`„${name}" kopiert ✓`))
      .catch(() => showToast(`„${name}" — Kopieren fehlgeschlagen`));
  });

  // Favorit-Toggle via Rechtsklick (Desktop) + Long-Press (Mobile)
  if (favoritesEnabled) {
    li.title = 'Klick: kopieren · Rechtsklick / langer Druck: Favorit';

    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      _toggleFavorite(name, li);
    });

    // Long-Press für Touch-Geräte (500 ms)
    let _longPressTimer = null;
    li.addEventListener('touchstart', () => {
      _longPressTimer = setTimeout(() => _toggleFavorite(name, li), 500);
    }, { passive: true });
    li.addEventListener('touchend',   () => clearTimeout(_longPressTimer));
    li.addEventListener('touchmove',  () => clearTimeout(_longPressTimer));
  } else {
    li.title = `„${name}" kopieren`;
  }

  return li;
}

// ═══════════════════════════════════════════════════
// FAVORITEN
// ═══════════════════════════════════════════════════

function _toggleFavorite(name, element) {
  if (_favorites.has(name)) {
    _favorites.delete(name);
    element?.classList.remove('is-favorite');
    showToast(`„${name}" aus Favoriten entfernt`);
  } else {
    _favorites.add(name);
    element?.classList.add('is-favorite');
    showToast(`⭐ „${name}" zu Favoriten hinzugefügt`);
  }
  _renderFavorites();
  _setTabCount('tabFavCount', _favorites.size);
}

export function clearFavorites() {
  _favorites.clear();
  _renderFavorites();
  _setTabCount('tabFavCount', 0);
  showToast('Favoriten geleert');
}

function _renderFavorites() {
  const output = document.getElementById('favoritesOutput');
  if (!output) return;

  if (_favorites.size === 0) {
    output.innerHTML = `
      <div class="state-container">
        <p class="empty-title">Keine Favoriten gespeichert</p>
        <p class="empty-subtitle">Rechtsklick auf einen Namen, um ihn als Favorit zu markieren.</p>
        <p class="mobile-hint">Auf Mobilgeräten: langer Druck auf einen Namen.</p>
      </div>`;
    return;
  }

  const groups = sortAndGroupOutput([..._favorites]);
  const frag   = document.createDocumentFragment();
  for (const [letter, names] of groups) {
    frag.appendChild(_buildLetterGroup(letter, names, true, 0));
  }
  // Hinweis am Ende der Favoritenliste
  const hint = document.createElement('p');
  hint.className   = 'mobile-hint mobile-hint--inline';
  hint.textContent = 'Auf Mobilgeräten: langer Druck auf einen Namen zum Entfernen.';
  frag.appendChild(hint);

  output.innerHTML = '';
  output.appendChild(frag);
}

export function getFavorites() {
  return [..._favorites];
}

// ═══════════════════════════════════════════════════
// VERLAUF (History)
// ═══════════════════════════════════════════════════

/**
 * Fügt einen Eintrag zum Verlauf hinzu.
 * @param {string[]} names
 * @param {object}   config
 */
export function addToHistory(names, config) {
  const entry = {
    id:        Date.now(),
    names:     [...names],
    config:    { ...config },
    timestamp: new Date(),
    count:     names.length,
  };

  _history.unshift(entry); // neueste zuerst
  if (_history.length > 20) _history.pop(); // max 20 Einträge

  _renderHistory();
  _setTabCount('tabHistCount', _history.length);
}

function _renderHistory() {
  const output = document.getElementById('historyOutput');
  if (!output) return;

  if (_history.length === 0) {
    output.innerHTML = `
      <div class="state-container">
        <div class="empty-icon">🕒</div>
        <p class="empty-title">Noch kein Verlauf</p>
        <p class="empty-subtitle">Generierte Namenslisten erscheinen hier.</p>
      </div>`;
    return;
  }

  output.innerHTML = '';

  for (const entry of _history) {
    const item = document.createElement('div');
    item.className = 'history-item';

    const preview = entry.names.slice(0, 6).join(', ') +
      (entry.names.length > 6 ? ` … +${entry.names.length - 6}` : '');

    item.innerHTML = `
      <div class="history-meta">
        <div class="history-title">${entry.config.nameType} · ${entry.config.genMethod} · ${entry.config.peopleId}</div>
        <div class="history-sub">${entry.timestamp.toLocaleTimeString('de-DE')} — ${formatNumber(entry.count)} Namen</div>
        <div class="history-preview">${preview}</div>
      </div>`;

    // Klick → Verlaufseintrag wiederherstellen
    item.addEventListener('click', () => {
      displayResults(entry.names, false);
      switchTab('results');
      showToast(`Verlaufseintrag mit ${formatNumber(entry.count)} Namen geladen`);
    });

    output.appendChild(item);
  }
}

// ═══════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════

/**
 * Initialisiert die Tab-Navigation.
 */
export function initTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

/**
 * Wechselt den aktiven Tab.
 * @param {'results'|'favorites'|'history'} tabId
 */
export function switchTab(tabId) {
  _activeTab = tabId;

  const panels = {
    results:   'tabPanelResults',
    favorites: 'tabPanelFavorites',
    history:   'tabPanelHistory',
  };

  const buttons = {
    results:   'tabResults',
    favorites: 'tabFavorites',
    history:   'tabHistory',
  };

  // Panels ein-/ausblenden
  for (const [key, panelId] of Object.entries(panels)) {
    const el = document.getElementById(panelId);
    if (el) el.style.display = key === tabId ? '' : 'none';
    const btn = document.getElementById(buttons[key]);
    if (btn) {
      btn.classList.toggle('is-active', key === tabId);
      btn.setAttribute('aria-selected', String(key === tabId));
    }
  }

  // Favoriten-Löschen-Button zeigen/verstecken
  const clearFavBtn = document.getElementById('clearFavBtn');
  if (clearFavBtn) {
    clearFavBtn.style.display = (tabId === 'favorites' && _favorites.size > 0) ? '' : 'none';
  }
}

// ═══════════════════════════════════════════════════
// INTERNE HELFER — UI Updates
// ═══════════════════════════════════════════════════

function _updateResultsCount(count) {
  const el = document.getElementById('resultsCount');
  if (!el) return;
  if (count === null || count === undefined) {
    el.textContent = '—';
  } else {
    el.textContent = `${formatNumber(count)} Name${count !== 1 ? 'n' : ''}`;
  }
}

function _setActionButtonsEnabled(enabled) {
  ['copyBtn', 'exportBtn', 'exportPerLetterBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !enabled;
  });
}

function _setTabCount(id, count) {
  const el = document.getElementById(id);
  if (el) el.textContent = count > 999 ? '999+' : String(count);
}

// ═══════════════════════════════════════════════════
// SINGLE-NAME STREAMING — Binary Search + Fade-In
// ═══════════════════════════════════════════════════

/**
 * Binary Search: Findet den Einfügeindex in einer sortierten Kinderliste.
 *
 * Sortierkriterien (identisch mit sortNames() aus utils.js):
 *  1. Anfangsbuchstabe alphabetisch (de-Locale)
 *  2. Namenslänge aufsteigend
 *  3. Lexikografisch als Tiebreaker (de-Locale)
 *
 * Laufzeit: O(log n) statt O(n) beim linearen Durchsuchen —
 * bei 1 000 Namen ca. 10× schneller als indexOf/find.
 *
 * @param {HTMLCollection} items - .children des Listen-Elements
 * @param {string}         name  - einzufügender Name
 * @returns {number} Index, vor dem eingefügt werden soll
 */
function findInsertIndex(items, name) {
  let low  = 0;
  let high = items.length;

  while (low < high) {
    const mid     = (low + high) >> 1;
    const current = items[mid].textContent;

    const la = (name.charAt(0)    || '').toUpperCase();
    const lb = (current.charAt(0) || '').toUpperCase();
    const compare = (la !== lb)
      ? la.localeCompare(lb, 'de')
      : (name.length - current.length || name.localeCompare(current, 'de'));

    if (compare < 0) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return low;
}

/**
 * Fügt ein DOM-Element per Binary Search sortiert in einen Container ein.
 *
 * @param {HTMLElement} parent - Elternelement (z. B. <ul class="name-list">)
 * @param {HTMLElement} el     - einzufügendes Element
 * @param {string}      name   - Namenstext (für den Sortiervergleich)
 */
function insertSorted(parent, el, name) {
  const items = parent.children;
  const index = findInsertIndex(items, name);

  if (index >= items.length) {
    parent.appendChild(el);
  } else {
    parent.insertBefore(el, items[index]);
  }
}

/**
 * Fügt eine neue Letter-Group-<section> alphabetisch sortiert in den Output ein.
 *
 * @param {HTMLElement} output  - #resultsOutput
 * @param {HTMLElement} section - neue <section class="letter-group">
 * @param {string}      letter  - Anfangsbuchstabe ('A'…'Z' etc.)
 */
function _insertSectionSorted(output, section, letter) {
  const sections = output.querySelectorAll('.letter-group');
  for (const existing of sections) {
    const existingLetter = existing.id.replace('group-', '');
    if (letter.localeCompare(existingLetter, 'de') < 0) {
      output.insertBefore(section, existing);
      return;
    }
  }
  output.appendChild(section);
}

/**
 * Fügt einen einzelnen Namen sofort ins DOM ein (Streaming-Modus).
 *
 * Verhalten:
 *  - Erstellt bei Bedarf eine neue Buchstabengruppe (alphabetisch sortiert)
 *  - Fügt den Namen per Binary Search an der richtigen Position ein → O(log n)
 *  - Startet eine Fade-In-Animation via requestAnimationFrame
 *  - Aktualisiert Badge + globalen Zähler nach jedem Einfügen
 *
 * @param {string}  name
 * @param {boolean} favoritesEnabled
 */
export function appendSingleName(name, favoritesEnabled = false) {
  if (!name) return;

  const output = document.getElementById('resultsOutput');
  if (!output) return;

  const letter = name[0].toUpperCase();
  let section  = document.getElementById(`group-${letter}`);

  // ── Buchstabengruppe erzeugen (wenn noch nicht vorhanden) ──────────────
  if (!section) {
    section           = document.createElement('section');
    section.className = 'letter-group';
    section.id        = `group-${letter}`;

    const header      = document.createElement('div');
    header.className  = 'letter-group-header';

    const h3          = document.createElement('h3');
    h3.className      = 'letter-group-title';
    h3.textContent    = letter;

    const badge       = document.createElement('span');
    badge.className   = 'letter-group-count';
    badge.textContent = '0';

    header.appendChild(h3);
    header.appendChild(badge);
    section.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'name-list';
    list.setAttribute('aria-label', `Namen mit ${letter}`);
    section.appendChild(list);

    // Gruppe alphabetisch korrekt einsortieren
    _insertSectionSorted(output, section, letter);
  }

  const list  = section.querySelector('.name-list:not(.name-list--virtual)');
  const badge = section.querySelector('.letter-group-count');

  // ── VirtualList bereits aktiv → dort einfügen (NICHT direkt ins DOM!) ──
  if (_virtualLists.has(letter)) {
    const vl = _virtualLists.get(letter);
    vl.addItem(name);
    if (badge) badge.textContent = vl.count;
    _chunkedTotals.set(letter, vl.count);
    _updateGlobalCount();
    return;
  }

  if (!list) return;

  // ── Name-Element bauen (startet bei opacity:0 via CSS) ─────────────────
  const el          = document.createElement('li');
  el.className      = 'name-item';       // noch KEIN .visible → opacity: 0
  el.textContent    = name;

  if (_favorites.has(name)) el.classList.add('is-favorite');

  // Klick → kopieren
  el.addEventListener('click', () => {
    navigator.clipboard?.writeText(name)
      .then(() => showToast(`„${name}" kopiert ✓`))
      .catch(() => showToast(`„${name}" — Kopieren fehlgeschlagen`));
  });

  // Favorit-Aktionen
  if (favoritesEnabled) {
    el.title = 'Klick: kopieren · Rechtsklick / langer Druck: Favorit';
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      _toggleFavorite(name, el);
    });
    let _longPressTimer = null;
    el.addEventListener('touchstart', () => {
      _longPressTimer = setTimeout(() => _toggleFavorite(name, el), 500);
    }, { passive: true });
    el.addEventListener('touchend',  () => clearTimeout(_longPressTimer));
    el.addEventListener('touchmove', () => clearTimeout(_longPressTimer));
  } else {
    el.title = `„${name}" kopieren`;
  }

  // ── Sortiert einfügen (Binary Search O(log n)) ─────────────────────────
  insertSorted(list, el, name);

  // ── Fade-In nach Browser-Paint-Tick ────────────────────────────────────
  // requestAnimationFrame stellt sicher, dass der Browser das Element
  // erst rendert (opacity: 0), bevor .visible die Transition auslöst.
  requestAnimationFrame(() => {
    el.classList.add('visible');
  });

  // ── Badge + Zähler aktualisieren ───────────────────────────────────────
  const newCount = list.children.length;
  if (badge) badge.textContent = newCount;
  _chunkedTotals.set(letter, newCount);

  // ── VirtualList aktivieren wenn Schwelle überschritten ─────────────────
  if (newCount >= VIRTUAL_THRESHOLD) {
    _activateVirtualList(section, letter, favoritesEnabled);
  }

  _updateGlobalCount();
}

/**
 * Fügt einen ganzen Batch (eine Buchstabengruppe) effizient ins DOM ein.
 * Deutlich schneller als appendSingleName × n bei Worker-Batches.
 *
 * @param {string}   letter
 * @param {string[]} names            — bereits dedupliziert, unsortiert
 * @param {boolean}  favoritesEnabled
 */
export function appendNameBatch(letter, names, favoritesEnabled = false) {
  if (!names || names.length === 0) return;

  const output = document.getElementById('resultsOutput');
  if (!output) return;

  let section = document.getElementById(`group-${letter}`);

  // ── Buchstabengruppe anlegen (wenn neu) ────────────────────────────────
  if (!section) {
    section           = document.createElement('section');
    section.className = 'letter-group';
    section.id        = `group-${letter}`;

    const header = document.createElement('div');
    header.className = 'letter-group-header';

    const h3 = document.createElement('h3');
    h3.className   = 'letter-group-title';
    h3.textContent = letter;

    const badgeEl = document.createElement('span');
    badgeEl.className   = 'letter-group-count';
    badgeEl.textContent = '0';

    header.appendChild(h3);
    header.appendChild(badgeEl);
    section.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'name-list';
    list.setAttribute('aria-label', `Namen mit ${letter}`);
    section.appendChild(list);

    _insertSectionSorted(output, section, letter);
  }

  const badge = section.querySelector('.letter-group-count');

  // ── VirtualList bereits aktiv → dort einfügen ──────────────────────────
  if (_virtualLists.has(letter)) {
    const vl = _virtualLists.get(letter);
    vl.addItems(names);
    if (badge) badge.textContent = vl.count;
    _chunkedTotals.set(letter, vl.count);
    _updateGlobalCount();
    return;
  }

  // ── Normales DOM-Rendering via Fragment ────────────────────────────────
  const list = section.querySelector('.name-list');
  if (!list) return;

  // Zentrale Sortierung: bestehende + neue Namen zusammenführen und sortieren.
  // WICHTIG: Einfaches list.appendChild(frag) wäre falsch — neue Namen können
  // alphabetisch/nach Länge VOR bereits gerenderten Namen gehören.
  const existingNames = [...list.querySelectorAll('.name-item')]
    .map(li => li.textContent.trim())
    .filter(Boolean);

  const merged = sortNames([...existingNames, ...names]);

  const frag = document.createDocumentFragment();
  for (const name of merged) {
    frag.appendChild(_buildNameItem(name, favoritesEnabled));
  }
  list.innerHTML = '';
  list.appendChild(frag);

  const newCount = list.children.length;
  if (badge) badge.textContent = newCount;
  _chunkedTotals.set(letter, newCount);

  // ── VirtualList aktivieren wenn Schwelle überschritten ─────────────────
  if (newCount >= VIRTUAL_THRESHOLD) {
    _activateVirtualList(section, letter, favoritesEnabled);
  }

  _updateGlobalCount();
}

/**
 * Aktiviert VirtualList für eine Buchstabengruppe.
 * Migriert alle bestehenden DOM-Items in die VirtualList.
 */
function _activateVirtualList(section, letter, favoritesEnabled) {
  const oldList = section.querySelector('.name-list');
  if (!oldList) return;

  const existingNames = [...oldList.querySelectorAll('.name-item')]
    .map(li => li.textContent.trim())
    .filter(Boolean);

  const vl = new VirtualList(section, {
    favoritesEnabled,
    favorites: _favorites,
    onItemClick: (name) => {
      navigator.clipboard?.writeText(name)
        .then(() => showToast(`„${name}" kopiert ✓`))
        .catch(() => showToast(`„${name}" — Kopieren fehlgeschlagen`));
    },
    onItemFavorite: (name, el) => _toggleFavorite(name, el),
  });

  oldList.remove();
  vl.setItems(existingNames);
  _virtualLists.set(letter, vl);

  const header = section.querySelector('.letter-group-header');
  if (header && !header.querySelector('.letter-group-virtual-badge')) {
    const badge = document.createElement('span');
    badge.className   = 'letter-group-virtual-badge';
    badge.textContent = 'virtual';
    header.appendChild(badge);
  }
}

/** Aktualisiert Gesamtzähler, Status-Anzeigen und Action-Buttons. */
function _updateGlobalCount() {
  const total = [..._chunkedTotals.values()].reduce((s, c) => s + c, 0);
  _showState('resultsOutput');
  _updateResultsCount(total);
  _setActionButtonsEnabled(true);
  _setTabCount('tabResultsCount', total);
}



let _toastTimer = null;

/**
 * Zeigt eine kurze Benachrichtigung am unteren Rand.
 * @param {string} message
 * @param {number} duration - Anzeigedauer in ms (Standard: 2500)
 */
export function showToast(message, duration = 2500) {
  const toast = document.getElementById('toast');
  if (!toast) return;

  clearTimeout(_toastTimer);


  toast.textContent = message;
  toast.classList.add('is-visible');

  _toastTimer = setTimeout(() => {
    toast.classList.remove('is-visible');
  }, duration);
}

// ═══════════════════════════════════════════════════
// CLIPBOARD & EXPORT
// ═══════════════════════════════════════════════════

/**
 * Kopiert alle Namen als Zeilenumbruch-getrennten Text in die Zwischenablage.
 * @param {string[]} names
 */
export async function copyToClipboard(names) {
  if (!navigator.clipboard) {
    showToast('Clipboard-API nicht verfügbar', 3000);
    return;
  }
  // getSortedNames stellt dieselbe Reihenfolge wie die UI-Darstellung sicher
  const sorted = getSortedNames(names);
  try {
    await navigator.clipboard.writeText(sorted.join('\n'));
    showToast(`${formatNumber(sorted.length)} Namen kopiert ✓`);
  } catch {
    showToast('Fehler beim Kopieren', 3000);
  }
}

/**
 * Exportiert alle Namen als eine einzige .txt-Datei.
 * @param {string[]} names
 * @param {string}   filename
 */
export function exportAsTxt(names, filename = 'namen.txt') {
  // Gleiche Reihenfolge wie UI: alphabetisch, dann nach Länge
  const sorted = getSortedNames(names);
  const text   = sorted.join('\n');
  _triggerDownload(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
  showToast('Datei wird heruntergeladen…');
}

/**
 * Exportiert Namen gruppiert nach Anfangsbuchstaben (eine Datei pro Buchstabe).
 *
 * Der optionale Parameter `filenameFn` erlaubt dem Aufrufer, den Dateinamen
 * pro Buchstabe vollständig zu kontrollieren — inkl. aller Generierungs-
 * parameter und des Buchstabens als Präfix.
 *
 * Standard-Fallback (ohne filenameFn): `namen_${letter}.txt`
 *
 * @param {string[]} names
 * @param {(letter: string) => string} [filenameFn] — Dateinamen-Builder
 */
export function exportPerLetter(names, filenameFn) {
  const _defaultFn = (letter) => `namen_${letter}.txt`;
  const buildFilename = typeof filenameFn === 'function' ? filenameFn : _defaultFn;

  const groups = sortAndGroupOutput(names);
  for (const [letter, letterNames] of groups) {
    // letterNames sind bereits durch sortAndGroupOutput sortiert
    const blob = new Blob([letterNames.join('\n')], { type: 'text/plain;charset=utf-8' });
    _triggerDownload(blob, buildFilename(letter));
  }
  showToast(`${groups.size} Dateien werden heruntergeladen…`);
}

function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
