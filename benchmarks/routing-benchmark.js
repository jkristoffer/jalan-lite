const { SCENARIOS, DEFAULT_DEPARTURE_TIMES, endpointUrl, benchmarkAt, isClockTime } = require('./routing-scenarios');
const routingSnapshot = require('./routing-snapshot');

const DEFAULT_BASE_URL = 'https://jalan-lite.vercel.app';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CONCURRENCY = 2;
const PROMOTION_CRITERIA = Object.freeze({
  minimumSamples: 8,
  minLtaResponseRate: 1,
  minOneMapCompleteRate: 1,
  minRankedPathRate: 0.9,
  maxLowConfidenceRate: 0.25,
  maxMedianDeltaMinutes: 5,
});

function singaporeDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    baseUrl: process.env.JALAN_BASE_URL || DEFAULT_BASE_URL,
    date: singaporeDate(),
    departureTimes: [...DEFAULT_DEPARTURE_TIMES],
    scenarioIds: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY,
    json: false,
    recordPath: null,
    replayPath: null,
    force: false,
    dateExplicit: false,
    departureTimesExplicit: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`Missing value for ${argument}.`);
      return argv[index];
    };
    if (argument === '--base-url') options.baseUrl = next();
    else if (argument === '--date') { options.date = next(); options.dateExplicit = true; }
    else if (argument === '--times') { options.departureTimes = next().split(',').map((value) => value.trim()).filter(Boolean); options.departureTimesExplicit = true; }
    else if (argument === '--scenarios') { options.scenarioIds = next().split(',').map((value) => value.trim()).filter(Boolean); }
    else if (argument === '--timeout-ms') options.timeoutMs = Number(next());
    else if (argument === '--concurrency') options.concurrency = Number(next());
    else if (argument === '--record') options.recordPath = next();
    else if (argument === '--replay') options.replayPath = next();
    else if (argument === '--force') options.force = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (options.help) return options;
  if (options.recordPath && options.replayPath) throw new Error('--record and --replay cannot be used together.');
  if (options.force && !options.recordPath) throw new Error('--force requires --record.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error('Date must use YYYY-MM-DD format.');
  if (!options.departureTimes.length || options.departureTimes.some((time) => !isClockTime(time))) {
    throw new Error('Times must be a comma-separated list of HH:MM values.');
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('Timeout must be at least 1000 ms.');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('Concurrency must be a positive integer.');
  return options;
}

async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* summarize malformed responses below */ }
    return { status: response.status, body, error: body ? null : 'Response was not valid JSON.' };
  } catch (error) {
    return { status: 0, body: null, error: error.name === 'AbortError' ? `Timed out after ${timeoutMs} ms.` : error.message };
  } finally {
    clearTimeout(timer);
  }
}

