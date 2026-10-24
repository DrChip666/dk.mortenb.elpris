'use strict';

const { normalizeTimepris, findQuarter } = require('./calc');
const { normalizeAgreements } = require('./agreements');

const BASE = 'https://elpriser.dk/data';
const USER_AGENT = 'homey-elpris-private/1.0';
const FIVE_MIN = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const AGREEMENTS_MAX_AGE = 24 * ONE_HOUR;

/*
 * One cached copy per place (postcode or grid area code), shared by all devices for that place.
 * Usage rules from Elpriser.dk: timepris.json at most every five minutes per address, the other files
 * at most once an hour. The service never asks more often than that, and normally much less:
 * today's prices are fixed, so it only fetches again when it has no price for the current quarter,
 * or when tomorrow's prices are missing after noon (they usually arrive between 13 and 15).
 */
class PriceService {

  constructor(homey) {
    this.homey = homey;
    this.places = new Map(); // sted -> { data, lastAttempt, inflight }
    this.agreements = null; // { fetchedAt, rows }
    this.agreementsAttempt = 0;
    this.agreementsInflight = null;
    this._loadPersisted();
  }

  _loadPersisted() {
    try {
      const saved = this.homey.settings.get('timepris') || {};
      Object.entries(saved).forEach(([sted, data]) => this.places.set(sted, { data, lastAttempt: 0 }));
      this.agreements = this.homey.settings.get('agreements') || null;
    } catch (err) {
      this.homey.error('Could not read cached prices', err);
    }
  }

  _persist() {
    const out = {};
    this.places.forEach((entry, sted) => {
      if (entry.data) out[sted] = entry.data;
    });
    this.homey.settings.set('timepris', out);
  }

  static normalizeSted(input) {
    const s = String(input || '').trim().toLowerCase().replace(/\s+/g, '');
    if (/^\d{4}$/.test(s) || /^a\d{1,4}$/.test(s) || s === 'dk1' || s === 'dk2') return s;
    return null;
  }

  async _fetchJson(url) {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body && body.error ? `: ${body.error}` : '';
      } catch (err) {
        // no JSON body
      }
      const error = new Error(`HTTP ${res.status}${detail}`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }

  // Used during pairing and when the place is changed in settings: fetches once and caches the result.
  async lookupPlace(sted) {
    const entry = await this._fetchPlace(sted, true);
    return entry.data;
  }

  async _fetchPlace(sted, force) {
    let entry = this.places.get(sted);
    if (!entry) {
      entry = { data: null, lastAttempt: 0 };
      this.places.set(sted, entry);
    }
    if (entry.inflight) return entry.inflight.then(() => entry);
    const now = Date.now();
    if (now - entry.lastAttempt < FIVE_MIN && !(force && !entry.data)) return entry;
    entry.lastAttempt = now;
    entry.inflight = (async () => {
      try {
        const json = await this._fetchJson(`${BASE}/timepris.json?sted=${encodeURIComponent(sted)}`);
        entry.data = normalizeTimepris(json, now);
        this._persist();
      } finally {
        entry.inflight = null;
      }
    })();
    await entry.inflight;
    return entry;
  }

  // Prices for a place, fetching only when the cached copy is not good enough.
  async getPrices(sted) {
    const entry = this.places.get(sted);
    const data = entry && entry.data;
    const found = data ? findQuarter(data.days, Date.now()) : null;
    const needsTomorrow = found && !found.hasLaterDay && found.quarter.hour >= 12;
    if (found && !needsTomorrow) return data;
    try {
      const fresh = await this._fetchPlace(sted, false);
      return fresh.data;
    } catch (err) {
      this.homey.error(`Could not fetch prices for ${sted}: ${err.message}`);
      return data || null;
    }
  }

  async getAgreements() {
    const now = Date.now();
    const fresh = this.agreements && now - this.agreements.fetchedAt < AGREEMENTS_MAX_AGE;
    if (fresh) return this.agreements;
    if (this.agreementsInflight) return this.agreementsInflight;
    if (now - this.agreementsAttempt < ONE_HOUR) return this.agreements;
    this.agreementsAttempt = now;
    this.agreementsInflight = (async () => {
      try {
        const json = await this._fetchJson(`${BASE}/elpriser.json`);
        this.agreements = normalizeAgreements(json, now);
        this.homey.settings.set('agreements', this.agreements);
      } catch (err) {
        this.homey.error(`Could not fetch agreements: ${err.message}`);
      } finally {
        this.agreementsInflight = null;
      }
      return this.agreements;
    })();
    return this.agreementsInflight;
  }

  // Drop cached places no device uses any more.
  prune(activeSteds) {
    let changed = false;
    [...this.places.keys()].forEach((sted) => {
      if (!activeSteds.has(sted)) {
        this.places.delete(sted);
        changed = true;
      }
    });
    if (changed) this._persist();
  }

}

module.exports = PriceService;
