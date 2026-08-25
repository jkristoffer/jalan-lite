const { fetchBytes } = require('./_upstream');
const base = require('./train-schedule')._shared;

const GTFS_SCHEDULE_INDEX_URL = 'https://datamall2.mytransport.sg/ltaodataservice/GTFSScheduleTrain';
const GTFS_LINK_HOST = 'dmprod-datasets.s3.ap-southeast-1.amazonaws.com';
const CACHE_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 15000;
const textDecoder = new TextDecoder();
let cachedSchedule = null;
let cachedAt = 0;
let loadingSchedule = null;

function parseJsonDocument(bytes) {
  try { return JSON.parse(textDecoder.decode(bytes)); }
  catch (error) { throw new Error('Invalid LTA GTFS Schedule index JSON.'); }
}

function parseScheduleIndex(bytes) {
  const entries = base.unzipEntries(bytes);
  const jsonEntry = entries.find(({ name }) => /\.json$/i.test(name));
  const data = jsonEntry
    ? parseJsonDocument(jsonEntry.bytes)
    : (!entries.length && /^\s*\{/.test(textDecoder.decode(bytes)) ? parseJsonDocument(bytes) : null);
  if (!data || !Array.isArray(data.value) || !data.value.length) {
    throw new Error('Invalid LTA GTFS Schedule index shape.');
  }
  const item = data.value.find((candidate) => candidate && typeof candidate === 'object' && typeof (candidate.link || candidate.Link) === 'string');
  if (!item) throw new Error('LTA GTFS Schedule index is missing its download link.');
  let link;
  try { link = new URL(item.link || item.Link); }
  catch (error) { throw new Error('LTA GTFS Schedule index contains an invalid download link.'); }
  if (link.protocol !== 'https:' || link.hostname !== GTFS_LINK_HOST || !/\/train-gtfs-schedule\/.*\.zip$/i.test(link.pathname)) {
    throw new Error('LTA GTFS Schedule index contains an unsafe download link.');
  }
  return link.toString();
}

async function fetchScheduleBytes(apiKey, timeoutMs = TIMEOUT_MS) {
  if (!apiKey) throw new Error('LTA_API_KEY is not configured.');
  const { bytes: sourceBytes } = await fetchBytes(
    GTFS_SCHEDULE_INDEX_URL,
    { headers: { AccountKey: apiKey, Accept: 'application/json, application/zip, application/octet-stream' } },
    { service: 'LTA GTFS Schedule index', timeoutMs },
  );
  const directEntries = base.unzipEntries(sourceBytes);
  if (directEntries.some(({ name }) => name.toLowerCase() === 'stops.txt') && directEntries.some(({ name }) => name.toLowerCase() === 'stop_times.txt')) {
    return sourceBytes;
  }
  const link = parseScheduleIndex(sourceBytes);
  const { bytes } = await fetchBytes(
    link,
    { headers: { Accept: 'application/zip, application/octet-stream' } },
    { service: 'LTA GTFS Schedule feed', timeoutMs },
  );
  return bytes;
}

async function loadSchedule(apiKey, timeoutMs = TIMEOUT_MS) {
  if (cachedSchedule && Date.now() - cachedAt < CACHE_MS) return cachedSchedule;
  if (!loadingSchedule) {
    loadingSchedule = fetchScheduleBytes(apiKey, timeoutMs)
      .then((bytes) => {
        cachedSchedule = base.parseScheduleBytes(bytes);
        cachedAt = Date.now();
        return cachedSchedule;
      })
      .finally(() => { loadingSchedule = null; });
  }
  return loadingSchedule;
}

module.exports = {
  ...base,
  GTFS_SCHEDULE_INDEX_URL,
  parseScheduleIndex,
  fetchScheduleBytes,
  loadSchedule,
  reset() { cachedSchedule = null; cachedAt = 0; loadingSchedule = null; base.reset(); },
};
