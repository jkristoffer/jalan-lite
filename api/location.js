const crypto = require('node:crypto');
const { withOneMapToken } = require('./_onemap-auth');
const { fetchJson, safeUpstreamFailure } = require('./_upstream');

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSearchPayload(value) {
  return isRecord(value) && Array.isArray(value.results) && value.results.every(isRecord);
}

function isReversePayload(value) {
  return isRecord(value) && Array.isArray(value.GeocodeInfo) && value.GeocodeInfo.every(isRecord);
}

function validPoint(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function textValue(value) {
  const text = String(value ?? '').trim();
  return text && text.toUpperCase() !== 'NIL' ? text : '';
}

function firstText(...values) {
  return values.map(textValue).find(Boolean) || '';
}

function uniqueParts(...values) {
  return values
    .map(textValue)
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function stableLocationId(item, { name, address, lat, lng }) {
  const upstreamId = firstText(
    item.id,
    item.ID,
    item.placeId,
    item.PLACE_ID,
    item.elasticId,
    item.ELASTIC_ID,
    item.uid,
    item.UID,
  );
  if (upstreamId) return 'onemap:' + upstreamId;

  const identity = [name, address, lat.toFixed(7), lng.toFixed(7)]
    .map((value) => value.trim().toLowerCase())
    .join('|');
  return 'onemap:' + crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

function normalizeSearchResult(item) {
  if (!isRecord(item)) return null;
  const latitudeValue = item.LATITUDE ?? item.latitude ?? item.lat;
  const longitudeValue = item.LONGITUDE ?? item.longitude ?? item.lng;
  const lat = String(latitudeValue ?? '').trim() ? Number(latitudeValue) : NaN;
  const lng = String(longitudeValue ?? '').trim() ? Number(longitudeValue) : NaN;
  if (!validPoint(lat, lng)) return null;

  const name = firstText(item.NAME, item.name, item.SEARCHVAL, item.searchVal, item.BUILDING, item.ROAD_NAME, item.ADDRESS)
    || 'Pinned location';
  const address = firstText(
    item.ADDRESS,
    item.address,
    [item.BLK_NO, item.ROAD_NAME, item.BUILDING, item.POSTAL]
      .map(textValue)
      .filter(Boolean)
      .join(' '),
  );
  const label = uniqueParts(name, address).join(' · ') || 'Pinned location';
  return {
    id: stableLocationId(item, { name, address, lat, lng }),
    name,
    address,
    lat,
    lng,
    label,
  };
}

function normalizeSearchResults(items) {
  const seen = new Set();
  return items.map(normalizeSearchResult).filter((item) => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function upstreamResponse(res, error, message) {
  if (error?.code === 'ONEMAP_NOT_CONFIGURED') {
    return res.status(503).json({ error: 'OneMap location lookup is not configured.' });
  }
  safeUpstreamFailure(error);
  return res.status(502).json({ error: message });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const q = String(req.query?.q || '').trim();
    const lat = Number(req.query?.lat);
    const lng = Number(req.query?.lng);

    if (!q && !(Number.isFinite(lat) && Number.isFinite(lng))) {
      return res.status(400).json({ error: 'Provide q or lat/lng.' });
    }

    if (q) {
      const url = new URL('https://www.onemap.gov.sg/api/common/elastic/search');
      url.searchParams.set('searchVal', q);
      url.searchParams.set('returnGeom', 'Y');
      url.searchParams.set('getAddrDetails', 'Y');
      url.searchParams.set('pageNum', '1');
      const { data } = await withOneMapToken((token) => fetchJson(
        url,
        { headers: { Authorization: token }, signal: req.signal },
        { service: 'OneMap search', validate: isSearchPayload },
      ), { signal: req.signal });
      const results = normalizeSearchResults(data.results);
      if (!data.results.length) return res.status(404).json({ error: 'No Singapore location found.' });
      if (!results.length) throw new Error('OneMap search returned an invalid location.');
      const first = results[0];
      const point = { lat: first.lat, lng: first.lng };
      return res.status(200).json({
        results,
        label: first.label,
        lat: first.lat,
        lng: first.lng,
        point,
      });
    }

    const url = new URL('https://www.onemap.gov.sg/api/public/revgeocode?location=' + encodeURIComponent(lat + ',' + lng) + '&buffer=80&addressType=All&otherFeatures=N');
    const { data } = await withOneMapToken((token) => fetchJson(
      url,
      { headers: { Authorization: token }, signal: req.signal },
      { service: 'OneMap reverse geocode', validate: isReversePayload },
    ), { signal: req.signal });
    const item = data.GeocodeInfo.find((value) => !value.error);
    const label = item
      ? [item.BUILDINGNAME, item.BLOCK, item.ROAD, item.POSTALCODE].filter((value) => value && value !== 'NIL').join(' ').replace(/\s+/g, ' ').trim()
      : '';
    return res.status(200).json({ label: label || 'Pinned location', lat, lng, point: { lat, lng } });
  } catch (error) {
    return upstreamResponse(res, error, 'OneMap location lookup is temporarily unavailable.');
  }
};

module.exports._test = {
  isSearchPayload,
  isReversePayload,
  normalizeSearchResult,
  normalizeSearchResults,
};
