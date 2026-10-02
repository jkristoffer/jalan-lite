(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JalanLiveStatus = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_FEED_AGE_MS = 90000;
  const CONNECTION_MARGIN_MS = 120000;

  function freshness(leg, now = Date.now()) {
    const updated = timestamp(leg?.liveUpdatedAt);
    if (!updated) return 'unknown';
    return now - updated > MAX_FEED_AGE_MS ? 'stale' : 'fresh';
  }

  function hasBusLive(leg, now = Date.now()) {
    return leg?.mode === 'BUS'
      && leg.liveStatus === 'ready'
      && freshness(leg, now) === 'fresh'
      && Array.isArray(leg.live?.arrivals)
      && leg.live.arrivals.some((value) => Number.isFinite(value));
  }

  function hasTrainLive(leg, now = Date.now()) {
    return leg?.mode === 'SUBWAY'
      && leg.trainStatus === 'ready'
      && freshness(leg, now) === 'fresh'
      && Boolean(leg.trainRealtime?.departureTime || leg.trainRealtime?.arrivalTime);
  }

  function statusForLeg(leg, now = Date.now()) {
    if (leg?.mode === 'WALK') return { key: 'route', label: 'Route', source: 'OneMap', tone: 'neutral', updatedAt: '' };

    if (leg?.mode === 'BUS') {
      if (leg.liveStatus === 'loading') return { key: 'checking', label: 'Checking', source: 'LTA', tone: 'checking', updatedAt: leg.liveUpdatedAt || '' };
      if (leg.liveStatus === 'error') return { key: 'fallback', label: 'Fallback', source: 'OneMap', tone: 'fallback', updatedAt: '' };
      if (leg.liveStatus === 'ready' && freshness(leg, now) === 'stale') return { key: 'stale', label: 'Stale', source: 'LTA', tone: 'fallback', updatedAt: leg.liveUpdatedAt || '' };
      if (hasBusLive(leg, now)) return { key: 'live', label: 'Live', source: 'LTA', tone: 'live', updatedAt: leg.liveUpdatedAt || '' };
      return { key: 'scheduled', label: 'Scheduled', source: 'OneMap', tone: 'scheduled', updatedAt: '' };
    }

    if (leg?.mode === 'SUBWAY') {
      if (leg.trainStatus === 'loading') return { key: 'checking', label: 'Checking', source: 'LTA GTFS-RT', tone: 'checking', updatedAt: leg.liveUpdatedAt || '' };
      if (leg.trainStatus === 'error') return { key: 'fallback', label: 'Fallback', source: 'OneMap', tone: 'fallback', updatedAt: '' };
      if (freshness(leg, now) === 'stale') return { key: 'stale', label: 'Stale', source: 'LTA GTFS-RT', tone: 'fallback', updatedAt: leg.liveUpdatedAt || '' };
      if (leg.trainRealtime?.alertText) return { key: 'alert', label: 'Alert', source: 'LTA GTFS-RT', tone: 'alert', updatedAt: leg.liveUpdatedAt || '' };
      if (hasTrainLive(leg, now)) return { key: 'live', label: 'Live', source: 'LTA GTFS-RT', tone: 'live', updatedAt: leg.liveUpdatedAt || '' };
      return { key: 'scheduled', label: 'Scheduled', source: 'OneMap', tone: 'scheduled', updatedAt: '' };
    }

    return { key: 'route', label: 'Route', source: 'OneMap', tone: 'neutral', updatedAt: '' };
  }

  function modeStatus(itinerary, mode, now = Date.now()) {
    const statuses = (itinerary?.legs || [])
      .filter((leg) => leg.mode === mode)
      .map((leg) => statusForLeg(leg, now));
    if (!statuses.length) return null;
    if (statuses.some((status) => status.key === 'stale')) return 'stale';
    if (statuses.some((status) => status.key === 'alert')) return 'alert';
    if (statuses.some((status) => status.key === 'checking')) return 'checking';
    if (statuses.some((status) => status.key === 'fallback')) return 'fallback';
    if (statuses.every((status) => status.key === 'live')) return 'live';
    if (statuses.some((status) => status.key === 'live')) return 'partial';
    return 'scheduled';
  }

  function summary(itinerary, now = Date.now()) {
    const statuses = (itinerary?.legs || [])
      .filter((leg) => ['BUS', 'SUBWAY'].includes(leg.mode))
      .map((leg) => statusForLeg(leg, now));
    if (!statuses.length) return { key: 'route', label: 'Route data', detail: 'Walking route from OneMap.', tone: 'neutral' };
    if (statuses.some((status) => status.key === 'stale')) return { key: 'stale', label: 'Stale live data', detail: 'The feed is over 90 seconds old. Refresh before relying on its arrivals; route timings are estimates.', tone: 'fallback' };
    if (statuses.some((status) => status.key === 'alert')) return { key: 'alert', label: 'Service alert', detail: 'Check the affected leg below.', tone: 'alert' };
    if (statuses.some((status) => status.key === 'checking')) return { key: 'checking', label: 'Checking live data', detail: 'LTA feeds are being checked now.', tone: 'checking' };
    if (statuses.some((status) => status.key === 'fallback')) return { key: 'fallback', label: 'Degraded live data', detail: 'OneMap schedule timings are shown where LTA data is unavailable.', tone: 'fallback' };
    if (statuses.every((status) => status.key === 'live')) return { key: 'live', label: 'Live data ready', detail: 'All transit legs have current LTA information. Overall arrival remains an estimate.', tone: 'live' };
    if (statuses.some((status) => status.key === 'live')) return { key: 'partial', label: 'Partly live', detail: 'Some legs are using OneMap schedule timings.', tone: 'scheduled' };
    return { key: 'scheduled', label: 'Scheduled timings', detail: 'Using OneMap schedule timings.', tone: 'scheduled' };
  }

  function timestamp(value) {
    if (!value) return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function reachableConnection(leg, reachAt, now = Date.now()) {
    const status = statusForLeg(leg, now);
    const base = { reachable: false, departureAt: null, waitMinutes: null, marginMs: CONNECTION_MARGIN_MS, status: status.key };
    const reach = timestamp(reachAt);
    if (!reach) return { ...base, reason: 'unknown-reach-time', label: 'Connection time unknown' };
    if (status.key !== 'live') return { ...base, reason: status.key, label: status.key === 'stale' ? 'Refresh stale arrivals' : 'Connection uses schedule estimates' };
    // BusArrival minute values are measured at liveUpdatedAt, not at the traveller's future arrival.
    const departures = leg.mode === 'BUS'
      ? leg.live.arrivals.filter((value) => Number.isFinite(value) && value >= 0)
        .map((minutes) => timestamp(leg.liveUpdatedAt) + minutes * 60000)
      : [timestamp(leg.trainRealtime?.departureTime)].filter(Boolean);
    const earliest = Math.max(now, reach) + CONNECTION_MARGIN_MS;
    const departureAt = departures.filter((time) => time >= earliest).sort((a, b) => a - b)[0];
    if (!departureAt) return { ...base, reason: 'no-reachable-arrival', label: 'No observed connection after you reach the stop' };
    return { ...base, reachable: true, departureAt, waitMinutes: Math.ceil((departureAt - Math.max(now, reach)) / 60000), reason: 'observed-reachable', label: 'Observed connection after you reach the stop' };
  }

  function ageLabel(value, now = Date.now()) {
    const updated = timestamp(value);
    if (!updated) return '';
    const seconds = Math.max(0, Math.floor((now - updated) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    return `${minutes} min ago`;
  }

  return { MAX_FEED_AGE_MS, CONNECTION_MARGIN_MS, freshness, hasBusLive, hasTrainLive, statusForLeg, modeStatus, summary, ageLabel, reachableConnection };
}));
