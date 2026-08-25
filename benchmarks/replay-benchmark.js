const router = require('../api/realtime-route')._test;
const multimodal = require('../api/multimodal-route')._test;
const trainSchedule = require('../train-schedule')._shared;
const { createArrivalProvider } = require('./lta-arrival-replay');

const REPLAY_CASES = Object.freeze([
  Object.freeze({
    id: 'live-direct-bus',
    at: '2026-08-25T08:00:00+08:00',
    stopCode: '65029',
    serviceNo: '80',
    boardDistanceMetres: 127,
  }),
  Object.freeze({
    id: 'scheduled-rail-bus-fallback',
    at: '2026-08-25T18:00:00+08:00',
    stopCode: '77009',
    serviceNo: '3',
    boardDistanceMetres: 75,
  }),
]);

function candidateFor(replayCase) {
  return {
    kind: 'direct',
    transfers: 0,
    serviceNo: replayCase.serviceNo,
    board: { stopCode: replayCase.stopCode, distanceMetres: replayCase.boardDistanceMetres },
    alight: { stopCode: 'destination', distanceMetres: 105 },
    legs: [{
      serviceNo: replayCase.serviceNo,
      direction: 1,
      rideStops: 5,
      routeDistanceKm: 2,
      boardStopCode: replayCase.stopCode,
      alightStopCode: 'destination',
      operatingWindow: { weekday: { firstMinutes: 300, lastMinutes: 1440 } },
      serviceSchedule: {
        frequencies: {
          amPeak: { minMinutes: 8, maxMinutes: 10 },
          amOffpeak: { minMinutes: 8, maxMinutes: 10 },
          pmPeak: { minMinutes: 9, maxMinutes: 14 },
          pmOffpeak: { minMinutes: 9, maxMinutes: 14 },
        },
      },
    }],
  };
}

async function runReplayCase(replayCase, arrivalProvider = createArrivalProvider()) {
  const clock = trainSchedule.clockFromIso(replayCase.at);
  const candidate = candidateFor(replayCase);
  await router.attachLiveArrivals('replay', [candidate], null, {
    now: clock.epochMs,
    arrivalProvider,
  });
  const result = multimodal.timedRailBusCandidate(
    { transfers: 0, estimatedTotalMinutes: 18, legs: [{ mode: 'MRT', routeId: 'EW' }] },
    candidate,
    { id: 'fixture-station', name: 'Fixture Station', lat: 1.3, lng: 103.85 },
    clock,
  );
  return {
    id: replayCase.id,
    at: replayCase.at,
    liveStatus: candidate.liveStatus,
    arrivals: candidate.arrivals,
    monitored: candidate.monitored,
    timingSource: result?.timingSource || null,
    timingConfidence: result?.timingConfidence || null,
    rankable: result?.rankable === true,
    estimatedTotalMinutes: result?.estimatedTotalMinutes || null,
    estimatedTotalRangeMinutes: result?.estimatedTotalRangeMinutes || null,
  };
}

async function main() {
  const results = [];
  for (const replayCase of REPLAY_CASES) results.push(await runReplayCase(replayCase));
  console.log(JSON.stringify({
    fixture: 'lta-bus-arrival-replay-v1',
    results,
    note: 'Deterministic timing-layer replay; this does not replace full network route benchmarking.',
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Replay benchmark failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { REPLAY_CASES, candidateFor, runReplayCase };
