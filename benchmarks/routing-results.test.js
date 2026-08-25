const test = require('node:test');
const assert = require('node:assert/strict');
const benchmark = require('./routing-benchmark');
const results = require('./routing-results');
const scenarios = require('./routing-scenarios');

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

test('stores only compact route summaries, not endpoint response bodies', async () => {
  const report = await benchmark.runBenchmark({
    baseUrl: 'https://example.test',
    date: '2026-08-25',
    departureTimes: ['08:00'],
    scenarios: [scenarios.SCENARIOS[0]],
    concurrency: 1,
    fetcher: fixtureFetcher,
  });
  const saved = results.createResults(report);
  assert.equal(saved.kind, results.RESULT_KIND);
  assert.equal(saved.samples.length, 1);
  assert.equal('responses' in saved.samples[0], false);
  assert.equal(saved.samples[0].lta.bestPath.source, 'rail');
  assert.equal(saved.samples[0].oneMap.bestMinutes, 45);
  assert.equal(JSON.stringify(saved).includes('engine'), false);
});

test('reconstructs a report from compact results for offline display', async () => {
  const report = await benchmark.runBenchmark({
    baseUrl: 'https://example.test',
    date: '2026-08-25',
    departureTimes: ['08:00'],
    scenarios: [scenarios.SCENARIOS[0]],
    concurrency: 1,
    fetcher: fixtureFetcher,
  });
  const replayed = results.reportFromResults(results.createResults(report));
  assert.equal(replayed.source, 'recorded-results');
  assert.deepEqual(replayed.samples, results.createResults(report).samples);
  assert.deepEqual(replayed.summary, report.summary);
});

test('rejects malformed compact result files', () => {
  assert.throws(() => results.validateResults({ kind: results.RESULT_KIND, version: results.RESULT_VERSION, samples: [] }), /at least one sample/);
});
