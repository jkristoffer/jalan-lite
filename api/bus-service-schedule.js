const { UpstreamError, createTimeoutSignal, fetchJson } = require('./_upstream');

const LTA_BUS_SERVICES_URL = 'https://datamall2.mytransport.sg/ltaodataservice/BusServices';
const PAGE_SIZE = 500;
const MAX_PAGES = 8;
const CACHE_MS = 12 * 60 * 60 * 1000;
const LOAD_TIMEOUT_MS = 5000;

let cachedServices = null;
let cachedAt = 0;
let loadingServices = null;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBusService(value) {
  return isRecord(value)
    && typeof value.ServiceNo === 'string'
    && value.ServiceNo.trim().length > 0
    && [1, 2].includes(Number(value.Direction));
}

function isBusServicesPayload(value) {
  return isRecord(value) && Array.isArray(value.value) && value.value.every(isBusService);
}

function parseFrequencyRange(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?$/);
  if (!match) return null;
  const minMinutes = Number(match[1]);
  const maxMinutes = Number(match[2] ?? match[1]);
  if (!Number.isFinite(minMinutes) || !Number.isFinite(maxMinutes)
    || minMinutes <= 0 || maxMinutes < minMinutes || maxMinutes > 180) return null;
  return { minMinutes, maxMinutes, raw };
}

function parseClockMinutes(value) {
  const raw = String(value ?? '').trim().toUpperCase().replace(/H$/, '');
  if (!/^\d{3,4}$/.test(raw)) return null;
  const numeric = Number(raw);
  const hour = Math.floor(numeric / 100);
  const minute = numeric % 100;
  if (numeric === 2400) return 24 * 60;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function operatingDay(row, prefix) {
  const firstMinutes = parseClockMinutes(row[`${prefix}_FirstBus`]);
  const lastMinutes = parseClockMinutes(row[`${prefix}_LastBus`]);
  if (firstMinutes === null && lastMinutes === null) return null;
  return { firstMinutes, lastMinutes };
}

function normalizeOperatingWindow(row) {
  const window = {
    weekday: operatingDay(row, 'WD'),
    saturday: operatingDay(row, 'SAT'),
    sunday: operatingDay(row, 'SUN'),
  };
  return Object.values(window).some(Boolean) ? window : null;
}

function normalizeService(value) {
  if (!isBusService(value)) return null;
  return {
    serviceNo: String(value.ServiceNo).trim(),
    operator: String(value.Operator || ''),
    direction: Number(value.Direction),
    originCode: String(value.OriginCode || ''),
    destinationCode: String(value.DestinationCode || ''),
    category: String(value.Category || ''),
    frequencies: {
      amPeak: parseFrequencyRange(value.AM_Peak_Freq),
      amOffpeak: parseFrequencyRange(value.AM_Offpeak_Freq),
      pmPeak: parseFrequencyRange(value.PM_Peak_Freq),
      pmOffpeak: parseFrequencyRange(value.PM_Offpeak_Freq),
    },
  };
}

function serviceKey(serviceNo, direction) {
  return `${String(serviceNo || '').trim()}|${Number(direction)}`;
}

function normalizedServiceMap(rows) {
  const services = new Map();
  rows.map(normalizeService).filter(Boolean).forEach((service) => {
    services.set(serviceKey(service.serviceNo, service.direction), service);
  });
  return services;
}

async function fetchServicePage(apiKey, page, signal) {
  const url = new URL(LTA_BUS_SERVICES_URL);
  url.searchParams.set('$skip', String(page * PAGE_SIZE));
  const { data } = await fetchJson(
    url,
    { headers: { AccountKey: apiKey, Accept: 'application/json' }, signal },
    { service: 'LTA BusServices', validate: isBusServicesPayload },
  );
  return data.value;
}

async function buildServiceCache(apiKey, signal) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await fetchServicePage(apiKey, page, signal);
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
  throw new UpstreamError('LTA BusServices exceeded the supported page limit.', {
    code: 'UPSTREAM_INVALID_SHAPE',
    service: 'LTA BusServices',
  });
}

async function loadServiceSchedules(apiKey, timeoutMs = LOAD_TIMEOUT_MS) {
  if (cachedServices && Date.now() - cachedAt < CACHE_MS) return cachedServices;
  if (!loadingServices) {
    const deadline = createTimeoutSignal(timeoutMs);
    loadingServices = buildServiceCache(apiKey, deadline.signal)
      .then(normalizedServiceMap)
      .catch((error) => {
        if (deadline.didTimeout()) {
          throw new UpstreamError('LTA BusServices cache loading timed out.', {
            code: 'UPSTREAM_TIMEOUT',
            service: 'LTA BusServices',
            cause: error,
          });
        }
        throw error;
      })
      .then((services) => {
        cachedServices = services;
        cachedAt = Date.now();
        return cachedServices;
      })
      .finally(() => {
        deadline.cancel();
        loadingServices = null;
      });
  }
  return loadingServices;
}

function frequencyAtSeconds(service, seconds) {
  if (!service || !Number.isFinite(Number(seconds))) return null;
  const minutes = ((Number(seconds) % 86400) + 86400) % 86400 / 60;
  let period;
  if (minutes >= 390 && minutes < 511) period = 'amPeak';
  else if (minutes >= 511 && minutes < 1020) period = 'amOffpeak';
  else if (minutes >= 1020 && minutes < 1140) period = 'pmPeak';
  else if (minutes >= 1140) period = 'pmOffpeak';
  else return null;
  const frequency = service.frequencies?.[period];
  return frequency ? { period, ...frequency } : null;
}

function dayType(dateKey) {
  const raw = String(dateKey || '');
  if (!/^\d{8}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 'sunday' : weekday === 6 ? 'saturday' : 'weekday';
}

function operatingAt(window, dateKey, seconds) {
  const day = dayType(dateKey);
  const dayWindow = day && window?.[day];
  if (!dayWindow || dayWindow.firstMinutes === null || dayWindow.lastMinutes === null) return true;
  const minutes = ((Number(seconds) % 86400) + 86400) % 86400 / 60;
  if (dayWindow.lastMinutes >= dayWindow.firstMinutes) {
    return minutes >= dayWindow.firstMinutes && minutes <= dayWindow.lastMinutes;
  }
  return minutes >= dayWindow.firstMinutes || minutes <= dayWindow.lastMinutes;
}

function reset() {
  cachedServices = null;
  cachedAt = 0;
  loadingServices = null;
}

module.exports = {
  LTA_BUS_SERVICES_URL,
  PAGE_SIZE,
  isBusService,
  isBusServicesPayload,
  parseFrequencyRange,
  parseClockMinutes,
  normalizeOperatingWindow,
  normalizeService,
  normalizedServiceMap,
  serviceKey,
  loadServiceSchedules,
  frequencyAtSeconds,
  dayType,
  operatingAt,
  reset,
};
