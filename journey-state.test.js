const test = require('node:test');
const assert = require('node:assert/strict');
const journey = require('./journey-state.js');

const now = Date.parse('2026-10-02T00:00:00Z');
const home = { name: 'Home', lat: 1.3, lng: 103.8 };
const stop = { name: 'Bus stop', lat: 1.31, lng: 103.81 };
const station = { name: 'Station', lat: 1.32, lng: 103.82 };
const work = { name: 'Work', lat: 1.33, lng: 103.83 };
function leg(mode, from, to, routeName = '') {
  return { mode, routeName, fromName: from.name, toName: to.name, fromPoint: from, toPoint: to,
    departureTime: now, arrivalTime: now + 60000, duration: 60 };
}
const itinerary = { legs: [leg('WALK', home, stop), leg('BUS', stop, station, '80'), leg('WALK', station, work)] };
const input = { occurrenceId: 'morning:2026-10-02', origin: home, destination: work, itinerary, plan: { departureAt: now } };
function storage() {
  const data = new Map();
  return { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
}

test('departure, walking, boarding, alighting and arrival each require an explicit confirmation', () => {
  let session = journey.create(input, now);
  assert.equal(journey.guidance(session).action, 'confirm-departure');
  session = journey.advance(session, itinerary, now);
  assert.equal(session.phase, 'walking');
  assert.deepEqual(session.lastConfirmedPoint, home);
  session = journey.advance(session, itinerary, now + 1);
  assert.equal(session.phase, 'waiting');
  assert.equal(journey.guidance(session).action, 'confirm-board');
  assert.equal(journey.guidance(session).label, 'Wait for 80');
  assert.equal(journey.guidance(session).confirmationLabel, 'Boarded 80');
  assert.deepEqual(session.lastConfirmedPoint, stop);
  session = journey.advance(session, itinerary, now + 2);
  assert.equal(session.phase, 'riding');
  assert.equal(journey.guidance(session).action, 'confirm-alight');
  assert.deepEqual(session.lastConfirmedPoint, stop);
  session = journey.advance(session, itinerary, now + 3);
  assert.equal(session.phase, 'walking');
  assert.deepEqual(session.lastConfirmedPoint, station);
  session = journey.advance(session, itinerary, now + 4);
  assert.equal(session.phase, 'arriving');
  assert.equal(journey.guidance(session).action, 'confirm-arrival');
  session = journey.advance(session, itinerary, now + 5);
  assert.equal(session.phase, 'complete');
  assert.deepEqual(session.lastConfirmedPoint, work);
  assert.equal(journey.advance(session), session);
});

test('elapsed time and failed feeds never imply boarding, alighting, or arrival', () => {
  let session = journey.start(input, now);
  session = journey.advance(session, itinerary, now);
  const failed = { ...itinerary, legs: itinerary.legs.map((item) => ({ ...item, liveStatus: 'error' })) };
  const before = JSON.stringify(session);
  assert.equal(journey.guidance(session, failed, now + 86400000).phase, 'waiting');
  assert.equal(JSON.stringify(session), before);
  session = journey.advance(session, failed, now);
  assert.equal(journey.guidance(session, failed, now + 86400000).phase, 'riding');
  assert.equal(session.legIndex, 1);
});

test('session reload preserves occurrence, chosen route, and last actual confirmation', () => {
  const target = storage();
  let session = journey.start(input, now);
  session = journey.advance(session, itinerary, now + 1);
  assert.equal(journey.save(session, target).ok, true);
  const reloaded = journey.load(target);
  assert.deepEqual(reloaded, session);
  assert.equal(journey.progress(reloaded, undefined, now + 86400000).action, 'confirm-board');
  assert.equal(reloaded.occurrenceId, input.occurrenceId);
  assert.equal(journey.load(storage()), null);
  journey.clear(target);
  assert.equal(journey.load(target), null);
});

test('storage denial and malformed persisted data are handled without changing the session', () => {
  const session = journey.start(input, now);
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(journey.save(session, denied).ok, false);
  assert.equal(journey.load(denied), null);
  const target = storage();
  target.setItem(journey.STORAGE_KEY, '{broken');
  assert.equal(journey.load(target), null);
  target.setItem(journey.STORAGE_KEY, JSON.stringify({ ...session, legIndex: 40 }));
  assert.equal(journey.load(target), null);
  assert.equal(session.phase, 'walking');
});

test('a changed route cannot advance the existing session before confirmation', () => {
  let session = journey.start(input, now);
  session = journey.advance(session, itinerary, now + 1);
  const replacement = { legs: [leg('BUS', stop, work, '27')] };
  assert.equal(journey.guidance(session, replacement).action, 'confirm-route');
  assert.equal(journey.advance(session, replacement), session);
  assert.equal(journey.replaceRoute(session, replacement), session);
  const accepted = journey.replaceRoute(session, replacement, { confirmed: true, now: now + 2 });
  assert.equal(accepted.phase, 'waiting');
  assert.equal(accepted.occurrenceId, session.occurrenceId);
  assert.equal(accepted.startedAt, session.startedAt);
  assert.deepEqual(accepted.lastConfirmedPoint, stop);
  assert.equal(accepted.itinerary.legs[0].routeName, '27');
  assert.equal(session.itinerary.legs[1].routeName, '80');
});

test('replacement routing must begin at the last confirmed point', () => {
  const session = journey.advance(journey.start(input, now), itinerary, now + 1);
  const wrongOrigin = { legs: [leg('BUS', home, work, '27')] };
  assert.equal(journey.replaceRoute(session, wrongOrigin, { confirmed: true }), session);
});

test('an explicit recovery point may replace the last confirmed point after user confirmation', () => {
  const session = journey.advance(journey.start(input, now), itinerary, now + 1);
  const recoveryPoint = { name: 'Current location', lat: 1.35, lng: 103.85 };
  const snapped = { name: 'Nearby stop', lat: 1.3502, lng: 103.8502 };
  const replacement = { legs: [leg('BUS', snapped, work, '27')] };
  assert.equal(journey.replaceRoute(session, replacement, { confirmedOrigin: recoveryPoint }), session);
  const accepted = journey.replaceRoute(session, replacement, { confirmed: true, confirmedOrigin: recoveryPoint, now: now + 2 });
  assert.deepEqual(accepted.lastConfirmedPoint, recoveryPoint);
  assert.deepEqual(accepted.origin, recoveryPoint);
  assert.equal(accepted.lastConfirmedAt, now + 2);
  assert.equal(accepted.phase, 'waiting');
});

test('recovery rejects invalid coordinates or unrelated labels even with confirmation', () => {
  const session = journey.advance(journey.start(input, now), itinerary, now + 1);
  const replacement = { legs: [leg('BUS', station, work, '27')] };
  assert.equal(journey.replaceRoute(session, replacement, { confirmed: true, confirmedOrigin: { name: station.name, lat: 999, lng: 999 } }), session);
  assert.equal(journey.replaceRoute(session, replacement, { confirmed: true, confirmedOrigin: { name: 'Unrelated label' } }), session);
});

test('starting snapshots the route and excludes its alternative pool', () => {
  const mutable = { ...itinerary, legs: itinerary.legs.map((item) => ({ ...item })), alternatives: [itinerary] };
  const session = journey.start({ ...input, itinerary: mutable }, now);
  mutable.legs[0].toName = 'Elsewhere';
  assert.equal(session.itinerary.legs[0].toName, stop.name);
  assert.equal(session.itinerary.alternatives, undefined);
});

test('direct transit and walk-only trips keep boarding and final arrival explicit', () => {
  const direct = { legs: [leg('SUBWAY', home, work, 'NEL')] };
  let session = journey.start({ ...input, itinerary: direct }, now);
  assert.equal(session.phase, 'waiting');
  session = journey.advance(session);
  assert.equal(session.phase, 'riding');
  session = journey.advance(session);
  assert.equal(session.phase, 'arriving');
  const walking = journey.start({ ...input, itinerary: { legs: [leg('WALK', home, work)] } }, now);
  assert.equal(journey.advance(walking).phase, 'arriving');
});
