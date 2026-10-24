'use strict';

const Homey = require('homey');
const PriceService = require('../../lib/PriceService');
const { findAgreement } = require('../../lib/agreements');
const calc = require('../../lib/calc');

// [capability, setting that switches it on]; no setting = always shown. Order = order on the device.
const CAPABILITIES = [
  ['measure_elpris_now'],
  ['elpris_level'],
  ['measure_elpris_next', 'show_next'],
  ['measure_elpris_hour', 'show_hour'],
  ['measure_elpris_next_hour', 'show_next_hour'],
  ['measure_elpris_day_avg', 'show_day'],
  ['measure_elpris_day_min', 'show_day'],
  ['measure_elpris_day_max', 'show_day'],
  ['measure_elpris_vs_avg', 'show_vs_avg'],
  ['measure_elpris_percentile', 'show_percentile'],
  ['measure_elpris_percentile_ahead', 'show_percentile_ahead'],
  ['measure_elpris_minutes_cheap', 'show_minutes_cheap'],
  ['elpris_tomorrow', 'show_tomorrow'],
  ['measure_elpris_tomorrow_avg', 'show_tomorrow'],
  ['elpris_cheapest_hour', 'show_hours_text'],
  ['elpris_dearest_hour', 'show_hours_text'],
];
// Version 1.0.0 capabilities, replaced by measure_ ones so they can be status indicators.
const OLD_CAPABILITIES = ['elpris_price', 'elpris_percentile'];

class LocationDevice extends Homey.Device {

  async onInit() {
    this.surcharge = null; // { kind, ore, text }
    this.days = null; // effective days (price incl. surcharge)
    this.data = null; // raw normalised file
    decimalComma = this.homey.i18n.getLanguage() === 'da';
    await this.syncCapabilities().catch(this.error);
    await this.refresh().catch(this.error);
  }

  // Which capabilities the device shows, following the "Values shown" settings. Unset means on.
  _wanted() {
    const on = (key) => this.getSetting(key) !== false;
    return CAPABILITIES.filter(([, key]) => !key || on(key)).map(([id]) => id);
  }

  async syncCapabilities() {
    const wanted = this._wanted();
    // Upgrading from 1.0.0: start over once, so the values come in the intended order.
    if (OLD_CAPABILITIES.some((id) => this.hasCapability(id))) {
      for (const id of [...OLD_CAPABILITIES, 'elpris_level', 'elpris_tomorrow']) {
        if (this.hasCapability(id)) await this.removeCapability(id);
      }
    }
    for (const id of [...OLD_CAPABILITIES, ...CAPABILITIES.map(([c]) => c)]) {
      if (!wanted.includes(id) && this.hasCapability(id)) await this.removeCapability(id);
    }
    for (const id of wanted) {
      if (!this.hasCapability(id)) await this.addCapability(id);
    }
  }

  getSted() {
    return this.getSetting('sted');
  }

  getPlaceText() {
    const company = this.getStoreValue('gridCompany');
    return company ? `${this.getSted()}, ${company}` : String(this.getSted());
  }

  // ── Surcharge ────────────────────────────────────────────────────────────────

  async _resolveSurcharge() {
    const mode = this.getSetting('surcharge_mode');
    const manual = Number(this.getSetting('manual_surcharge')) || 0;
    if (mode === 'none') {
      return { kind: 'add', ore: 0, text: this.homey.__('surcharge.none') };
    }
    if (mode === 'manual') {
      return { kind: 'add', ore: manual, text: this.homey.__('surcharge.manual', { ore: fmt(manual) }) };
    }
    const store = await this.homey.app.prices.getAgreements();
    const row = findAgreement(store, this.getSetting('agreement_slug'), this.getStoreValue('region'));
    if (!row) {
      return {
        kind: 'add',
        ore: manual,
        text: this.homey.__('surcharge.missing', { ore: fmt(manual) }),
        warning: this.homey.__('surcharge.missingWarning'),
      };
    }
    const kind = row.spotBased ? 'add' : 'fixed';
    const key = row.spotBased ? 'surcharge.agreement' : 'surcharge.fixed';
    return {
      kind,
      ore: row.energyOre,
      text: this.homey.__(key, { supplier: row.supplier, product: row.product, ore: fmt(row.energyOre) }),
      supplier: row.supplier,
      product: row.product,
    };
  }

