const test = require('node:test');
const assert = require('node:assert/strict');
const scenarios = require('./routing-scenarios');
const benchmark = require('./routing-benchmark');

test('keeps the benchmark scenario set fixed and validates departure times', () => {
  assert.deepEqual(scenarios.SCENARIOS.map((scenario) => scenario.id), [
    'rivervale-tai-seng',
    'buangkok-tai-seng',
    'loyang-city-hall',
    'city-hall-loyang',
  ]);
  assert.deepEqual(scenarios.DEFAULT_DEPARTURE_TIMES, ['08:00', '18:00']);
  assert.equal(scenarios.isClockTime('08:00'), true);
  assert.equal(scenarios.isClockTime('8:00'), false);
});

test('builds separate OneMap and LTA-native benchmark URLs', () => {
  const scenario = scenarios.SCENARIOS[0];
  const oneMapUrl = scenarios.endpointUrl('https://example.test/', scenario, 'onemap', '18:00');
  const ltaUrl = scenarios.endpointUrl('https://example.test/', scenario, 'lta', '18:00');
  assert.equal(new URL(oneMapUrl).pathname, '/api/route');
  assert.equal(new URL(oneMapUrl).searchParams.get('time'), '18:00');
  assert.equal(new URL(ltaUrl).pathname, '/api/multimodal-route');
  assert.equal(new URL(ltaUrl).searchParams.get('time'), null);
});

test('summarizes scheduled rail-to-bus estimates with source and confidence', () => {
  const result = benchmark.summarizeLta({
    status: 200,
    body: {
      engine: 'lta-realtime-multimodal-v3',
      updatedAt: '2026-08-25T07:00:00.000Z',
      bus: { candidates: [{ kind: 'direct', transfers: 0, serviceNo: '3', totalWalkMetres: 100, liveStatus: 'ready' }] },
      rail: { candidate: null },
      intermodal: [{
        kind: 'rail-bus',
        timingStatus: 'estimated',
        timingSource: 'scheduled-estimate',
        timingConfidence: 'low',
        rankable: true,
        estimatedTotalMinutes: 65,
        estimatedTotalRangeMinutes: [56, 76],
        legs: [{ mode: 'MRT', routeId: 'EW' }, { serviceNo: '3' }],
      }],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.observationTime, '2026-08-25T07:00:00.000Z');
  assert.equal(result.bestPath.timingSource, 'scheduled-estimate');
  assert.equal(result.bestPath.timingConfidence, 'low');
  assert.deepEqual(result.bestPath.estimatedTotalRangeMinutes, [56, 76]);
  assert.equal(result.directBus.serviceNo, '3');
});

test('compares the best available paths without hiding an unranked LTA result', () => {
  const oneMap = benchmark.summarizeOneMap({
    status: 200,
    body: { plan: { itineraries: [{ duration: 45 * 60, legs: [] }, { duration: 50 * 60, legs: [] }] } },
  });
  const noRankedLta = benchmark.summarizeLta({
    status: 200,
    body: { engine: 'lta-realtime-multimodal-v3', intermodal: [{ kind: 'rail-bus', rankable: false }], rail: { candidate: null } },
  });
  assert.equal(oneMap.bestMinutes, 45);
  assert.equal(benchmark.compareSample(oneMap, noRankedLta).outcome, 'no-ranked-lta');
});

test('holds promotion when confidence or comparative timing is insufficient', () => {
  const samples = Array.from({ length: 8 }, (_, index) => ({
    lta: { ok: true, bestPath: index === 0 ? { timingConfidence: 'low', timingSource: 'scheduled-estimate', estimatedTotalMinutes: 70 } : { timingConfidence: 'medium', timingSource: 'live', estimatedTotalMinutes: 50 } },
    oneMap: { ok: true, bestMinutes: 45 },
    comparison: { outcome: 'onemap-faster', deltaMinutes: index === 0 ? 25 : 7 },
  }));
  const summary = benchmark.aggregateBenchmark(samples);
  assert.equal(summary.sampleCount, 8);
  assert.equal(summary.promotion.status, 'hold');
  assert.equal(summary.promotion.criteria.medianDeltaMinutes.pass, false);
});

test('runs a deterministic fixture benchmark without network access', async () => {
  const calls = [];
  const report = await benchmark.runBenchmark({
    baseUrl: 'https://example.test',
    date: '2026-08-25',
    departureTimes: ['08:00'],
    scenarios: [scenarios.SCENARIOS[0]],
    concurrency: 1,
    fetcher: async (url) => {
      calls.push(url);
      if (url.includes('/api/route')) return { status: 200, body: { plan: { itineraries: [{ duration: 45 * 60, legs: [] }] } }, error: null };
      return { status: 200, body: { engine: 'lta-realtime-multimodal-v3', updatedAt: '2026-08-25T07:00:00.000Z', rail: { candidate: { estimatedTotalMinutes: 40, legs: [] } }, intermodal: [] }, error: null };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(report.samples.length, 1);
  assert.equal(report.samples[0].comparison.outcome, 'lta-faster');
  assert.equal(report.summary.medianDeltaMinutes, -5);
});
