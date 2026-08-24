(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JalanDisruptions = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const aliases = {
    NSL: ['NSL', 'NS', 'NORTHSOUTH', 'NORTHSOUTHLINE'],
    EWL: ['EWL', 'EW', 'EASTWEST', 'EASTWESTLINE'],
    NEL: ['NEL', 'NE', 'NORTHEAST', 'NORTHEASTLINE'],
    CCL: ['CCL', 'CC', 'CIRCLE', 'CIRCLELINE'],
    DTL: ['DTL', 'DT', 'DOWNTOWN', 'DOWNTOWNLINE'],
    TEL: ['TEL', 'TE', 'THOMSONEASTCOAST', 'THOMSONEASTCOASTLINE'],
    BPL: ['BPL', 'BP', 'BUKITPANJANG', 'BUKITPANJANGLRT'],
    SGL: ['SGL', 'SE', 'SENGKANG', 'SENGKANGLRT'],
    PGL: ['PGL', 'PE', 'PUNGGOL', 'PUNGGOLLRT'],
  };

  function lineKey(value) {
    const token = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return Object.entries(aliases).find(([, values]) => values.some((alias) => token === alias || token.includes(alias)))?.[0] || token;
  }

  function sameStop(left, right) {
    const a = String(left || '').toUpperCase();
    const b = String(right || '').toUpperCase();
    return Boolean(a && b && (a === b || a.endsWith(b) || b.endsWith(a)));
  }

  function alertMatchesLeg(leg, alert) {
    const selectors = alert?.selectors || [];
    if (!selectors.length) return true;
    const routeKey = lineKey(leg.routeName || leg.lineName);
    return selectors.some((selector) => {
      const routeMatch = selector.routeId && routeKey && lineKey(selector.routeId) === routeKey;
      const stopMatch = selector.stopId && (sameStop(selector.stopId, leg.fromId) || sameStop(selector.stopId, leg.toId));
      return routeMatch || stopMatch;
    });
  }

  function relevantAlerts(itinerary, payload) {
    const legs = (itinerary?.legs || []).filter((leg) => leg.mode === 'SUBWAY');
    const seen = new Set();
    return (payload?.alerts || [])
      .filter((alert) => legs.some((leg) => alertMatchesLeg(leg, alert)))
      .filter((alert) => {
        const key = alert.id || alert.header || alert.description;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3);
  }

  function isAffected(itinerary, alerts = itinerary?.liveAlerts || []) {
    return Boolean((itinerary?.legs || []).some((leg) => leg.mode === 'SUBWAY' && alerts.some((alert) => alertMatchesLeg(leg, alert))));
  }

  function unaffectedAlternatives(itinerary, alerts = []) {
    return (itinerary?.alternatives || [itinerary])
      .filter(Boolean)
      .filter((candidate) => !isAffected(candidate, alerts))
      .sort((left, right) => Number(left.duration || 0) - Number(right.duration || 0));
  }

  function bestUnblocked(itinerary, alerts = []) {
    return unaffectedAlternatives(itinerary, alerts)[0] || null;
  }

  function serviceLabel(itinerary) {
    const services = [...new Set((itinerary?.legs || [])
      .filter((leg) => ['BUS', 'SUBWAY'].includes(leg.mode))
      .map((leg) => leg.mode === 'SUBWAY' ? (leg.routeName || leg.lineName) : leg.routeName)
      .filter(Boolean))];
    return services.join(' + ') || 'an alternative service';
  }

  return { lineKey, sameStop, alertMatchesLeg, relevantAlerts, isAffected, unaffectedAlternatives, bestUnblocked, serviceLabel };
}));
