const test = require('node:test');
const assert = require('node:assert/strict');
const { alternativeOptions } = require('./route-alternatives.js');

function itinerary(id, duration, walkDuration) {
  return { duration, walkDuration, legs: [{ mode: 'BUS', routeName: id, fromId: 'from', toId: 'to' }] };
}

test('selects fastest, second fastest, then least walking distinct itineraries', () => {
  const slow = itinerary('slow', 1800, 100);
  const fastest = itinerary('fastest', 900, 500);
  const second = itinerary('second', 1200, 300);
  const leastWalking = itinerary('walking', 2100, 50);
  const options = alternativeOptions({ alternatives: [slow, fastest, second, leastWalking] });

  assert.deepEqual(options.map((option) => [option.label, option.itinerary]), [
    ['Fastest', fastest],
    ['Second fastest', second],
    ['Less walking', leastWalking],
  ]);
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
