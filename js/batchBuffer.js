/**
 * batchBuffer.js — Adaptiver Batch-Buffer für DOM-Updates
 *
 * Sammelt eingehende Namen und flusht sie gebündelt — verhindert
 * tausende Einzel-DOM-Operationen bei schneller Worker-Generierung.
 *
 * Adaptive Batch Size:
 *   - Zu langsam (> 20 ms / Frame) → kleiner  (weniger DOM-Arbeit pro Frame)
 *   - Zu schnell (<  8 ms / Frame) → größer   (mehr Items, seltenere Frames)
 *   Ziel: gleichmäßige ~16 ms pro Frame (60 fps)
 *
 * Verwendung:
 *   const buf = new BatchBuffer({ onFlush: (grouped) => { ... } });
 *   buf.add('Aela', 'A');
 *   buf.add('Bardok', 'B');
 *   // → nach BATCH_SIZE Items oder manuellem flush() wird onFlush aufgerufen
 *   // grouped: Map<letter, string[]>
 */

export class BatchBuffer {
  /**
   * @param {object}   options
   * @param {number}   [options.batchSize=25]
   * @param {number}   [options.minBatchSize=5]
   * @param {number}   [options.maxBatchSize=200]
   * @param {Function} [options.onFlush]   — Callback: (grouped: Map<string, string[]>) => void
   */
  constructor(options = {}) {
    this.batchSize    = options.batchSize    ?? 25;
    this.minBatchSize = options.minBatchSize ?? 5;
    this.maxBatchSize = options.maxBatchSize ?? 200;
    this.onFlush      = options.onFlush      ?? (() => {});

    this._buffer        = [];
    this._lastFrameTime = performance.now();
    this._scheduled     = false;
  }

  /**
   * Fügt einen Namen zum Buffer hinzu.
   * Triggert automatisch einen Flush, wenn BATCH_SIZE erreicht ist.
   *
   * @param {string} name
   * @param {string} letter — Anfangsbuchstabe (für Gruppierung)
   */
  add(name, letter) {
    this._buffer.push({ name, letter });
    if (this._buffer.length >= this.batchSize && !this._scheduled) {
      this._scheduleFlush();
    }
  }

  /**
   * Flusht den aktuellen Buffer sofort (synchron).
   * Sendet gruppierte Namen an onFlush-Callback.
   */
  flush() {
    if (this._buffer.length === 0) return;

    const batch = this._buffer.splice(0, this.batchSize);

    // Namen nach Anfangsbuchstabe gruppieren
    const grouped = new Map();
    for (const { name, letter } of batch) {
      if (!grouped.has(letter)) grouped.set(letter, []);
      grouped.get(letter).push(name);
    }

    this.onFlush(grouped);

    // Restliche Items → weiteren Flush planen
    if (this._buffer.length > 0 && !this._scheduled) {
      this._scheduleFlush();
    }
  }

  /** Flusht alles synchron (z. B. am Ende einer Generierung). */
  flushAll() {
    while (this._buffer.length > 0) {
      this.flush();
    }
  }

  /** Setzt Buffer und Batch-Größe zurück. */
  reset() {
    this._buffer    = [];
    this._scheduled = false;
  }

  get pending() { return this._buffer.length; }

  // ─────────────────────────────────────────────────
  // Intern
  // ─────────────────────────────────────────────────

  _scheduleFlush() {
    this._scheduled = true;
    requestAnimationFrame(() => {
      const now       = performance.now();
      const frameTime = now - this._lastFrameTime;
      this._lastFrameTime = now;

      // Adaptive Batch Size
      if (frameTime > 20) {
        // Zu langsam → kleinere Batches
        this.batchSize = Math.max(
          this.minBatchSize,
          Math.round(this.batchSize * 0.8)
        );
      } else if (frameTime < 8) {
        // Zu schnell → größere Batches
        this.batchSize = Math.min(
          this.maxBatchSize,
          Math.round(this.batchSize * 1.2)
        );
      }

      this.flush();
      this._scheduled = false;
    });
  }
}
