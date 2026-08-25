const test = require('node:test');
const assert = require('node:assert/strict');
const routines = require('./routine-storage.js');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    raw(key) { return values.get(key); },
  };
}

const busPreset = {
  id: 'commute-1',
  name: 'Morning bus',
  stopCode: '54009',
  stopName: 'Blk 210 Ang Mo Kio Ave 3',
  services: ['166', '76'],
  days: [1, 2, 3, 4, 5],
  startTime: '07:30',
  endTime: '09:00',
};

const savedRoute = {
  id: 'route-1',
  origin: 'Home',
  destination: 'Work',
  originPoint: { lat: 1.35, lng: 103.85 },
  destinationPoint: { lat: 1.29, lng: 103.85 },
  departureTime: '08:30',
  timeMode: 'depart',
  updatedAt: '2026-08-25T00:00:00.000Z',
};

test('adapts legacy bus presets without writing the new key', () => {
  const storage = memoryStorage({
    [routines.STORAGE_KEYS.presets]: JSON.stringify([busPreset]),
  });

  const result = routines.load(storage);

  assert.equal(result.source, 'legacy');
  assert.equal(result.needsMigration, true);
  assert.equal(result.routines.length, 1);
  assert.deepEqual(result.routines[0], {
    id: 'bus:commute-1',
    type: 'bus',
    name: 'Morning bus',
    homeWorkLabel: null,
    schedule: {
      days: [1, 2, 3, 4, 5],
      startTime: '07:30',
      endTime: '09:00',
      departureTime: null,
      timeMode: 'depart',
    },
    route: null,
    bus: {
      stopCode: '54009',
      stopName: 'Blk 210 Ang Mo Kio Ave 3',
      services: ['166', '76'],
    },
    notifications: { disruptionAlerts: false, routeAlerts: false },
    legacy: { key: routines.STORAGE_KEYS.presets, id: 'commute-1' },
  });
  assert.equal(storage.raw(routines.STORAGE_KEYS.routines), undefined);
});

test('adapts the single legacy route and preserves incomplete points safely', () => {
  const storage = memoryStorage({
    [routines.STORAGE_KEYS.routes]: JSON.stringify({ ...savedRoute, destinationPoint: null }),
  });

  const result = routines.load(storage);

  assert.equal(result.source, 'legacy');
  assert.equal(result.routines.length, 1);
  assert.equal(result.routines[0].id, 'route:route-1');
  assert.equal(result.routines[0].schedule.departureTime, '08:30');
  assert.equal(result.routines[0].route.destinationPoint, null);
  assert.deepEqual(result.routines[0].legacy, { key: routines.STORAGE_KEYS.routes, id: 'route-1' });
});

test('prefers a valid new envelope over legacy keys, including an empty envelope', () => {
  const storage = memoryStorage({
    [routines.STORAGE_KEYS.routines]: JSON.stringify({ version: 1, routines: [] }),
    [routines.STORAGE_KEYS.presets]: JSON.stringify([busPreset]),
    [routines.STORAGE_KEYS.routes]: JSON.stringify(savedRoute),
  });

  const result = routines.load(storage);

  assert.equal(result.source, 'routines');
  assert.equal(result.needsMigration, false);
  assert.deepEqual(result.routines, []);
});

test('filters malformed legacy records while retaining valid records', () => {
  const storage = memoryStorage({
    [routines.STORAGE_KEYS.presets]: JSON.stringify([
      busPreset,
      { ...busPreset, id: 'bad-bus', stopCode: '123', services: [] },
    ]),
    [routines.STORAGE_KEYS.routes]: JSON.stringify({ origin: '', destination: 'Work' }),
  });

  const result = routines.load(storage);

  assert.equal(result.routines.length, 1);
  assert.equal(result.routines[0].id, 'bus:commute-1');
});

test('falls back safely when the new key is malformed without overwriting it', () => {
  const malformed = '{not-json';
  const storage = memoryStorage({
    [routines.STORAGE_KEYS.routines]: malformed,
    [routines.STORAGE_KEYS.presets]: JSON.stringify([busPreset]),
  });

  const result = routines.load(storage);

  assert.equal(result.source, 'legacy');
  assert.equal(result.invalidStoredValue, true);
  assert.equal(storage.raw(routines.STORAGE_KEYS.routines), malformed);
});

test('normalizes and round-trips new routines without touching legacy keys', () => {
  const storage = memoryStorage({
    [routines.STORAGE_KEYS.presets]: JSON.stringify([busPreset]),
  });
  const input = {
    id: 'bus:commute-1',
    type: 'bus',
    name: 'Morning bus',
    homeWorkLabel: 'work',
    schedule: { days: [5, 1, 1], startTime: '07:30', endTime: '09:00' },
    bus: { stopCode: '54009', stopName: 'Blk 210 Ang Mo Kio Ave 3', services: ['166', '166'] },
    notifications: { routeAlerts: true },
  };

  const saved = routines.save([input], storage);
  const loaded = routines.load(storage);

  assert.equal(saved.ok, true);
  assert.equal(loaded.source, 'routines');
  assert.equal(loaded.routines[0].homeWorkLabel, 'work');
  assert.deepEqual(loaded.routines[0].schedule.days, [1, 5]);
  assert.deepEqual(loaded.routines[0].bus.services, ['166']);
  assert.equal(loaded.routines[0].notifications.routeAlerts, true);
  assert.deepEqual(JSON.parse(storage.raw(routines.STORAGE_KEYS.presets)), [busPreset]);
});

test('converts unified routines back to the existing bus and route record shapes', () => {
  const busRoutine = routines.routineFromBusPreset(busPreset);
  assert.deepEqual(routines.busPresetFromRoutine(busRoutine), busPreset);

  const routeRoutine = routines.routineFromRoute(savedRoute);
  assert.deepEqual(routines.routeFromRoutine(routeRoutine), {
    id: 'route-1',
    name: 'Saved commute',
    origin: 'Home',
    destination: 'Work',
    originPoint: savedRoute.originPoint,
    destinationPoint: savedRoute.destinationPoint,
    departureTime: '08:30',
    timeMode: 'depart',
  });
});

test('preserves optional Home/Work labels and alert preferences', () => {
  const routeRoutine = routines.routineFromRoute({
    ...savedRoute,
    name: 'Home to Work',
    homeWorkLabel: 'work',
    notifications: { disruptionAlerts: true, routeAlerts: false },
  });
  const busRoutine = routines.routineFromBusPreset({
    ...busPreset,
    homeWorkLabel: 'home',
    notifications: { disruptionAlerts: true, routeAlerts: true },
  });

  assert.equal(routeRoutine.homeWorkLabel, 'work');
  assert.deepEqual(routeRoutine.notifications, { disruptionAlerts: true, routeAlerts: false });
  assert.equal(routines.routeFromRoutine(routeRoutine).homeWorkLabel, 'work');
  assert.deepEqual(routines.routeFromRoutine(routeRoutine).notifications, { disruptionAlerts: true, routeAlerts: false });
  assert.equal(routines.busPresetFromRoutine(busRoutine).homeWorkLabel, 'home');
  assert.deepEqual(routines.busPresetFromRoutine(busRoutine).notifications, { disruptionAlerts: true, routeAlerts: true });
});

test('returns a safe empty envelope when storage is unavailable', () => {
  const result = routines.load(null);
  const saved = routines.save([], null);

  assert.deepEqual(result.routines, []);
  assert.equal(result.source, 'empty');
  assert.equal(saved.ok, false);
  assert.deepEqual(saved.routines, []);
});
