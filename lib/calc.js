'use strict';

/*
 * Pure helpers for the Elpriser.dk timepris data. No Homey imports, so they can be tested with plain node.
 *
 * All times are taken from the file's own start/end strings (Danish time with offset). The code never
 * turns a clock time into hours and minutes itself, so the nights where the clock changes work too.
 */

const QUARTER_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Normalising the timepris.json file ─────────────────────────────────────────

function normalizeTimepris(json, fetchedAt) {
  if (!json || !json.today || !Array.isArray(json.today.quarters)) {
    throw new Error('unexpected file shape');
  }
  const days = [json.today, json.tomorrow].filter(Boolean).map((day) => ({
    day: day.day,
    quarters: day.quarters.map((q) => ({
      start: q.start,
      end: q.end,
      from: Date.parse(q.start),
      to: Date.parse(q.end),
      hour: q.hour,
      label: `${q.start.slice(11, 16)}–${q.end.slice(11, 16)}`,
      clock: q.start.slice(11, 16),
      ore: q.oreInclVat,
      spot: q.spotOreInclVat,
      grid: q.gridOreInclVat,
      charges: q.chargesOreInclVat,
      level: q.level,
      percentile: q.percentile,
      rank: q.rank,
    })),
    hours: (day.hours || []).map((h) => ({ hour: h.hour, rank: h.rank })),
  }));
  const place = json.place || {};
  return {
    fetchedAt,
    place: {
      gridArea: place.gridArea || null,
      gridCompany: place.gridCompany || null,
      region: place.region || null,
      regionLabel: place.regionLabel || null,
      ambiguous: !!place.ambiguous,
      candidates: Array.isArray(place.candidates) ? place.candidates : [],
    },
    days,
  };
}

// ── Surcharge (the supplier's own price per kWh) ──────────────────────────────

/*
 * surcharge: { kind: 'add' | 'fixed', ore: number }
 *   add   – a variable (spot-based) agreement: the supplier's surcharge is added to the market price.
 *   fixed – a fixed-price agreement: the energy price replaces the spot price.
 */
function effectiveOre(q, surcharge) {
  if (!surcharge || !surcharge.ore) return q.ore;
  if (surcharge.kind === 'fixed') return round2(q.ore - q.spot + surcharge.ore);
  return round2(q.ore + surcharge.ore);
}

/*
 * The day's quarters with the price the user pays. With an added surcharge the order of the
 * quarters does not change, so the file's own level, percentile and rank are kept. A fixed
 * agreement removes the spot price, which changes the order, so those are recalculated here
 * with the file's documented rules.
 */
function effectiveDay(day, surcharge) {
  const quarters = day.quarters.map((q) => ({ ...q, price: effectiveOre(q, surcharge) }));
  let hours = day.hours;
  if (surcharge && surcharge.kind === 'fixed' && surcharge.ore) {
    const prices = quarters.map((q) => q.price);
    quarters.forEach((q) => {
      q.percentile = midrankPercentile(prices, q.price);
      q.rank = rankOf(prices, q.price);
      q.level = levelFromPercentile(q.percentile);
    });
    // Hours are the average of their quarters; the doubled hour 02 on the autumn night is one hour, as in the file.
    const byHour = new Map();
    quarters.forEach((q) => {
      if (!byHour.has(q.hour)) byHour.set(q.hour, []);
      byHour.get(q.hour).push(q.price);
    });
    const averages = [...byHour.entries()].map(([hour, list]) => ({
      hour,
      avg: list.reduce((a, b) => a + b, 0) / list.length,
    }));
    const avgList = averages.map((h) => h.avg);
    hours = averages.map((h) => ({ hour: h.hour, rank: rankOf(avgList, h.avg) }));
  }
  return { day: day.day, quarters, hours };
}

function effectiveData(data, surcharge) {
  return data.days.map((d) => effectiveDay(d, surcharge));
}

// ── Finding the current quarter ────────────────────────────────────────────────

function findQuarter(days, t) {
  for (let d = 0; d < days.length; d++) {
    const list = days[d].quarters;
    for (let i = 0; i < list.length; i++) {
      if (list[i].from <= t && t < list[i].to) {
        return { dayIndex: d, index: i, quarter: list[i], day: days[d], hasLaterDay: d < days.length - 1 };
      }
    }
  }
  return null;
}

