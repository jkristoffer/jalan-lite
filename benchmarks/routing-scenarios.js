const SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'rivervale-tai-seng',
    label: 'Rivervale Walk → Tai Seng MRT',
    start: Object.freeze({ lat: 1.383486079111297, lng: 103.9007824399956 }),
    end: Object.freeze({ lat: 1.335141501392029, lng: 103.8883893001908 }),
  }),
  Object.freeze({
    id: 'buangkok-tai-seng',
    label: 'Buangkok MRT → Tai Seng MRT',
    start: Object.freeze({ lat: 1.383694171999941, lng: 103.8930499813181 }),
    end: Object.freeze({ lat: 1.335141501392029, lng: 103.8883893001908 }),
  }),
  Object.freeze({
    id: 'loyang-city-hall',
    label: 'Loyang Point → City Hall MRT',
    start: Object.freeze({ lat: 1.367000540763361, lng: 103.9646177762902 }),
    end: Object.freeze({ lat: 1.292989907009234, lng: 103.8525426303387 }),
  }),
  Object.freeze({
    id: 'city-hall-loyang',
    label: 'City Hall MRT → Loyang Point',
    start: Object.freeze({ lat: 1.292989907009234, lng: 103.8525426303387 }),
    end: Object.freeze({ lat: 1.367000540763361, lng: 103.9646177762902 }),
  }),
]);

const DEFAULT_DEPARTURE_TIMES = Object.freeze(['08:00', '18:00']);

function isClockTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function coordinate(point) {
  return `${point.lat},${point.lng}`;
}

function endpointUrl(baseUrl, scenario, endpoint, departureTime) {
  const path = endpoint === 'onemap' ? '/api/route' : '/api/multimodal-route';
  const url = new URL(path, `${String(baseUrl).replace(/\/$/, '')}/`);
  url.searchParams.set('start', coordinate(scenario.start));
  url.searchParams.set('end', coordinate(scenario.end));
  if (endpoint === 'onemap') {
    url.searchParams.set('time', departureTime);
    url.searchParams.set('timeMode', 'depart');
  }
  return url.toString();
}

module.exports = {
  SCENARIOS,
  DEFAULT_DEPARTURE_TIMES,
  isClockTime,
  endpointUrl,
};
