const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../api/realtime-route')._test;
const replay = require('./lta-arrival-replay');
const replayBenchmark = require('./replay-benchmark');

test('replays normalized BusArrival data without network access', async () => {
  const provider = replay.createArrivalProvider();
  const services = await provider({ stopCode: '65029', now: Date.parse('2026-08-25T08:00:00+08:00') });
  assert.deepEqual(services.get('80'), {
    arrivals: [4, 30, 45],
    monitored: [true, true, false],
  });
});

test('attaches replayed live arrivals using the injected benchmark clock', async () => {
  const candidate = {
    kind: 'direct',
    transfers: 0,
    serviceNo: '80',
    board: { stopCode: '65029', distanceMetres: 127 },
    legs: [{ serviceNo: '80', direction: 1 }],
  };
  const provider = replay.createArrivalProvider();
  const now = Date.parse('2026-08-25T08:00:00+08:00');
  await router.attachLiveArrivals('replay', [candidate], null, { now, arrivalProvider: provider });
  assert.equal(candidate.liveStatus, 'ready');
  assert.equal(candidate.catchableArrivalMinutes, 4);
  assert.deepEqual(candidate.arrivals, [4, 30, 45]);
  assert.deepEqual(candidate.monitored, [true, true, false]);
});

test('replay benchmark distinguishes live timing from scheduled estimates', async () => {
  const results = [];
  for (const replayCase of replayBenchmark.REPLAY_CASES) results.push(await replayBenchmark.runReplayCase(replayCase));
  assert.equal(results[0].timingSource, 'live');
  assert.equal(results[0].rankable, true);
  assert.equal(results[1].timingSource, 'scheduled-estimate');
  assert.equal(results[1].timingConfidence, 'low');
  assert.equal(results[1].rankable, true);
});