function allQuarters(days) {
  return days.reduce((list, d) => list.concat(d.quarters), []);
}

// ── Rankings ───────────────────────────────────────────────────────────────────

// 100 · (lower + (equal − 1) / 2) / (n − 1), whole number, as the file defines percentile.
function midrankPercentile(prices, price) {
  const n = prices.length;
  if (n < 2) return 0;
  const lower = prices.filter((p) => p < price).length;
  const equal = prices.filter((p) => p === price).length;
  return Math.round((100 * (lower + (equal - 1) / 2)) / (n - 1));
}

// 1 = cheapest; equal prices share the lowest rank.
function rankOf(prices, price) {
  return 1 + prices.filter((p) => p < price).length;
}

function levelFromPercentile(p) {
  if (p <= 33) return 'cheap';
  if (p >= 67) return 'expensive';
  return 'mid';
}

// Percentile among the known quarters from now and up to 24 hours ahead (as now.ahead in the file).
// Null when fewer than four hours ahead are known.
function percentileAhead(days, t) {
  const list = allQuarters(days);
  const i = list.findIndex((q) => q.from <= t && t < q.to);
  if (i < 0) return null;
  const windowEnd = list[i].from + DAY_MS;
  const window = list.slice(i).filter((q) => q.from < windowEnd);
  if (window.length < 16) return null;
  return midrankPercentile(window.map((q) => q.price), list[i].price);
}

// True when the current quarter's hour is among the day's N cheapest hours.
function inCheapestHours(found, n) {
  const hour = found.day.hours.find((h) => h.hour === found.quarter.hour);
  return !!hour && hour.rank <= n;
}

// ── Run now or wait ────────────────────────────────────────────────────────────

/*
 * hours: 0.25–24 in whole quarters. deadline: 'HH:MM' on a quarter (the next time the clock shows it).
 * Returns { complete, fits, block, flexible, runNowBlock, runNowFlexible }.
 *   fits false     → the use cannot finish before the deadline if it waits, so the answer is to start now.
 *   complete false → the deadline lies after the known prices; wait for the next prices.
 * Equal prices: the earliest is chosen.
 */
function plan(days, t, hours, deadline) {
  const n = Math.round(hours * 4);
  const list = allQuarters(days);
  const i = list.findIndex((q) => q.from <= t && t < q.to);
  if (i < 0) return null;

  let end = -1;
  for (let j = i + 1; j < list.length; j++) {
    if (list[j].clock === deadline && list[j].from > t) {
      end = j;
      break;
    }
  }
  // The deadline can also be the end of the last known quarter (for example 00:00 tonight).
  if (end < 0 && list.length && list[list.length - 1].end.slice(11, 16) === deadline) end = list.length;

  if (end < 0) {
    // The deadline is not among the known quarters yet.
    const known = list.length - i;
    return { complete: false, fits: true, known };
  }

  const window = list.slice(i, end);
  if (window.length < n) {
    return { complete: true, fits: false, runNowBlock: true, runNowFlexible: true };
  }

  // Cheapest contiguous block of n quarters.
  let bestStart = 0;
  let bestSum = Infinity;
  let sum = 0;
  for (let k = 0; k < window.length; k++) {
    sum += window[k].price;
    if (k >= n) sum -= window[k - n].price;
    if (k >= n - 1) {
      const start = k - n + 1;
      if (sum < bestSum - 1e-9) {
        bestSum = sum;
        bestStart = start;
      }
    }
  }
  const block = {
    start: window[bestStart].from,
    end: window[bestStart + n - 1].to,
    avgOre: round2(bestSum / n),
  };

  // The n cheapest quarters (may be interrupted).
  const sorted = window
    .map((q, k) => ({ q, k }))
    .sort((a, b) => a.q.price - b.q.price || a.k - b.k)
    .slice(0, n);
  const flexibleStarts = sorted.map((x) => x.q.from).sort((a, b) => a - b);

  const current = window[0];
  return {
    complete: true,
    fits: true,
    block,
    flexibleStarts,
    runNowBlock: block.start <= t && t < block.end,
    runNowFlexible: flexibleStarts.includes(current.from),
  };
}

function validPlanArgs(hours, deadline) {
  const n = hours * 4;
  if (!(hours >= 0.25 && hours <= 24) || Math.abs(n - Math.round(n)) > 1e-9) return 'hours';
  if (!/^([01]\d|2[0-3]):(00|15|30|45)$/.test(String(deadline || ''))) return 'deadline';
  return null;
}

