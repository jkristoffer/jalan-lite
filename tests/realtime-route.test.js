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
    { kind: 'direct', serviceNo: 'A', transfers: 0, catchableArrivalMinutes: null, totalWalkMetres: 50, routeDistanceKm: 2, rideStops: 2, board: { stopCode: '1' }, alight: { stopCode: '2' }, legs: [{ serviceNo: 'A', direction: 1 }] },
    { kind: 'transfer', serviceNo: 'B', secondServiceNo: 'C', transfers: 1, catchableArrivalMinutes: 4, secondLiveStatus: 'unchecked', secondArrivals: [null, null, null], totalWalkMetres: 200, routeDistanceKm: 8, rideStops: 10, board: { stopCode: '1' }, alight: { stopCode: '2' }, legs: [{ serviceNo: 'B', direction: 1 }, { serviceNo: 'C', direction: 1 }] },
  ]);
  assert.equal(ranked[0].serviceNo, 'B');
});

test('prefers a direct live bus over a transfer until transfer timing can be proven end to end', () => {
  const ranked = router._test.rankCandidates([
    { kind: 'transfer', serviceNo: '82', secondServiceNo: '80', transfers: 1, catchableArrivalMinutes: 4, secondLiveStatus: 'ready', secondArrivals: [8, 18, 28], totalWalkMetres: 151, routeDistanceKm: 7.6, rideStops: 20, board: { stopCode: '65029' }, alight: { stopCode: '70289' }, transfer: { stopCode: '63059' }, legs: [{ serviceNo: '82', direction: 1 }, { serviceNo: '80', direction: 1 }] },
    { kind: 'direct', serviceNo: '80', transfers: 0, catchableArrivalMinutes: 7, totalWalkMetres: 151, routeDistanceKm: 7.8, rideStops: 21, board: { stopCode: '65029' }, alight: { stopCode: '70289' }, legs: [{ serviceNo: '80', direction: 1 }] },
  ]);
  assert.equal(ranked[0].serviceNo, '80');
});

test('prefers a transfer with live data for both services over a partial-live transfer', () => {
  const ranked = router._test.rankCandidates([
    { kind: 'transfer', serviceNo: '10', secondServiceNo: '20', transfers: 1, catchableArrivalMinutes: 3, secondLiveStatus: 'unavailable', secondArrivals: [null, null, null], totalWalkMetres: 50, routeDistanceKm: 4, rideStops: 6, board: { stopCode: '10001' }, alight: { stopCode: '40001' }, transfer: { stopCode: '20001' }, legs: [{ serviceNo: '10', direction: 1 }, { serviceNo: '20', direction: 1 }] },
    { kind: 'transfer', serviceNo: '11', secondServiceNo: '21', transfers: 1, catchableArrivalMinutes: 5, secondLiveStatus: 'ready', secondArrivals: [8, 18, null], totalWalkMetres: 100, routeDistanceKm: 7, rideStops: 10, board: { stopCode: '10001' }, alight: { stopCode: '40001' }, transfer: { stopCode: '20002' }, legs: [{ serviceNo: '11', direction: 1 }, { serviceNo: '21', direction: 1 }] },
  ]);
  assert.equal(ranked[0].serviceNo, '11');
});

test('deduplicates equivalent transfer service pairs with different transfer stops', () => {
  const ranked = router._test.rankCandidates([
    { kind: 'transfer', serviceNo: '82', secondServiceNo: '80', transfers: 1, catchableArrivalMinutes: 4, secondLiveStatus: 'ready', secondArrivals: [8], totalWalkMetres: 151, routeDistanceKm: 7.6, rideStops: 20, board: { stopCode: '65029' }, alight: { stopCode: '70289' }, transfer: { stopCode: '63059' }, legs: [{ serviceNo: '82', direction: 1 }, { serviceNo: '80', direction: 1 }] },
    { kind: 'transfer', serviceNo: '82', secondServiceNo: '80', transfers: 1, catchableArrivalMinutes: 4, secondLiveStatus: 'ready', secondArrivals: [9], totalWalkMetres: 151, routeDistanceKm: 7.6, rideStops: 20, board: { stopCode: '65029' }, alight: { stopCode: '70289' }, transfer: { stopCode: '63049' }, legs: [{ serviceNo: '82', direction: 1 }, { serviceNo: '80', direction: 1 }] },
  ]);
  assert.equal(ranked.length, 1);
});

test('attaches live arrival state for the second bus at the transfer stop', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ Services: [{ ServiceNo: '20', NextBus: { EstimatedArrival: new Date(Date.now() + 10 * 60000).toISOString(), Monitored: '1' }, NextBus2: null, NextBus3: null }] }),
  });
  const candidate = { kind: 'transfer', serviceNo: '10', secondServiceNo: '20', transfers: 1, catchableArrivalMinutes: 4, transfer: { stopCode: '20001' }, legs: [{ serviceNo: '10', direction: 1 }, { serviceNo: '20', direction: 1 }] };
  try {
    await router._test.attachTransferLiveArrivals('test-key', [candidate]);
    assert.equal(candidate.secondLiveStatus, 'ready');
    assert.equal(candidate.secondArrivals[0], 10);
    assert.equal(candidate.legs[1].liveStatus, 'ready');
    assert.equal(candidate.legs[1].monitored[0], true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('validates LTA BusRoutes pages and Singapore coordinate inputs', () => {
  assert.equal(router._test.isBusRoutesPayload({ value: [{ ServiceNo: '80', Direction: 1, StopSequence: 1, BusStopCode: '65029', Distance: 0 }] }), true);
  assert.equal(router._test.isBusRoutesPayload({ value: [{ ServiceNo: '80', Direction: 3, StopSequence: 1, BusStopCode: '65029', Distance: 0 }] }), false);
  assert.deepEqual(router._test.parsePoint('1.383486,103.900782'), { lat: 1.383486, lng: 103.900782 });
  assert.equal(router._test.parsePoint('40,-74'), null);
});
