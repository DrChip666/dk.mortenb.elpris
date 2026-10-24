'use strict';

const Homey = require('homey');
const PriceService = require('./lib/PriceService');
const { msToNextQuarter } = require('./lib/calc');

class ElprisApp extends Homey.App {

  async onInit() {
    this.prices = new PriceService(this.homey);
    this._registerWidget();
    // Let the devices initialise before the first round.
    this.homey.setTimeout(() => this._tick(), 3000);
    this.log('Elpris app started');
  }

  _devices() {
    try {
      return this.homey.drivers.getDriver('location').getDevices();
    } catch (err) {
      return [];
    }
  }

  // Runs just after every quarter boundary and updates all devices.
  async _tick() {
    const devices = this._devices();
    for (const device of devices) {
      await device.refresh().catch(this.error);
    }
    this.prices.prune(new Set(devices.map((d) => d.getSted()).filter(Boolean)));
    this.homey.setTimeout(() => this._tick(), msToNextQuarter(Date.now()) + 2000);
  }

  findDevice(id) {
    const devices = this._devices();
    if (!id) return devices[0] || null;
    return devices.find((d) => d.getData().id === id) || null;
  }

  // Called by devices after they have new values, so open widgets redraw.
  notifyWidgets(deviceId) {
    this.homey.api.realtime('prices-updated', { id: deviceId });
  }

  _registerWidget() {
    const widget = this.homey.dashboards.getWidget('prices');
    widget.registerSettingAutocompleteListener('location', async (query) => {
      const q = String(query || '').toLowerCase();
      return this._devices()
        .map((d) => ({
          name: d.getName(),
          description: d.getPlaceText(),
          id: d.getData().id,
        }))
        .filter((item) => item.name.toLowerCase().includes(q));
    });
  }

}

module.exports = ElprisApp;