// ── Misc ───────────────────────────────────────────────────────────────────────

function round2(x) {
  return Math.round(x * 100) / 100;
}

// Milliseconds until the next quarter boundary. Danish offsets are whole hours, so UTC quarters line up.
function msToNextQuarter(t) {
  return QUARTER_MS - (t % QUARTER_MS);
}

module.exports = {
  QUARTER_MS,
  normalizeTimepris,
  effectiveOre,
  effectiveDay,
  effectiveData,
  findQuarter,
  allQuarters,
  midrankPercentile,
  rankOf,
  levelFromPercentile,
  percentileAhead,
  inCheapestHours,
  plan,
  validPlanArgs,
  round2,
  msToNextQuarter,
};

// ── Values for the device (all prices in øre incl. surcharge) ─────────────────

function avg(list) {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

function hourLabel(group) {
  return `${group[0].start.slice(11, 13)}–${group[group.length - 1].end.slice(11, 13)}`;
}

// The day's hours as groups of quarters; the doubled hour 02 on the autumn night is one hour, as in the file.
function hourGroups(day) {
  const map = new Map();
  day.quarters.forEach((q) => {
    if (!map.has(q.hour)) map.set(q.hour, []);
    map.get(q.hour).push(q);
  });
  return [...map.values()].map((g) => ({ quarters: g, avg: avg(g.map((q) => q.price)), label: hourLabel(g) }));
}

function stats(days, t) {
  const found = findQuarter(days, t);
  if (!found) return null;
  const list = allQuarters(days);
  const gi = list.findIndex((q) => q.from === found.quarter.from);
  const q = found.quarter;
  const dayPrices = found.day.quarters.map((x) => x.price);

  // Next hour: the first quarter after the current hour, and the quarters of that hour.
  let j = gi + 1;
  while (j < list.length && list[j].hour === q.hour && list[j].from - q.from < 2 * 60 * 60 * 1000) j++;
  const nextHour = [];
  for (let k = j; k < list.length && list[k].hour === (list[j] && list[j].hour) && nextHour.length < 8; k++) nextHour.push(list[k]);

  let minutesToCheap = null;
  for (let k = gi; k < list.length; k++) {
    if (list[k].level === 'cheap') {
      minutesToCheap = Math.max(0, Math.ceil((list[k].from - t) / 60000));
      break;
    }
  }

  const groups = hourGroups(found.day);
  const cheapest = groups.reduce((a, b) => (b.avg < a.avg ? b : a));
  const dearest = groups.reduce((a, b) => (b.avg > a.avg ? b : a));
  const dayAvg = avg(dayPrices);
  const tomorrow = days[found.dayIndex + 1];

  return {
    now: q.price,
    level: q.level,
    label: q.label,
    from: q.from,
    next: list[gi + 1] ? list[gi + 1].price : null,
    hourAvg: avg(found.day.quarters.filter((x) => x.hour === q.hour).map((x) => x.price)),
    nextHourAvg: nextHour.length ? avg(nextHour.map((x) => x.price)) : null,
    dayAvg,
    dayMin: Math.min(...dayPrices),
    dayMax: Math.max(...dayPrices),
    vsAvgPct: dayAvg ? Math.round(((q.price - dayAvg) / Math.abs(dayAvg)) * 100) : null,
    percentile: q.percentile,
    percentileAhead: percentileAhead(days, t),
    minutesToCheap,
    tomorrowAvg: tomorrow ? avg(tomorrow.quarters.map((x) => x.price)) : null,
    cheapestHour: { label: cheapest.label, price: cheapest.avg },
    dearestHour: { label: dearest.label, price: dearest.avg },
    hasLaterDay: found.hasLaterDay,
    dayIndex: found.dayIndex,
  };
}

// Cheapest and dearest hour of a whole day (for the "tomorrow is ready" trigger).
function dayExtremes(day) {
  const groups = hourGroups(day);
  const cheapest = groups.reduce((a, b) => (b.avg < a.avg ? b : a));
  const dearest = groups.reduce((a, b) => (b.avg > a.avg ? b : a));
  return { avg: avg(day.quarters.map((q) => q.price)), cheapest, dearest };
}

module.exports.stats = stats;
module.exports.dayExtremes = dayExtremes;
module.exports.hourGroups = hourGroups;