  // ── Refresh ──────────────────────────────────────────────────────────────────

  async refresh() {
    const sted = this.getSted();
    const data = await this.homey.app.prices.getPrices(sted);
    this.surcharge = await this._resolveSurcharge();
    this.data = data;
    this.days = data ? calc.effectiveData(data, this.surcharge) : null;

    const now = Date.now();
    const found = this.days ? calc.findQuarter(this.days, now) : null;

    await this._updateLabels(data);

    if (!found) {
      await this.setWarning(this.homey.__('warnings.noPrice')).catch(this.error);
      this.homey.app.notifyWidgets(this.getData().id);
      return;
    }
    if (this.surcharge.warning) await this.setWarning(this.surcharge.warning).catch(this.error);
    else await this.unsetWarning().catch(this.error);

    const st = calc.stats(this.days, now);
    this.stats = st;
    const kr = (ore) => (ore === null || ore === undefined ? null : Math.round(ore * 100) / 10000);
    const hoursText = (h) => this.homey.__('hoursText', { hours: h.label, price: fmt(h.price / 100) });
    await Promise.all([
      this._set('measure_elpris_now', kr(st.now)),
      this._set('elpris_level', st.level),
      this._set('measure_elpris_next', kr(st.next)),
      this._set('measure_elpris_hour', kr(st.hourAvg)),
      this._set('measure_elpris_next_hour', kr(st.nextHourAvg)),
      this._set('measure_elpris_day_avg', kr(st.dayAvg)),
      this._set('measure_elpris_day_min', kr(st.dayMin)),
      this._set('measure_elpris_day_max', kr(st.dayMax)),
      this._set('measure_elpris_vs_avg', st.vsAvgPct),
      this._set('measure_elpris_percentile', st.percentile),
      this._set('measure_elpris_percentile_ahead', st.percentileAhead),
      this._set('measure_elpris_minutes_cheap', st.minutesToCheap),
      this._set('elpris_tomorrow', st.hasLaterDay),
      this._set('measure_elpris_tomorrow_avg', kr(st.tomorrowAvg)),
      this._set('elpris_cheapest_hour', hoursText(st.cheapestHour)),
      this._set('elpris_dearest_hour', hoursText(st.dearestHour)),
    ]);
    await this._fireTriggers(st, found).catch(this.error);
    this.homey.app.notifyWidgets(this.getData().id);
  }

  async _fireTriggers(st, found) {
    // A new quarter: only when the change happened within the first five minutes of it, so a restart
    // in the middle of a quarter does not fire it again.
    const lastQuarter = this.getStoreValue('lastQuarter');
    if (lastQuarter !== st.from) {
      await this.setStoreValue('lastQuarter', st.from);
      if (lastQuarter !== undefined && lastQuarter !== null && Date.now() - st.from < 5 * 60 * 1000) {
        await this.driver.quarterStarted.trigger(this, {
          price: Math.round(st.now * 100) / 10000,
          level: this.homey.__(`level.${st.level}`),
          percentile: st.percentile,
          quarter: st.label,
        });
      }
    }
    // Tomorrow's prices: once per new day. The first time after pairing only records the day.
    const later = st.hasLaterDay ? this.days[found.dayIndex + 1] : null;
    const lastTomorrow = this.getStoreValue('lastTomorrow');
    if (later && lastTomorrow !== later.day) {
      await this.setStoreValue('lastTomorrow', later.day);
      if (lastTomorrow !== undefined && lastTomorrow !== null) {
        const x = calc.dayExtremes(later);
        await this.driver.tomorrowReady.trigger(this, {
          average: Math.round(x.avg * 100) / 10000,
          cheapest_hour: x.cheapest.label,
          cheapest_price: Math.round(x.cheapest.avg * 100) / 10000,
          dearest_hour: x.dearest.label,
          dearest_price: Math.round(x.dearest.avg * 100) / 10000,
        });
      }
    } else if (!later && lastTomorrow === undefined) {
      await this.setStoreValue('lastTomorrow', '');
    }
  }

  async _set(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    await this.setCapabilityValue(capability, value).catch(this.error);
  }

