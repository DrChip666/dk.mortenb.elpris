'use strict';

module.exports = {
  async getPrices({ homey, query }) {
    const device = homey.app.findDevice(query.id || null);
    if (!device) return { ok: false, reason: 'noDevice' };
    return { ok: true, id: device.getData().id, ...device.getWidgetData() };
  },
};
