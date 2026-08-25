const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('./realtime-route');

test('finds a direct service only when boarding precedes alighting', () => {
  const routes = [
    { ServiceNo: '80', Operator: 'SBST', Direction: 1, StopSequence: 4, BusStopCode: '65029', Distance: 1.2 },
    { ServiceNo: '80', Operator: 'SBST', Direction: 1, StopSequence: 25, BusStopCode: '70289', Distance: 9.5 },
    { ServiceNo: '80', Operator: 'SBST', Direction: 2, StopSequence: 4, BusStopCode: '70289', Distance: 1.2 },
    { ServiceNo: '80', Operator: 'SBST', Direction: 2, StopSequence: 25, BusStopCode: '65029', Distance: 9.5 },
  ];
  const origin = [{ stopCode: '65029', distanceMetres: 127 }];
  const destination = [{ stopCode: '70289', distanceMetres: 40 }];
  const candidates = router._test.directCandidates(routes, origin, destination);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].serviceNo, '80');
  assert.equal(candidates[0].direction, 1);
  assert.equal(candidates[0].rideStops, 21);
  assert.equal(candidates[0].routeDistanceKm, 8.3);
});

test('skips arrivals that leave before the user can walk to the stop', () => {
  assert.equal(router._test.accessWalkMinutes(127), 2);
  assert.equal(router._test.catchableArrival([0, 1, 6], 127), 6);
  assert.equal(router._test.catchableArrival([0, 1], 127), null);
});

test('ranks catchable live buses ahead of routes with no usable live arrival', () => {
  const ranked = router._test.rankCandidates([
    { serviceNo: 'A', catchableArrivalMinutes: null, totalWalkMetres: 50, routeDistanceKm: 2, rideStops: 2 },
    { serviceNo: 'B', catchableArrivalMinutes: 4, totalWalkMetres: 200, routeDistanceKm: 8, rideStops: 10 },
  ]);
  assert.equal(ranked[0].serviceNo, 'B');
});

test('validates LTA BusRoutes pages and Singapore coordinate inputs', () => {
  assert.equal(router._test.isBusRoutesPayload({ value: [{ ServiceNo: '80', Direction: 1, StopSequence: 1, BusStopCode: '65029', Distance: 0 }] }), true);
  assert.equal(router._test.isBusRoutesPayload({ value: [{ ServiceNo: '80', Direction: 3, StopSequence: 1, BusStopCode: '65029', Distance: 0 }] }), false);
  assert.deepEqual(router._test.parsePoint('1.383486,103.900782'), { lat: 1.383486, lng: 103.900782 });
  assert.equal(router._test.parsePoint('40,-74'), null);
});
