'use strict';

const Homey = require('homey');
const PriceService = require('../../lib/PriceService');
const { listForRegion } = require('../../lib/agreements');
const { validPlanArgs } = require('../../lib/calc');

class LocationDriver extends Homey.Driver {

  async onInit() {
    this.quarterStarted = this.homey.flow.getDeviceTriggerCard('quarter_started');
    this.tomorrowReady = this.homey.flow.getDeviceTriggerCard('tomorrow_ready');
    const cond = (id) => this.homey.flow.getConditionCard(id);

    cond('level_is').registerRunListener(async (args) => args.device.condLevel(args.level));
    cond('cheapest_hours').registerRunListener(async (args) => args.device.condCheapestHours(args.count));
    cond('percentile_ahead').registerRunListener(async (args) => {
      if (args.from > args.to) throw new Error(this.homey.__('errors.range'));
      return args.device.condPercentileAhead(args.from, args.to);
    });
    cond('price_below').registerRunListener(async (args) => args.device.condPriceBelow(args.price));
    cond('run_now').registerRunListener(async (args) => {
      const problem = validPlanArgs(args.hours, args.deadline);
      if (problem === 'hours') throw new Error(this.homey.__('errors.hours'));
      if (problem === 'deadline') throw new Error(this.homey.__('errors.deadline'));
      return args.device.condRunNow(args.hours, args.deadline, args.mode === 'flexible');
    });
  }

  async onPair(session) {
    const app = this.homey.app;
    const state = { sted: null, data: null };

    session.setHandler('check_place', async (input) => {
      const sted = PriceService.normalizeSted(input);
      if (!sted) throw new Error(this.homey.__('pair.location.invalid'));
      let data;
      try {
        data = await app.prices.lookupPlace(sted);
      } catch (err) {
        if (err.status === 400 || err.status === 404) throw new Error(this.homey.__('pair.location.unknown'));
        throw new Error(this.homey.__('pair.location.network', { error: err.message }));
      }
      state.sted = sted;
      state.data = data;
      return { sted, place: data.place };
    });

    session.setHandler('list_agreements', async () => {
      const store = await app.prices.getAgreements();
      if (!store) return { ok: false, rows: [] };
      const region = state.data ? state.data.place.region : null;
      return {
        ok: true,
        rows: listForRegion(store, region).map((r) => ({
          slug: r.productSlug,
          supplier: r.supplier,
          product: r.product,
          energyOre: r.energyOre,
          spotBased: r.spotBased,
          restricted: r.restricted,
        })),
      };
    });

    session.setHandler('create', async (choice) => {
      if (!state.sted) throw new Error(this.homey.__('pair.location.invalid'));
      const place = state.data.place;
      const settings = {
        sted: state.sted,
        surcharge_mode: choice.mode,
        agreement_slug: choice.mode === 'agreement' ? choice.slug : '',
        manual_surcharge: choice.mode === 'manual' ? Number(choice.manualOre) || 0 : 0,
      };
      const name = choice.mode === 'agreement' && choice.name
        ? `${this.homey.__('device.name')} ${state.sted.toUpperCase()}, ${choice.name}`
        : `${this.homey.__('device.name')} ${state.sted.toUpperCase()}`;
      return {
        name,
        data: { id: `${state.sted}-${Date.now().toString(36)}` },
        settings,
        store: { gridCompany: place.gridCompany, region: place.region },
      };
    });
  }

}

module.exports = LocationDriver;
