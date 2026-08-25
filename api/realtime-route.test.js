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
  assert.equal(candidates[0].kind, 'direct');
  assert.equal(candidates[0].serviceNo, '80');
  assert.equal(candidates[0].direction, 1);
  assert.equal(candidates[0].rideStops, 21);
  assert.equal(candidates[0].routeDistanceKm, 8.3);
});

test('finds a one-transfer journey only when both bus legs move forward through the shared stop', () => {
  const routes = [
    { ServiceNo: '10', Operator: 'SBST', Direction: 1, StopSequence: 1, BusStopCode: '10001', Distance: 0 },
    { ServiceNo: '10', Operator: 'SBST', Direction: 1, StopSequence: 2, BusStopCode: '20001', Distance: 3 },
    { ServiceNo: '10', Operator: 'SBST', Direction: 1, StopSequence: 3, BusStopCode: '30001', Distance: 5 },
    { ServiceNo: '20', Operator: 'SMRT', Direction: 1, StopSequence: 1, BusStopCode: '20001', Distance: 0 },
    { ServiceNo: '20', Operator: 'SMRT', Direction: 1, StopSequence: 2, BusStopCode: '40001', Distance: 4 },
    { ServiceNo: '30', Operator: 'SMRT', Direction: 1, StopSequence: 1, BusStopCode: '40001', Distance: 0 },
    { ServiceNo: '30', Operator: 'SMRT', Direction: 1, StopSequence: 2, BusStopCode: '20001', Distance: 2 },
  ];
  const origin = [{ stopCode: '10001', distanceMetres: 100 }];
  const destination = [{ stopCode: '40001', distanceMetres: 80 }];
  const candidates = router._test.oneTransferCandidates(routes, origin, destination);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'transfer');
  assert.equal(candidates[0].serviceNo, '10');
  assert.equal(candidates[0].secondServiceNo, '20');
  assert.equal(candidates[0].transfer.stopCode, '20001');
  assert.equal(candidates[0].transfers, 1);
  assert.equal(candidates[0].routeDistanceKm, 7);
  assert.deepEqual(candidates[0].legs.map((leg) => leg.serviceNo), ['10', '20']);
});

test('skips arrivals that leave before the user can walk to the stop', () => {
  assert.equal(router._test.accessWalkMinutes(127), 2);
  assert.equal(router._test.catchableArrival([0, 1, 6], 127), 6);
  assert.equal(router._test.catchableArrival([0, 1], 127), null);
});

test('ranks catchable live buses ahead of routes with no usable live arrival', () => {
  const ranked = router._test.rankCandidates([
    { serviceNo: 'A', transfers: 0, catchableArrivalMinutes: null, totalWalkMetres: 50, routeDistanceKm: 2, rideStops: 2 },
    { serviceNo: 'B', transfers: 1, catchableArrivalMinutes: 4, totalWalkMetres: 200, routeDistanceKm: 8, rideStops: 10 },
  ]);
  assert.equal(ranked[0].serviceNo, 'B');
});

test('prefers a direct bus over a transfer when first-bus catchability is otherwise equal', () => {
  const ranked = router._test.rankCandidates([
    { serviceNo: 'A', transfers: 1, catchableArrivalMinutes: 4, totalWalkMetres: 50, routeDistanceKm: 2, rideStops: 2 },
    { serviceNo: 'B', transfers: 0, catchableArrivalMinutes: 4, totalWalkMetres: 200, routeDistanceKm: 8, rideStops: 10 },
  ]);
  assert.equal(ranked[0].serviceNo, 'B');
});

test('validates LTA BusRoutes pages and Singapore coordinate inputs', () => {
  assert.equal(router._test.isBusRoutesPayload({ value: [{ ServiceNo: '80', Direction: 1, StopSequence: 1, BusStopCode: '65029', Distance: 0 }] }), true);
  assert.equal(router._test.isBusRoutesPayload({ value: [{ ServiceNo: '80', Direction: 3, StopSequence: 1, BusStopCode: '65029', Distance: 0 }] }), false);
  assert.deepEqual(router._test.parsePoint('1.383486,103.900782'), { lat: 1.383486, lng: 103.900782 });
  assert.equal(router._test.parsePoint('40,-74'), null);
});
