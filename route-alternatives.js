(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./route-live-status.js'), require('./route-disruptions.js'));
  else root.JalanRouteAlternatives = factory(root.JalanLiveStatus, root.JalanDisruptions);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (liveTools, disruptions) {
  function itinerarySignature(itinerary) {
    return (itinerary?.legs || []).map((leg) => [leg.mode, leg.routeName, leg.fromId || leg.fromName, leg.toId || leg.toName].join(':')).join('|');
  }

  function valueOrInfinity(value) {
    if (value === null || value === undefined || value === '') return Infinity;
    const number = Number(value);
    return Number.isFinite(number) ? number : Infinity;
  }

  function distinctOptions(itinerary) {
    const source = Array.isArray(itinerary?.alternatives) ? [itinerary, ...itinerary.alternatives] : [itinerary];
    const distinct = [];
    const seen = new Set();
    source.filter(Boolean).forEach((item) => {
      const signature = itinerarySignature(item);
      if (!signature || seen.has(signature)) return;
      seen.add(signature);
      distinct.push(item);
    });

    return distinct;
  }

  function comparisonMetrics(itinerary, now = Date.now()) {
    const transit = (itinerary?.legs || []).filter((leg) => ['BUS', 'SUBWAY'].includes(leg.mode));
    const duration = valueOrInfinity(itinerary?.duration);
    const walking = valueOrInfinity(itinerary?.walkDuration);
    const explicitTransfers = valueOrInfinity(itinerary?.transfers);
    const transfers = explicitTransfers === Infinity ? Math.max(0, transit.length - 1) : explicitTransfers;
    const endTime = Number(itinerary?.endTime);
    const startTime = Number(itinerary?.startTime);
    const arrivalAt = Number.isFinite(endTime) && endTime > 0 ? (endTime < 1e12 ? endTime * 1000 : endTime)
      : Number.isFinite(duration) ? (Number.isFinite(startTime) && startTime > 0 ? (startTime < 1e12 ? startTime * 1000 : startTime) : now) + duration * 1000 : null;
    const status = liveTools.summary(itinerary, now);
    return { arrivalAt, duration: Number.isFinite(duration) ? duration : null,
      walking: Number.isFinite(walking) ? walking : null, transfers,
      confidence: status.key, confidenceLabel: status.label };
  }

  function alternativeOptions(itinerary, now = Date.now()) {
    const distinct = distinctOptions(itinerary);
    const metrics = new Map(distinct.map((item) => [item, comparisonMetrics(item, now)]));
    const fastest = [...distinct].sort((a, b) => valueOrInfinity(a.duration) - valueOrInfinity(b.duration))[0];
    if (!fastest) return [];
    const selected = [{ key: 'fastest', label: 'Fastest', itinerary: fastest, metrics: metrics.get(fastest) }];
    const fewerTransfers = distinct.filter((item) => metrics.get(item).transfers < metrics.get(fastest).transfers)
      .sort((a, b) => metrics.get(a).transfers - metrics.get(b).transfers || valueOrInfinity(a.duration) - valueOrInfinity(b.duration))[0];
    if (fewerTransfers) selected.push({ key: 'transfers', label: 'Fewer transfers', itinerary: fewerTransfers, metrics: metrics.get(fewerTransfers) });
    const leastWalking = Math.min(...selected.map((option) => valueOrInfinity(option.metrics.walking)));
    const walking = distinct.filter((item) => !selected.some((option) => option.itinerary === item)
      && valueOrInfinity(metrics.get(item).walking) < leastWalking)
      .sort((a, b) => valueOrInfinity(metrics.get(a).walking) - valueOrInfinity(metrics.get(b).walking)
        || valueOrInfinity(a.duration) - valueOrInfinity(b.duration))[0];
    if (walking) selected.push({ key: 'walking', label: 'Less walking', itinerary: walking, metrics: metrics.get(walking) });
    return selected;
  }

  function preferredRoute(itinerary, { usualSignature = '', alerts = itinerary?.liveAlerts || [], now = Date.now() } = {}) {
    const distinct = distinctOptions(itinerary);
    const usual = distinct.find((item) => itinerarySignature(item) === usualSignature);
    const unaffected = distinct.filter((item) => !disruptions.isAffected(item, alerts))
      .sort((a, b) => valueOrInfinity(a.duration) - valueOrInfinity(b.duration));
    if (usual && !disruptions.isAffected(usual, alerts)) return { itinerary: usual, usingUsual: true,
      reason: 'usual', label: 'Your usual route', detail: 'Your saved route is available without a reported disruption.', metrics: comparisonMetrics(usual, now) };
    const candidate = unaffected[0];
    if (!candidate) return { itinerary: null, usingUsual: false, reason: 'all-affected', label: 'No unaffected route', detail: 'All returned routes have a reported disruption. Keep your current route until you confirm a replacement.', metrics: null };
    const reason = usual ? 'usual-affected' : usualSignature ? 'usual-unavailable' : 'fastest';
    return { itinerary: candidate, usingUsual: false, reason, label: reason === 'fastest' ? 'Fastest route' : 'Suggested alternative',
      detail: reason === 'usual-affected' ? 'Your usual route is affected. This is the fastest returned route without a reported disruption.'
        : reason === 'usual-unavailable' ? 'Your usual route was not returned. This is the fastest available route without a reported disruption.'
          : 'The fastest returned route without a reported disruption.', metrics: comparisonMetrics(candidate, now) };
  }

  return { itinerarySignature, comparisonMetrics, alternativeOptions, preferredRoute };
}));
