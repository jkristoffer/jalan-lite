const test = require('node:test');
const assert = require('node:assert/strict');
const { alternativeOptions, comparisonMetrics, preferredRoute, itinerarySignature } = require('./route-alternatives.js');

function itinerary(id, duration, walkDuration, transfers = 0) {
  return { duration, walkDuration, transfers, legs: [{ mode: 'BUS', routeName: id, fromId: 'from', toId: 'to' }] };
}

test('selects fastest, genuinely fewer transfers, then less walking distinct itineraries', () => {
  const slow = itinerary('slow', 1800, 100);
  const fastest = itinerary('fastest', 900, 500, 2);
  const second = itinerary('second', 1200, 300, 0);
  const leastWalking = itinerary('walking', 2100, 50);
  const options = alternativeOptions({ alternatives: [slow, fastest, second, leastWalking] });

  assert.deepEqual(options.map((option) => [option.label, option.itinerary]), [
    ['Fastest', fastest],
    ['Fewer transfers', second],
    ['Less walking', leastWalking],
  ]);
});

test('equal tradeoffs do not earn a fewer transfers or less walking label', () => {
  const fastest = itinerary('fastest', 900, 100);
  const sameTrade = itinerary('same-trade', 1200, 100);
  const slowerWorse = itinerary('slower', 1500, 200, 1);
  assert.deepEqual(alternativeOptions({ alternatives: [fastest, sameTrade, slowerWorse] }).map((option) => option.label), ['Fastest']);
});

test('when one alternative improves both tradeoffs it appears only once', () => {
  const fastest = itinerary('fastest', 900, 500, 2);
  const simpler = itinerary('simpler', 1200, 100, 0);
  const options = alternativeOptions({ alternatives: [fastest, simpler] });
  assert.deepEqual(options.map((option) => option.itinerary), [fastest, simpler]);
  assert.equal(options[1].metrics.walking, 100);
});

test('comparison metrics include arrival, walking, transfers and conservative confidence', () => {
  const now = Date.parse('2026-10-02T00:00:00Z');
  const route = itinerary('80', 1200, 300, 1);
  route.startTime = now + 60000;
  route.legs[0] = { ...route.legs[0], liveStatus: 'ready', liveUpdatedAt: now, live: { arrivals: [6] } };
  route.legs.push({ mode: 'SUBWAY', trainStatus: 'ready', trainRealtime: null });
  const metrics = comparisonMetrics(route, now);
  assert.equal(metrics.arrivalAt, now + 1260000);
  assert.equal(metrics.walking, 300);
  assert.equal(metrics.transfers, 1);
  assert.equal(metrics.confidence, 'partial');
  assert.equal(metrics.confidenceLabel, 'Partly live');
  assert.equal(comparisonMetrics(route, now + 90001).confidence, 'stale');
});

test('the saved usual route wins over a faster unaffected route', () => {
  const usual = itinerary('usual', 1500, 100);
  const fast = itinerary('fast', 900, 300);
  const choice = preferredRoute({ alternatives: [fast, usual] }, { usualSignature: itinerarySignature(usual) });
  assert.equal(choice.itinerary, usual);
  assert.equal(choice.reason, 'usual');
  assert.equal(choice.usingUsual, true);
});

test('an affected usual route gets an unaffected candidate and an explanation', () => {
  const usual = { ...itinerary('NEL', 900, 100), legs: [{ mode: 'SUBWAY', routeName: 'NEL', fromId: 'NE1', toId: 'NE9' }] };
  const fallback = itinerary('80', 1500, 200);
  const alerts = [{ selectors: [{ routeId: 'NEL' }], header: 'Delay' }];
  const choice = preferredRoute({ alternatives: [usual, fallback] }, { usualSignature: itinerarySignature(usual), alerts });
  assert.equal(choice.itinerary, fallback);
  assert.equal(choice.reason, 'usual-affected');
  assert.match(choice.detail, /usual route is affected/);
  assert.equal(choice.usingUsual, false);
});

test('missing usual routes and all affected routes have explicit fallback explanations', () => {
  const fast = itinerary('80', 900, 100);
  const choice = preferredRoute(fast, { usualSignature: 'not-returned' });
  assert.equal(choice.reason, 'usual-unavailable');
  assert.match(choice.detail, /not returned/);
  const affected = { ...itinerary('NEL', 900, 100), legs: [{ mode: 'SUBWAY', routeName: 'NEL' }] };
  const blocked = preferredRoute(affected, { alerts: [{ selectors: [{ routeId: 'NEL' }] }] });
  assert.equal(blocked.reason, 'all-affected');
  assert.equal(blocked.itinerary, null);
});

test('suppresses duplicate itinerary signatures', () => {
  const fastest = itinerary('same', 900, 500);
  const duplicate = itinerary('same', 900, 500);
  const walking = itinerary('walking', 1500, 100);

  assert.deepEqual(alternativeOptions({ alternatives: [fastest, duplicate, walking] }).map((option) => option.itinerary), [fastest, walking]);
});

test('returns only the available distinct options', () => {
  const only = itinerary('only', 900, 100);
  assert.deepEqual(alternativeOptions({ alternatives: [only, { ...only }] }).map((option) => option.label), ['Fastest']);
});
