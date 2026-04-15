/**
 * virtualList.js — Virtual Scrolling für große Namenslisten
 *
 * Aktiviert sich automatisch (via uiController), wenn eine Buchstabengruppe
 * VIRTUAL_THRESHOLD Items überschreitet.
 *
 * Unterhalb des Schwellenwerts: normales DOM-Rendering (bestehende Logik).
 * Ab VIRTUAL_THRESHOLD: VirtualList übernimmt — hält alle Namen im Speicher,
 * rendert nur sichtbare Items in einem festen Viewport.
 *
 * Layout-Wechsel bei Aktivierung:
 *   flex-wrap (Chip-Ansicht) → vertikale Liste im scrollbaren Container
 * Dies ist bei 500+ Namen sinnvoller als tausende nicht lesbare Chips.
 */

export const VIRTUAL_THRESHOLD = 500;

export class VirtualList {
  /**
   * @param {HTMLElement} container  — übergeordnetes <section> Element
   * @param {object}      options
   * @param {number}      [options.itemHeight=34]
   * @param {number}      [options.renderBuffer=8]
   * @param {boolean}     [options.favoritesEnabled=false]
   * @param {Set<string>} [options.favorites]
   * @param {Function}    [options.onItemClick]
   * @param {Function}    [options.onItemFavorite]
   */
  constructor(container, options = {}) {
    this.container        = container;
    this.itemHeight       = options.itemHeight       ?? 34;
    this.renderBuffer     = options.renderBuffer     ?? 8;
    this.favoritesEnabled = options.favoritesEnabled ?? false;
    this.favorites        = options.favorites        ?? new Set();
    this.onItemClick      = options.onItemClick      ?? null;
    this.onItemFavorite   = options.onItemFavorite   ?? null;

    /** @type {string[]} alle Namen, sortiert (Länge ↑, dann lex.) */
    this.items = [];

    this._visibleStart = 0;
    this._visibleEnd   = 0;

    this._build();
  }

  // ─────────────────────────────────────────────────
  // DOM-Aufbau
  // ─────────────────────────────────────────────────

  _build() {
    /** Fixer Viewport (scrollbar) */
    this._viewport = document.createElement('div');
    this._viewport.className = 'vlist-viewport';

    /** Innerer Container: Gesamthöhe aller Items */
    this._inner = document.createElement('div');
    this._inner.className = 'vlist-inner';

    /** Oberer Spacer: versteckt nicht-gerenderte Items oben */
    this._topSpacer = document.createElement('div');
    this._topSpacer.className = 'vlist-spacer';

    /** Sichtbarer Render-Bereich */
    this._renderZone = document.createElement('ul');
    this._renderZone.className = 'name-list name-list--virtual';

    /** Unterer Spacer: versteckt nicht-gerenderte Items unten */
    this._bottomSpacer = document.createElement('div');
    this._bottomSpacer.className = 'vlist-spacer';

    this._inner.appendChild(this._topSpacer);
    this._inner.appendChild(this._renderZone);
    this._inner.appendChild(this._bottomSpacer);
    this._viewport.appendChild(this._inner);
    this.container.appendChild(this._viewport);

    this._onScroll = this._onScroll.bind(this);
    this._viewport.addEventListener('scroll', this._onScroll, { passive: true });
  }

  // ─────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────

  /**
   * Fügt einen einzelnen Namen sortiert ein.
   * Laufzeit: O(log n) für Binary Search + O(n) für Array-splice.
   * @param {string} name
   */
  addItem(name) {
    const idx = this._findInsertIndex(name);
    this.items.splice(idx, 0, name);
    this._updateInnerHeight();
    this._renderVisible();
  }

  /**
   * Ersetzt alle Items auf einmal (z. B. bei Migration von bestehender Liste).
   * Sortierung identisch mit sortNames() aus utils.js:
   *   1. Anfangsbuchstabe alphabetisch (de)
   *   2. Namenslänge aufsteigend
   *   3. Lexikografisch als Tiebreaker
   * @param {string[]} items
   */
  setItems(items) {
    this.items = [...items].sort((a, b) => {
      const la = (a.charAt(0) || '').toUpperCase();
      const lb = (b.charAt(0) || '').toUpperCase();
      if (la !== lb) return la.localeCompare(lb, 'de');
      if (a.length !== b.length) return a.length - b.length;
      return a.localeCompare(b, 'de');
    });
    this._updateInnerHeight();
    this._renderVisible();
  }

