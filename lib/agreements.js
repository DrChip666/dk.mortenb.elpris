'use strict';

/*
 * The market file (elpriser.json) has areas[] with one object per grid area and rows[] with one row per
 * agreement. The documented row fields are used; the area's price region is guessed from its own fields,
 * since the file computes the market for N1 A/S (DK1) and Radius Elnet A/S (DK2).
 */

function areaRegion(area) {
  const texts = Object.entries(area)
    .filter(([key, value]) => key !== 'rows' && (typeof value === 'string' || typeof value === 'number'))
    .map(([, value]) => String(value));
  const joined = texts.join(' ');
  if (/\bDK1\b/i.test(joined)) return 'DK1';
  if (/\bDK2\b/i.test(joined)) return 'DK2';
  if (/\bN1\b/i.test(joined)) return 'DK1';
  if (/radius/i.test(joined)) return 'DK2';
  return null;
}

function normalizeAgreements(json, fetchedAt) {
  if (!json || !Array.isArray(json.areas)) throw new Error('unexpected file shape');
  const rows = [];
  json.areas.forEach((area, index) => {
    const region = areaRegion(area) || `area${index}`;
    (area.rows || []).forEach((r) => {
      if (!r || !r.productSlug || typeof r.energyOreInclVat !== 'number') return;
      rows.push({
        region,
        supplier: r.supplier,
        supplierSlug: r.supplierSlug,
        product: r.product,
        productSlug: r.productSlug,
        type: r.type,
        spotBased: r.spotBased !== false,
        energyOre: r.energyOreInclVat,
        restricted: !!r.restricted,
      });
    });
  });
  return { fetchedAt, dataAsOf: json.dataAsOf || null, rows };
}

// One row per product, preferring the row from the device's price region.
function listForRegion(store, region) {
  const bySlug = new Map();
  store.rows.forEach((r) => {
    const current = bySlug.get(r.productSlug);
    if (!current || (current.region !== region && r.region === region)) bySlug.set(r.productSlug, r);
  });
  return [...bySlug.values()].sort(
    (a, b) => String(a.supplier).localeCompare(String(b.supplier), 'da') || String(a.product).localeCompare(String(b.product), 'da'),
  );
}

function findAgreement(store, slug, region) {
  if (!store || !slug) return null;
  return listForRegion(store, region).find((r) => r.productSlug === slug) || null;
}

module.exports = { normalizeAgreements, listForRegion, findAgreement, areaRegion };
