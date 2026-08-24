(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JalanLiveStatus = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function hasBusLive(leg) {
    return leg?.mode === 'BUS'
      && leg.liveStatus === 'ready'
      && Array.isArray(leg.live?.arrivals)
      && leg.live.arrivals.some((value) => Number.isFinite(value));
  }

  function hasTrainLive(leg) {
    return leg?.mode === 'SUBWAY'
      && leg.trainStatus === 'ready'
      && Boolean(leg.trainRealtime?.departureTime || leg.trainRealtime?.arrivalTime);
  }

  function statusForLeg(leg) {
    if (leg?.mode === 'WALK') return { key: 'route', label: 'Route', source: 'OneMap', tone: 'neutral', updatedAt: '' };

    if (leg?.mode === 'BUS') {
      if (leg.liveStatus === 'loading') return { key: 'checking', label: 'Checking', source: 'LTA', tone: 'checking', updatedAt: leg.liveUpdatedAt || '' };
      if (hasBusLive(leg)) return { key: 'live', label: 'Live', source: 'LTA', tone: 'live', updatedAt: leg.liveUpdatedAt || '' };
      if (leg.liveStatus === 'error') return { key: 'fallback', label: 'Fallback', source: 'OneMap', tone: 'fallback', updatedAt: '' };
      return { key: 'scheduled', label: 'Scheduled', source: 'OneMap', tone: 'scheduled', updatedAt: '' };
    }

    if (leg?.mode === 'SUBWAY') {
      if (leg.trainStatus === 'loading') return { key: 'checking', label: 'Checking', source: 'LTA GTFS-RT', tone: 'checking', updatedAt: leg.liveUpdatedAt || '' };
      if (leg.trainRealtime?.alertText) return { key: 'alert', label: 'Alert', source: 'LTA GTFS-RT', tone: 'alert', updatedAt: leg.liveUpdatedAt || '' };
      if (hasTrainLive(leg)) return { key: 'live', label: 'Live', source: 'LTA GTFS-RT', tone: 'live', updatedAt: leg.liveUpdatedAt || '' };
      if (leg.trainStatus === 'error') return { key: 'fallback', label: 'Fallback', source: 'OneMap', tone: 'fallback', updatedAt: '' };
      return { key: 'scheduled', label: 'Scheduled', source: 'OneMap', tone: 'scheduled', updatedAt: '' };
    }

    return { key: 'route', label: 'Route', source: 'OneMap', tone: 'neutral', updatedAt: '' };
  }

  function modeStatus(itinerary, mode) {
    const statuses = (itinerary?.legs || [])
      .filter((leg) => leg.mode === mode)
      .map(statusForLeg);
    if (!statuses.length) return null;
    if (statuses.some((status) => status.key === 'alert')) return 'alert';
    if (statuses.some((status) => status.key === 'checking')) return 'checking';
    if (statuses.some((status) => status.key === 'fallback')) return 'fallback';
    if (statuses.every((status) => status.key === 'live')) return 'live';
    if (statuses.some((status) => status.key === 'live')) return 'partial';
    return 'scheduled';
  }

  function summary(itinerary) {
    const statuses = (itinerary?.legs || [])
      .filter((leg) => ['BUS', 'SUBWAY'].includes(leg.mode))
      .map(statusForLeg);
    if (!statuses.length) return { key: 'route', label: 'Route data', detail: 'Walking route from OneMap.', tone: 'neutral' };
    if (statuses.some((status) => status.key === 'alert')) return { key: 'alert', label: 'Service alert', detail: 'Check the affected leg below.', tone: 'alert' };
    if (statuses.some((status) => status.key === 'checking')) return { key: 'checking', label: 'Checking live data', detail: 'LTA feeds are being checked now.', tone: 'checking' };
    if (statuses.some((status) => status.key === 'fallback')) return { key: 'fallback', label: 'Degraded live data', detail: 'OneMap schedule timings are shown where LTA data is unavailable.', tone: 'fallback' };
    if (statuses.every((status) => status.key === 'live')) return { key: 'live', label: 'Live data ready', detail: 'All transit legs have current LTA information.', tone: 'live' };
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

  function ageLabel(value, now = Date.now()) {
    const updated = timestamp(value);
    if (!updated) return '';
    const seconds = Math.max(0, Math.floor((now - updated) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    return `${minutes} min ago`;
  }

  return { hasBusLive, hasTrainLive, statusForLeg, modeStatus, summary, ageLabel };
}));