  /**
   * Fügt mehrere Namen auf einmal hinzu (effizienter als addItem × n).
   * @param {string[]} names
   */
  addItems(names) {
    for (const name of names) {
      const idx = this._findInsertIndex(name);
      this.items.splice(idx, 0, name);
    }
    this._updateInnerHeight();
    this._renderVisible();
  }

  /**
   * Erzwingt ein Re-Render (z. B. nach Favoriten-Änderung).
   */
  render() {
    this._visibleStart = -1; // Cache invalidieren
    this._renderVisible();
  }

  get count() { return this.items.length; }

  destroy() {
    this._viewport.removeEventListener('scroll', this._onScroll);
    this._viewport.remove();
  }

  // ─────────────────────────────────────────────────
  // Interne Logik
  // ─────────────────────────────────────────────────

  _findInsertIndex(name) {
    // Sortierlogik identisch mit sortNames() aus utils.js
    let lo = 0, hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const cur = this.items[mid];
      const la  = (name.charAt(0) || '').toUpperCase();
      const lb  = (cur.charAt(0)  || '').toUpperCase();
      const cmp = (la !== lb)
        ? la.localeCompare(lb, 'de')
        : (name.length - cur.length || name.localeCompare(cur, 'de'));
      if (cmp < 0) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  _updateInnerHeight() {
    this._inner.style.height = `${this.items.length * this.itemHeight}px`;
  }

  _renderVisible() {
    const scrollTop    = this._viewport.scrollTop;
    const clientHeight = this._viewport.clientHeight || 360;

    const start = Math.max(
      0,
      Math.floor(scrollTop / this.itemHeight) - this.renderBuffer
    );
    const end = Math.min(
      this.items.length,
      Math.ceil((scrollTop + clientHeight) / this.itemHeight) + this.renderBuffer
    );

    // Kein Re-Render wenn sich sichtbarer Bereich nicht geändert hat
    if (start === this._visibleStart && end === this._visibleEnd) return;

    this._visibleStart = start;
    this._visibleEnd   = end;

    // Spacer-Höhen → korrekte Scrollbar-Proportionen
    this._topSpacer.style.height    = `${start * this.itemHeight}px`;
    this._bottomSpacer.style.height = `${Math.max(0, this.items.length - end) * this.itemHeight}px`;

    // Items rendern (Fragment → kein Layout-Thrashing)
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      frag.appendChild(this._buildItem(this.items[i]));
    }

    this._renderZone.innerHTML = '';
    this._renderZone.appendChild(frag);

    // Einmalig tatsächliche Item-Höhe aus dem DOM messen
    if (!this._heightMeasured && this._renderZone.children.length > 0) {
      this._heightMeasured = true;
      requestAnimationFrame(() => this._measureItemHeight());
    }
  }

  _buildItem(name) {
    const li       = document.createElement('li');
    li.className   = 'name-item visible';
    li.textContent = name;

    if (this.favorites.has(name)) li.classList.add('is-favorite');

    li.addEventListener('click', () => {
      if (this.onItemClick) this.onItemClick(name, li);
    });

    if (this.favoritesEnabled && this.onItemFavorite) {
      li.title = 'Klick: kopieren · Rechtsklick / langer Druck: Favorit';
      li.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.onItemFavorite(name, li);
      });
      let _lpt = null;
      li.addEventListener('touchstart', () => {
        _lpt = setTimeout(() => this.onItemFavorite(name, li), 500);
      }, { passive: true });
      li.addEventListener('touchend',  () => clearTimeout(_lpt));
      li.addEventListener('touchmove', () => clearTimeout(_lpt));
    } else {
      li.title = `„${name}" kopieren`;
    }

    return li;
  }

  _onScroll() {
    if (this._rafPending) return;          // nur ein rAF pro Scroll-Burst
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this._renderVisible();
    });
  }

  /** Misst die tatsächliche Item-Höhe aus dem DOM (einmalig nach erstem Render). */
  _measureItemHeight() {
    const first = this._renderZone.querySelector('.name-item');
    if (!first) return;
    const measured = first.getBoundingClientRect().height;
    if (measured > 0 && Math.abs(measured - this.itemHeight) > 1) {
      this.itemHeight = measured;
      this._updateInnerHeight();      // Gesamthöhe neu berechnen
    }
  }
}
