const test = require('node:test');
const assert = require('node:assert/strict');
const disruptions = require('./route-disruptions.js');

const ewAlert = { id: 'ew-disruption', header: 'East West Line service disruption', selectors: [{ routeId: 'EWL' }] };
const current = {
  duration: 1500,
  legs: [{ mode: 'SUBWAY', routeName: 'EW', fromId: 'EW13', toId: 'EW14' }],
};
const alternative = {
  duration: 1740,
  legs: [{ mode: 'SUBWAY', routeName: 'DT', fromId: 'DT10', toId: 'DT11' }],
};

test('matches a line alert against the affected MRT leg', () => {
  assert.equal(disruptions.alertMatchesLeg(current.legs[0], ewAlert), true);
  assert.equal(disruptions.alertMatchesLeg(alternative.legs[0], ewAlert), false);
});

test('selects the fastest alternative that avoids the affected line', () => {
  const route = { alternatives: [current, alternative] };
  assert.equal(disruptions.isAffected(current, [ewAlert]), true);
  assert.equal(disruptions.bestUnblocked(route, [ewAlert]), alternative);
});

test('returns no replacement when every alternative is affected', () => {
  const route = { alternatives: [current, { ...current, duration: 1800 }] };
  assert.equal(disruptions.bestUnblocked(route, [ewAlert]), null);
});

test('treats a network-wide alert as affecting every MRT alternative', () => {
  const globalAlert = { id: 'network-alert', header: 'Network-wide MRT disruption', selectors: [] };
  assert.equal(disruptions.bestUnblocked({ alternatives: [current, alternative] }, [globalAlert]), null);
});
