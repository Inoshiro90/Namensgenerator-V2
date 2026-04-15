/**
 * eventBus.js — Minimaler Event-Bus für modulübergreifende Kommunikation
 *
 * Entkoppelt Module voneinander: Statt direkter Funktionsaufrufe
 * emittiert ein Modul Events, andere hören zu.
 *
 * Verwendung:
 *   import { eventBus } from './eventBus.js';
 *   eventBus.on('nameGenerated', ({ name }) => console.log(name));
 *   eventBus.emit('nameGenerated', { name: 'Aela' });
 *
 * Plugin-System:
 *   eventBus.on('nameGenerated', myCustomPlugin);
 *   eventBus.on('generationDone', ({ count }) => updateStats(count));
 */

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Registriert einen Event-Handler.
   * @param {string}   event
   * @param {Function} handler
   * @returns {Function} — Cleanup-Funktion (zum Abmelden)
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Entfernt einen Event-Handler.
   * @param {string}   event
   * @param {Function} handler
   */
  off(event, handler) {
    this._listeners.get(event)?.delete(handler);
  }

  /**
   * Sendet ein Event an alle registrierten Handler.
   * Fehler in einem Handler stoppt die anderen nicht.
   * @param {string} event
   * @param {*}      data
   */
  emit(event, data) {
    for (const handler of this._listeners.get(event) ?? []) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[EventBus] Fehler in Handler für "${event}":`, err);
      }
    }
  }

  /**
   * Registriert einen Handler, der nur einmal aufgerufen wird.
   * @param {string}   event
   * @param {Function} handler
   */
  once(event, handler) {
    const off = this.on(event, (data) => {
      handler(data);
      off();
    });
  }

  /**
   * Entfernt alle Handler für ein bestimmtes Event.
   * @param {string} event
   */
  clear(event) {
    this._listeners.delete(event);
  }
}

/** Globale Singleton-Instanz — direkt importierbar */
export const eventBus = new EventBus();
