(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JalanJourney = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STORAGE_KEY = 'jalan-lite-journey-session-v1';
  const phases = ['ready', 'walking', 'waiting', 'riding', 'arriving', 'complete'];
  const signature = (itinerary) => (itinerary?.legs || []).map((leg) => [leg.mode, leg.routeName, leg.fromId || leg.fromName, leg.toId || leg.toName].join(':')).join('|');
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function snapshot(itinerary) {
    if (!Array.isArray(itinerary?.legs) || !itinerary.legs.length
      || itinerary.legs.some((leg) => !['WALK', 'BUS', 'SUBWAY'].includes(leg?.mode))) return null;
    const { alternatives, ...route } = itinerary;
    return clone(route);
  }
  function point(value, name = '') {
    const source = value?.point || value;
    const lat = source?.lat == null ? NaN : Number(source.lat), lng = source?.lng == null ? NaN : Number(source.lng);
    return { name: value?.name || (typeof value === 'string' ? value : name),
      ...(Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 ? { lat, lng } : {}) };
  }
  const legPoint = (leg, side) => point(leg?.[`${side}Point`], leg?.[`${side}Name`] || '');
  const phaseFor = (leg) => leg?.mode === 'WALK' ? 'walking' : 'waiting';
  function create({ occurrenceId, itinerary, origin, destination, plan } = {}, now = Date.now()) {
    const route = snapshot(itinerary);
    if (typeof occurrenceId !== 'string' || !occurrenceId || !route) return null;
    return { version: 1, occurrenceId, itinerary: route, routeSignature: signature(route),
      origin: origin == null ? legPoint(route.legs[0], 'from') : clone(origin),
      destination: destination == null ? legPoint(route.legs.at(-1), 'to') : clone(destination),
      plan: plan == null ? null : clone(plan), phase: 'ready', legIndex: 0,
      startedAt: null, updatedAt: now, lastConfirmedAt: null,
      lastConfirmedPoint: point(origin || legPoint(route.legs[0], 'from')) };
  }
  function start(input, now = Date.now()) {
    const session = input?.version === 1 ? normalize(input) : create(input, now);
    if (!session || session.phase !== 'ready') return session;
    return { ...session, phase: phaseFor(session.itinerary.legs[0]), startedAt: now,
      updatedAt: now, lastConfirmedAt: now };
  }
  function normalize(value) {
    if (!value || value.version !== 1 || typeof value.occurrenceId !== 'string' || !value.occurrenceId
      || !phases.includes(value.phase) || !Number.isInteger(value.legIndex)) return null;
    const route = snapshot(value.itinerary);
    if (!route || value.routeSignature !== signature(route) || value.legIndex < 0 || value.legIndex >= route.legs.length) return null;
    const leg = route.legs[value.legIndex];
    if (value.phase === 'walking' && leg.mode !== 'WALK') return null;
    if (['waiting', 'riding'].includes(value.phase) && leg.mode === 'WALK') return null;
    if (['arriving', 'complete'].includes(value.phase) && value.legIndex !== route.legs.length - 1) return null;
    return clone({ ...value, itinerary: route });
  }
  function advance(session, itinerary = session?.itinerary, now = Date.now()) {
    if (!normalize(session) || signature(itinerary) !== session.routeSignature) return session;
    if (session.phase === 'ready') return start(session, now);
    if (session.phase === 'complete') return session;
    const leg = session.itinerary.legs[session.legIndex];
    const next = { ...session, updatedAt: now, lastConfirmedAt: now };
    if (session.phase === 'waiting') return { ...next, phase: 'riding', lastConfirmedPoint: legPoint(leg, 'from') };
    if (session.phase === 'arriving') return { ...next, phase: 'complete', lastConfirmedPoint: point(session.destination || legPoint(leg, 'to')) };
    next.lastConfirmedPoint = legPoint(leg, 'to');
    if (session.legIndex === session.itinerary.legs.length - 1) return { ...next, phase: 'arriving' };
    next.legIndex += 1;
    next.phase = phaseFor(session.itinerary.legs[next.legIndex]);
    return next;
  }
  function guidance(session, itinerary = session?.itinerary, now = Date.now()) {
    if (!normalize(session)) return null;
    const base = { legIndex: session.legIndex, phase: session.phase, lastConfirmedPoint: session.lastConfirmedPoint };
    if (signature(itinerary) !== session.routeSignature) return { ...base, action: 'confirm-route', label: 'Confirm route change', detail: 'Your confirmed journey stays on the previous route until you accept a replacement.' };
    const leg = itinerary.legs[session.legIndex];
    const service = leg.routeName || leg.lineName || (leg.mode === 'SUBWAY' ? 'the train' : 'the bus');
    const destination = leg.toName || session.destination?.name || session.destination || 'your destination';
    const actions = {
      ready: ['confirm-departure', 'Ready to leave', 'Confirm when you leave.', 'Start journey'],
      walking: ['confirm-walk', `Walk to ${destination}`, `Confirm when you reach ${destination}.`, `Reached ${destination}`],
      waiting: ['confirm-board', `Wait for ${service}`, `Wait at ${leg.fromName || 'the stop'}. Confirm after boarding.`, `Boarded ${service}`],
      riding: ['confirm-alight', `Ride ${service} to ${destination}`, 'Confirm after alighting.', `Alighted at ${destination}`],
      arriving: ['confirm-arrival', 'At your destination?', 'Confirm when you have reached your destination.', 'Confirm arrival'],
      complete: ['complete', 'Journey complete', 'Arrival confirmed.', 'Journey complete'],
    };
    const [action, label, detail, confirmationLabel] = actions[session.phase];
    return { ...base, action, label, detail, confirmationLabel };
  }
  function replaceRoute(session, itinerary, { confirmed = false, confirmedOrigin = null, now = Date.now(), plan = session?.plan } = {}) {
    const route = snapshot(itinerary);
    if (!confirmed || !normalize(session) || !route || session.phase === 'complete') return session;
    // A replacement must begin at a point the traveller has actually confirmed.
    const from = legPoint(route.legs[0], 'from'), last = confirmedOrigin ? point(confirmedOrigin) : session.lastConfirmedPoint;
    const explicitOrigin = confirmedOrigin && Number.isFinite(last.lat) && Number.isFinite(last.lng);
    if (confirmedOrigin && !explicitOrigin) return session;
    const sameCoordinates = Number.isFinite(last?.lat) && Number.isFinite(last?.lng)
      && Number.isFinite(from.lat) && Number.isFinite(from.lng)
      && Math.abs(last.lat - from.lat) < 0.0001 && Math.abs(last.lng - from.lng) < 0.0001;
    const sameName = last?.name && last.name === from.name;
    if (!explicitOrigin && !sameCoordinates && !sameName) return session;
    return { ...session, itinerary: route, routeSignature: signature(route), plan: plan == null ? null : clone(plan),
      origin: clone(last), lastConfirmedPoint: clone(last), lastConfirmedAt: explicitOrigin ? now : session.lastConfirmedAt,
      legIndex: 0, phase: session.phase === 'ready' ? 'ready' : phaseFor(route.legs[0]), updatedAt: now };
  }
  function storageOrDefault(storage) {
    if (storage) return storage;
    try { return globalThis.sessionStorage; } catch { return null; }
  }
  function save(session, storage) {
    try {
      const valid = normalize(session), target = storageOrDefault(storage);
      if (!valid) return { ok: false, error: 'Invalid journey session.' };
      if (!target) return { ok: false, error: 'Journey storage is unavailable.' };
      target.setItem(STORAGE_KEY, JSON.stringify(valid));
      return { ok: true };
    } catch { return { ok: false, error: 'Journey storage is unavailable.' }; }
  }
  function load(storage) {
    try { return normalize(JSON.parse(storageOrDefault(storage)?.getItem(STORAGE_KEY) || 'null')); }
    catch { return null; }
  }
  function clear(storage) {
    try { storageOrDefault(storage)?.removeItem(STORAGE_KEY); return true; } catch { return false; }
  }
  return { STORAGE_KEY, create, start, advance, guidance, progress: guidance, replaceRoute, load, save, clear };
}));
