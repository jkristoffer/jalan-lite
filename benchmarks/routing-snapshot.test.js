const test = require('node:test');
const assert = require('node:assert/strict');
const benchmark = require('./routing-benchmark');
const scenarios = require('./routing-scenarios');
const snapshot = require('./routing-snapshot');

function fixtureFetcher(url) {
  if (new URL(url).pathname === '/api/route') {
    return Promise.resolve({
      status: 200,
      body: { plan: { itineraries: [{ duration: 45 * 60, legs: [] }] } },
      error: null,
    });
  }
  return Promise.resolve({
    status: 200,
    body: {
      engine: 'lta-realtime-multimodal-v3',
      updatedAt: '2026-08-25T07:00:00.000Z',
      rail: { candidate: { estimatedTotalMinutes: 40, legs: [] } },
      intermodal: [],
    },
    error: null,
  });
}

async function recordedFixtureReport() {
  return benchmark.runBenchmark({
    baseUrl: 'https://capture.example.test',
    date: '2026-08-25',
    departureTimes: ['08:00'],
    scenarios: [scenarios.SCENARIOS[0]],
    concurrency: 1,
    fetcher: fixtureFetcher,
    captureResponses: true,
  });
}

test('canonicalizes request identity independently of host and query order', () => {
  assert.equal(
    snapshot.canonicalRequestKey('https://one.example/api/route?end=2&start=1'),
    snapshot.canonicalRequestKey('https://two.example/api/route?start=1&end=2'),
  );
});

test('creates and replays complete endpoint response snapshots without network access', async () => {
  const recorded = await recordedFixtureReport();
  const saved = snapshot.createSnapshot(recorded);
  assert.equal(saved.kind, snapshot.SNAPSHOT_KIND);
  assert.equal(saved.version, 1);
  assert.equal(saved.samples.length, 1);
  assert.ok(saved.samples[0].responses.lta.body.engine);
  assert.ok(saved.samples[0].responses.onemap.body.plan);

  const calls = [];
  const replayFetcher = snapshot.createSnapshotFetcher(saved);
  const replayed = await benchmark.runBenchmark({
    baseUrl: 'https://different-host.example',
    date: '2026-08-25',
    departureTimes: ['08:00'],
    scenarios: [scenarios.SCENARIOS[0]],
    concurrency: 1,
    source: 'recorded-snapshot',
    fetcher: async (url, timeoutMs) => {
      calls.push({ url, timeoutMs });
      return replayFetcher(url, timeoutMs);
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(replayed.source, 'recorded-snapshot');
  assert.deepEqual(replayed.samples[0].lta, recorded.samples[0].lta);
  assert.deepEqual(replayed.samples[0].oneMap, recorded.samples[0].oneMap);
  assert.deepEqual(replayed.summary, recorded.summary);
});

test('fails closed when a replay request is missing from the snapshot', async () => {
  const recorded = await recordedFixtureReport();
  const replayFetcher = snapshot.createSnapshotFetcher(snapshot.createSnapshot(recorded));
  await assert.rejects(
    replayFetcher('https://capture.example.test/api/route?start=missing&end=missing'),
    /Recorded routing snapshot miss/,
  );
});

test('rejects duplicate request identities in a snapshot', () => {
  const response = { status: 200, body: {}, error: null };
  assert.throws(() => snapshot.validateSnapshot({
    kind: snapshot.SNAPSHOT_KIND,
    version: snapshot.SNAPSHOT_VERSION,
    samples: [
      {
        scenarioId: 'one',
        departureTime: '08:00',
        requestedAt: '2026-08-25T08:00:00+08:00',
        requests: { lta: 'https://a.test/api/route?x=1', onemap: 'https://b.test/api/route?x=1' },
        responses: { lta: response, onemap: response },
      },
    ],
  }), /duplicate request/);
});
