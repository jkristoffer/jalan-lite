
const { getOneMapToken } = require('./_onemap-auth');
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

    const token = await getOneMapToken();

    if (q) {
      const url = new URL('https://www.onemap.gov.sg/api/common/elastic/search');
      url.searchParams.set('searchVal', q);
      url.searchParams.set('returnGeom', 'Y');
      url.searchParams.set('getAddrDetails', 'Y');
      url.searchParams.set('pageNum', '1');
      const { data } = await fetchJson(
        url,
        { headers: { Authorization: token } },
        { service: 'OneMap search', validate: isSearchPayload },
      );
      const item = data.results[0];
      if (!item) return res.status(404).json({ error: 'No Singapore location found.' });
      const point = { lat: Number(item.LATITUDE), lng: Number(item.LONGITUDE) };
      if (!validPoint(point.lat, point.lng)) throw new Error('OneMap search returned an invalid location.');
      const label = [item.SEARCHVAL, item.ADDRESS].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' · ');
      return res.status(200).json({ label, point });
    }

    const url = new URL('https://www.onemap.gov.sg/api/public/revgeocode?location=' + encodeURIComponent(lat + ',' + lng) + '&buffer=80&addressType=All&otherFeatures=N');
    const { data } = await fetchJson(
      url,
      { headers: { Authorization: token } },
      { service: 'OneMap reverse geocode', validate: isReversePayload },
    );
    const item = data.GeocodeInfo.find((value) => !value.error);
    const label = item
      ? [item.BUILDINGNAME, item.BLOCK, item.ROAD, item.POSTALCODE].filter((value) => value && value !== 'NIL').join(' ').replace(/\s+/g, ' ').trim()
      : '';
    return res.status(200).json({ label: label || 'Pinned location', point: { lat, lng } });
  } catch (error) {
    return upstreamResponse(res, error, 'OneMap location lookup is temporarily unavailable.');
  }
};

module.exports._test = { isSearchPayload, isReversePayload };