function finiteMinutes(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function summarizeOneMap(response) {
  const itineraries = response.body?.plan?.itineraries || response.body?.itineraries || [];
  const durations = itineraries.map((itinerary) => finiteMinutes(itinerary.duration / 60)).filter(Number.isFinite);
  const best = durations.length ? Math.min(...durations) : null;
  return {
    ok: response.status === 200 && itineraries.length > 0,
    status: response.status,
    error: response.error || (response.status === 200 && !itineraries.length ? 'No complete itinerary.' : null),
    itineraryCount: itineraries.length,
    firstMinutes: durations.length ? Math.round(durations[0]) : null,
    bestMinutes: best === null ? null : Math.round(best),
  };
}

function summarizeIntermodal(candidate) {
  return {
    kind: candidate.kind || null,
    timingStatus: candidate.timingStatus || null,
    timingSource: candidate.timingSource || null,
    timingConfidence: candidate.timingConfidence || null,
    rankable: candidate.rankable === true,
    estimatedTotalMinutes: finiteMinutes(candidate.estimatedTotalMinutes),
    estimatedTotalRangeMinutes: Array.isArray(candidate.estimatedTotalRangeMinutes)
      ? candidate.estimatedTotalRangeMinutes.map(Number)
      : null,
    services: (candidate.legs || []).map((leg) => leg.serviceNo || leg.routeId || leg.mode).filter(Boolean),
  };
}

function summarizeLta(response) {
  const body = response.body || {};
  const intermodal = Array.isArray(body.intermodal) ? body.intermodal.map(summarizeIntermodal) : [];
  const rankedIntermodal = intermodal
    .filter((candidate) => candidate.rankable && Number.isFinite(candidate.estimatedTotalMinutes))
    .sort((left, right) => left.estimatedTotalMinutes - right.estimatedTotalMinutes);
  const railMinutes = finiteMinutes(body.rail?.candidate?.estimatedTotalMinutes);
  const bestPath = rankedIntermodal[0]
    ? { source: 'intermodal', ...rankedIntermodal[0] }
    : railMinutes === null
      ? null
      : { source: 'rail', kind: 'rail', timingStatus: 'scheduled', timingSource: 'scheduled', timingConfidence: 'scheduled', rankable: true, estimatedTotalMinutes: railMinutes, estimatedTotalRangeMinutes: null, services: (body.rail.candidate.legs || []).map((leg) => leg.routeId || leg.mode).filter(Boolean) };
  const directBus = (body.bus?.candidates || []).find((candidate) => candidate.kind === 'direct' && candidate.transfers === 0);

  return {
    ok: response.status === 200 && Boolean(body.engine),
    status: response.status,
    error: response.error || (response.status === 200 && !body.engine ? 'Missing LTA response engine.' : null),
    observationTime: body.updatedAt || null,
    directBus: directBus ? {
      serviceNo: directBus.serviceNo || null,
      totalWalkMetres: finiteMinutes(directBus.totalWalkMetres),
      liveStatus: directBus.liveStatus || null,
    } : null,
    railMinutes,
    intermodal,
    intermodalRankable: rankedIntermodal.length > 0,
    scheduledEstimateCount: intermodal.filter((candidate) => candidate.timingSource === 'scheduled-estimate').length,
    lowConfidenceCount: intermodal.filter((candidate) => candidate.timingConfidence === 'low').length,
    bestPath,
  };
}

function compareSample(oneMap, lta) {
  const oneMapMinutes = oneMap.bestMinutes;
  const ltaMinutes = lta.bestPath?.estimatedTotalMinutes ?? null;
  const deltaMinutes = Number.isFinite(oneMapMinutes) && Number.isFinite(ltaMinutes)
    ? ltaMinutes - oneMapMinutes
    : null;
  let outcome = 'unavailable';
  if (lta.bestPath && oneMapMinutes !== null) outcome = deltaMinutes <= 0 ? 'lta-faster' : 'onemap-faster';
  else if (lta.bestPath) outcome = 'lta-only';
  else if (oneMapMinutes !== null) outcome = 'no-ranked-lta';
  return { oneMapMinutes, ltaMinutes, deltaMinutes, outcome };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function aggregateBenchmark(samples) {
  const total = samples.length;
  const ltaSuccesses = samples.filter((sample) => sample.lta.ok).length;
  const oneMapComplete = samples.filter((sample) => sample.oneMap.ok).length;
  const rankedPaths = samples.filter((sample) => sample.lta.bestPath).length;
  const lowConfidence = samples.filter((sample) => sample.lta.bestPath?.timingConfidence === 'low').length;
  const deltas = samples.map((sample) => sample.comparison.deltaMinutes).filter(Number.isFinite);
  const criteria = {
    minimumSamples: { threshold: PROMOTION_CRITERIA.minimumSamples, actual: total, pass: total >= PROMOTION_CRITERIA.minimumSamples },
    ltaResponseRate: { threshold: PROMOTION_CRITERIA.minLtaResponseRate, actual: rate(ltaSuccesses, total), pass: rate(ltaSuccesses, total) >= PROMOTION_CRITERIA.minLtaResponseRate },
    oneMapCompleteRate: { threshold: PROMOTION_CRITERIA.minOneMapCompleteRate, actual: rate(oneMapComplete, total), pass: rate(oneMapComplete, total) >= PROMOTION_CRITERIA.minOneMapCompleteRate },
    rankedPathRate: { threshold: PROMOTION_CRITERIA.minRankedPathRate, actual: rate(rankedPaths, total), pass: rate(rankedPaths, total) >= PROMOTION_CRITERIA.minRankedPathRate },
    lowConfidenceRate: { threshold: PROMOTION_CRITERIA.maxLowConfidenceRate, actual: rate(lowConfidence, total), pass: rate(lowConfidence, total) <= PROMOTION_CRITERIA.maxLowConfidenceRate },
    medianDeltaMinutes: { threshold: PROMOTION_CRITERIA.maxMedianDeltaMinutes, actual: median(deltas), pass: median(deltas) !== null && median(deltas) <= PROMOTION_CRITERIA.maxMedianDeltaMinutes },
  };
  return {
    sampleCount: total,
    ltaResponseRate: rate(ltaSuccesses, total),
    oneMapCompleteRate: rate(oneMapComplete, total),
    rankedPathRate: rate(rankedPaths, total),
    lowConfidenceRate: rate(lowConfidence, total),
    scheduledEstimateRate: rate(samples.filter((sample) => sample.lta.bestPath?.timingSource === 'scheduled-estimate').length, total),
    medianDeltaMinutes: median(deltas),
    outcomes: samples.reduce((counts, sample) => {
      counts[sample.comparison.outcome] = (counts[sample.comparison.outcome] || 0) + 1;
      return counts;
    }, {}),
    promotion: {
      status: Object.values(criteria).every((criterion) => criterion.pass) ? 'eligible' : 'hold',
      criteria,
    },
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function runBenchmark({
  baseUrl = DEFAULT_BASE_URL,
  date = singaporeDate(),
  departureTimes = DEFAULT_DEPARTURE_TIMES,
  scenarios = SCENARIOS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  fetcher = fetchJson,
  captureResponses = false,
  source = 'live',
} = {}) {
  const jobs = scenarios.flatMap((scenario) => departureTimes.map((departureTime) => ({ scenario, departureTime })));
  const samples = await mapLimit(jobs, concurrency, async ({ scenario, departureTime }) => {
    const requestedAt = benchmarkAt(date, departureTime);
    const ltaUrl = endpointUrl(baseUrl, scenario, 'lta', departureTime, requestedAt);
    const oneMapUrl = endpointUrl(baseUrl, scenario, 'onemap', departureTime, requestedAt);
    const [ltaResponse, oneMapResponse] = await Promise.all([
      fetcher(ltaUrl, timeoutMs),
      fetcher(oneMapUrl, timeoutMs),
    ]);
    const lta = summarizeLta(ltaResponse);
    const oneMap = summarizeOneMap(oneMapResponse);
    const sample = {
      scenarioId: scenario.id,
      scenarioLabel: scenario.label,
      departureTime,
      requestedAt,
      ltaObservationTime: lta.observationTime,
      lta,
      oneMap,
      comparison: compareSample(oneMap, lta),
    };
    if (captureResponses) {
      sample.requests = { lta: ltaUrl, onemap: oneMapUrl };
      sample.responses = { lta: ltaResponse, onemap: oneMapResponse };
    }
    return sample;
  });
  return {
    generatedAt: new Date().toISOString(),
    source,
    baseUrl: String(baseUrl).replace(/\/$/, ''),
    requestedDate: date,
    departureTimes: [...departureTimes],
    scenarioIds: scenarios.map((scenario) => scenario.id),
    timingNote: 'Both endpoints receive the same requestedClock timestamp. OneMap and scheduled LTA rail use that clock; live LTA BusArrival remains observation-time data unless a replay provider is used.',
    promotionCriteria: PROMOTION_CRITERIA,
    samples,
    summary: aggregateBenchmark(samples),
  };
}

function formatRate(value) {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function formatReport(report) {
  const lines = [
    `Routing benchmark: ${report.baseUrl}`,
    `Data source: ${report.source || 'live'}`,
    `Requested date: ${report.requestedDate}; samples: ${report.summary.sampleCount}`,
    '',
  ];
  report.samples.forEach((sample) => {
    const ltaPath = sample.lta.bestPath
      ? `${sample.lta.bestPath.source} ${sample.lta.bestPath.estimatedTotalMinutes}m/${sample.lta.bestPath.timingSource || 'unknown'}${sample.lta.bestPath.timingConfidence ? `/${sample.lta.bestPath.timingConfidence}` : ''}`
      : 'no-ranked-path';
    const oneMapPath = sample.oneMap.bestMinutes === null ? 'no-route' : `${sample.oneMap.bestMinutes}m`;
    const delta = sample.comparison.deltaMinutes === null ? 'n/a' : `${sample.comparison.deltaMinutes >= 0 ? '+' : ''}${sample.comparison.deltaMinutes}m`;
    lines.push(`${sample.scenarioId} @ ${sample.departureTime}: LTA ${ltaPath}; OneMap ${oneMapPath}; delta ${delta}; ${sample.comparison.outcome}`);
  });
  lines.push(
    '',
    `Coverage: LTA ${formatRate(report.summary.ltaResponseRate)}, OneMap complete ${formatRate(report.summary.oneMapCompleteRate)}, ranked path ${formatRate(report.summary.rankedPathRate)}.`,
    `Timing: scheduled-estimate ${formatRate(report.summary.scheduledEstimateRate)}, low confidence ${formatRate(report.summary.lowConfidenceRate)}, median LTA delta ${report.summary.medianDeltaMinutes ?? 'n/a'}m.`,
    `Promotion status: ${report.summary.promotion.status.toUpperCase()}.`,
    'Note: both routers receive requestedClock; LTA bus arrivals remain live-at-observation-time, so this is not historical BusArrival replay.',
  );
  return lines.join('\n');
}

function helpText() {
  return [
    'Usage: node benchmarks/routing-benchmark.js [options]',
    '',
    '  --base-url URL          Endpoint base URL (default: production)',
    '  --date YYYY-MM-DD      Date label for the benchmark run',
    '  --times HH:MM,HH:MM    OneMap departure times (default: 08:00,18:00)',
    '  --scenarios ID,ID      Limit the fixed scenario set',
    '  --timeout-ms N         Request timeout (default: 30000)',
    '  --concurrency N        Concurrent samples (default: 2)',
    '  --record FILE          Capture complete endpoint responses to a snapshot',
    '  --replay FILE          Run without network using a recorded snapshot',
    '  --force                Replace an existing --record snapshot',
    '  --json                 Emit machine-readable JSON',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const snapshot = options.replayPath ? routingSnapshot.readSnapshot(options.replayPath) : null;
  const scenarioIds = options.scenarioIds || (snapshot?.scenarioIds?.length ? snapshot.scenarioIds : null);
  const scenarios = scenarioIds
    ? SCENARIOS.filter((scenario) => scenarioIds.includes(scenario.id))
    : SCENARIOS;
  if (!scenarios.length) throw new Error('No matching scenarios.');

  const report = await runBenchmark({
    ...options,
    baseUrl: snapshot?.sourceBaseUrl || options.baseUrl,
    date: snapshot && !options.dateExplicit ? snapshot.requestedDate : options.date,
    departureTimes: snapshot && !options.departureTimesExplicit ? snapshot.departureTimes : options.departureTimes,
    scenarios,
    fetcher: snapshot ? routingSnapshot.createSnapshotFetcher(snapshot) : fetchJson,
    captureResponses: Boolean(options.recordPath),
    source: snapshot ? 'recorded-snapshot' : 'live',
  });
  let snapshotPath = null;
  if (options.recordPath) {
    snapshotPath = routingSnapshot.writeSnapshot(options.recordPath, routingSnapshot.createSnapshot(report), { overwrite: options.force });
  }
  if (options.json) {
    console.log(JSON.stringify(snapshotPath ? { ...report, snapshotPath } : report, null, 2));
  } else {
    console.log(formatReport(report));
    if (snapshotPath) console.log(`Recorded snapshot: ${snapshotPath}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Benchmark failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  PROMOTION_CRITERIA,
  parseArgs,
  fetchJson,
  summarizeOneMap,
  summarizeLta,
  compareSample,
  aggregateBenchmark,
  formatReport,
  runBenchmark,
  createSnapshot: routingSnapshot.createSnapshot,
  createSnapshotFetcher: routingSnapshot.createSnapshotFetcher,
};