  async _updateLabels(data) {
    const placeInfo = data
      ? this.homey.__('settings.placeInfo', {
        company: data.place.gridCompany || '–',
        area: data.place.gridArea || '–',
        region: data.place.regionLabel || data.place.region || '–',
      })
      : this.homey.__('settings.placeUnknown');
    const updates = {};
    if (this.getSetting('place_info') !== placeInfo) updates.place_info = placeInfo;
    if (this.getSetting('agreement_info') !== this.surcharge.text) updates.agreement_info = this.surcharge.text;
    if (data && data.place.gridCompany && this.getStoreValue('gridCompany') !== data.place.gridCompany) {
      await this.setStoreValue('gridCompany', data.place.gridCompany).catch(this.error);
      await this.setStoreValue('region', data.place.region).catch(this.error);
    }
    if (Object.keys(updates).length) await this.setSettings(updates).catch(this.error);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('sted')) {
      const sted = PriceService.normalizeSted(newSettings.sted);
      if (!sted) throw new Error(this.homey.__('pair.location.invalid'));
      if (sted !== newSettings.sted) throw new Error(this.homey.__('settings.stedFormat', { sted }));
      try {
        const data = await this.homey.app.prices.lookupPlace(sted);
        await this.setStoreValue('gridCompany', data.place.gridCompany);
        await this.setStoreValue('region', data.place.region);
      } catch (err) {
        throw new Error(this.homey.__('pair.location.unknown'));
      }
    }
    // Settings cannot be changed from inside onSettings, so refresh just after it returns.
    const showChanged = changedKeys.some((k) => k.startsWith('show_'));
    this.homey.setTimeout(async () => {
      if (showChanged) await this.syncCapabilities().catch(this.error);
      await this.refresh().catch(this.error);
    }, 500);
  }

  // ── Flow conditions ──────────────────────────────────────────────────────────

  _current() {
    const found = this.days ? calc.findQuarter(this.days, Date.now()) : null;
    if (!found) throw new Error(this.homey.__('warnings.noPrice'));
    return found;
  }

  async condLevel(level) {
    return this._current().quarter.level === level;
  }

  async condCheapestHours(count) {
    return calc.inCheapestHours(this._current(), count);
  }

  async condPercentileAhead(from, to) {
    this._current();
    const p = calc.percentileAhead(this.days, Date.now());
    if (p === null) throw new Error(this.homey.__('warnings.tooFewAhead'));
    return from <= p && p <= to;
  }

  async condPriceBelow(priceKr) {
    return this._current().quarter.price / 100 < priceKr;
  }

  async condRunNow(hours, deadline, flexible) {
    this._current();
    // Tomorrow's prices may be out by now; refresh first if the cached copy lacks them.
    if (this.data && calc.findQuarter(this.days, Date.now()).hasLaterDay === false) {
      await this.refresh().catch(this.error);
    }
    const result = calc.plan(this.days, Date.now(), hours, deadline);
    if (!result) throw new Error(this.homey.__('warnings.noPrice'));
    if (!result.complete) return false; // wait for the next prices
    if (!result.fits) return true; // no time to wait: start now
    return flexible ? result.runNowFlexible : result.runNowBlock;
  }

  // ── Widget data ──────────────────────────────────────────────────────────────

  getWidgetData() {
    const surcharge = this.surcharge || { kind: 'add', ore: 0, text: '' };
    return {
      name: this.getName(),
      place: this.getPlaceText(),
      surchargeText: surcharge.text,
      surchargeKind: surcharge.kind,
      surchargeOre: surcharge.ore,
      fetchedAt: this.data ? this.data.fetchedAt : null,
      stats: this.stats || null,
      days: (this.days || []).map((d) => ({
        day: d.day,
        quarters: d.quarters.map((q) => ({
          from: q.from,
          to: q.to,
          label: q.label,
          price: q.price,
          spot: q.spot,
          grid: q.grid,
          charges: q.charges,
          level: q.level,
          hour: q.hour,
        })),
      })),
    };
  }

}

// Two decimals; Danish uses a decimal comma. Set from the Homey language in onInit.
let decimalComma = true;
function fmt(ore) {
  const text = (Math.round(ore * 100) / 100).toFixed(2);
  return decimalComma ? text.replace('.', ',') : text;
}

module.exports = LocationDevice;
