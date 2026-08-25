const ARRIVAL_REPLAY = Object.freeze({
  id: 'lta-bus-arrival-replay-v1',
  description: 'Small normalized BusArrival fixtures for deterministic timing tests.',
  stops: Object.freeze({
    '65029': Object.freeze({
      '80': Object.freeze([{ minutes: 4, monitored: true }, { minutes: 30, monitored: true }, { minutes: 45, monitored: false }]),
      '82': Object.freeze([{ minutes: 2, monitored: false }, { minutes: 11, monitored: false }, { minutes: 24, monitored: false }]),
    }),
    '67601': Object.freeze({
      '43': Object.freeze([{ minutes: 3, monitored: true }, { minutes: 14, monitored: true }, { minutes: 28, monitored: false }]),
    }),
    '04111': Object.freeze({
      '131': Object.freeze([{ minutes: 5, monitored: true }, { minutes: 20, monitored: false }, { minutes: 36, monitored: false }]),
    }),
    '04168': Object.freeze({
      '851': Object.freeze([{ minutes: 6, monitored: true }, { minutes: 20, monitored: false }, { minutes: 35, monitored: false }]),
    }),
    '77009': Object.freeze({
      '3': Object.freeze([{ minutes: 9, monitored: false }, { minutes: 20, monitored: false }, { minutes: 34, monitored: false }]),
    }),
    '98119': Object.freeze({
      '359': Object.freeze([{ minutes: 3, monitored: true }, { minutes: 12, monitored: true }, { minutes: 25, monitored: false }]),
    }),
    '98101': Object.freeze({
      '5': Object.freeze([{ minutes: 8, monitored: false }, { minutes: 20, monitored: false }, { minutes: 34, monitored: false }]),
    }),
  }),
});

function replayServiceMap(stopCode, fixture = ARRIVAL_REPLAY) {
  const services = fixture.stops[String(stopCode)] || {};
  return new Map(Object.entries(services).map(([serviceNo, buses]) => [serviceNo, {
    arrivals: buses.map((bus) => Number.isFinite(Number(bus?.minutes)) ? Number(bus.minutes) : null),
    monitored: buses.map((bus) => bus?.monitored === true),
  }]));
}

function createArrivalProvider(fixture = ARRIVAL_REPLAY) {
  return async ({ stopCode }) => replayServiceMap(stopCode, fixture);
}

module.exports = {
  ARRIVAL_REPLAY,
  replayServiceMap,
  createArrivalProvider,
};
