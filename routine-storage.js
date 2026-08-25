(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JalanRoutines = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VERSION = 1;
  const STORAGE_KEYS = Object.freeze({
    routines: 'jalan-lite-routines-v1',
    presets: 'jalan-lite-presets-v1',
    routes: 'jalan-lite-routes-v1',
    pushSubscription: 'jalan-lite-push-subscription-v1',
  });

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function asText(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
  }

  function validTime(value) {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
    const [hours, minutes] = value.split(':').map(Number);
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
  }

  function normalizeTime(value) {
    return validTime(value) ? value : null;
  }

  function normalizeDays(value, { nullable = false } = {}) {
    if (value === null && nullable) return null;
    if (!Array.isArray(value)) return nullable ? null : [];
    return [...new Set(value.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((left, right) => left - right);
  }

  function normalizePoint(value) {
    if (!isObject(value)) return null;
    const lat = Number(value.lat);
    const lng = Number(value.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }

  function normalizeSchedule(value = {}) {
    const source = isObject(value) ? value : {};
    const days = normalizeDays(source.days, { nullable: true });
    const departureTime = normalizeTime(source.departureTime);
    const timeMode = source.timeMode === 'arrive' ? 'arrive' : 'depart';
    return {
      days,
      startTime: normalizeTime(source.startTime),
      endTime: normalizeTime(source.endTime),
      departureTime,
      timeMode,
    };
  }

  function normalizeNotifications(value = {}) {
    const source = isObject(value) ? value : {};
    return {
      disruptionAlerts: Boolean(source.disruptionAlerts),
      routeAlerts: Boolean(source.routeAlerts),
    };
  }

  function normalizeBus(value) {
    if (!isObject(value) || !/^\d{5}$/.test(asText(value.stopCode))) return null;
    const services = Array.isArray(value.services)
      ? [...new Set(value.services.map(asText).filter(Boolean))]
      : [];
    if (!services.length) return null;
    return {
      stopCode: asText(value.stopCode),
      stopName: asText(value.stopName) || `Bus stop ${asText(value.stopCode)}`,
      services,
    };
  }

  function normalizeRoute(value) {
    if (!isObject(value)) return null;
    const origin = asText(value.origin);
    const destination = asText(value.destination);
    if (!origin || !destination) return null;
    return {
      origin,
      destination,
      originPoint: normalizePoint(value.originPoint),
      destinationPoint: normalizePoint(value.destinationPoint),
    };
  }

  function normalizeLegacy(value = {}) {
    const source = isObject(value) ? value : {};
    const legacy = isObject(source.legacy) ? source.legacy : null;
    return legacy && asText(legacy.key) && asText(legacy.id)
      ? { key: asText(legacy.key), id: asText(legacy.id) }
      : null;
  }

  function normalizeRoutine(value) {
    if (!isObject(value) || !['route', 'bus'].includes(value.type)) return null;
    const id = asText(value.id);
    const name = asText(value.name);
    if (!id || !name) return null;
    const route = value.type === 'route' ? normalizeRoute(value.route) : null;
    const bus = value.type === 'bus' ? normalizeBus(value.bus) : null;
    if (value.type === 'route' && !route) return null;
    if (value.type === 'bus' && !bus) return null;
    return {
      id,
      type: value.type,
      name,
      homeWorkLabel: ['home', 'work'].includes(value.homeWorkLabel) ? value.homeWorkLabel : null,
      schedule: normalizeSchedule(value.schedule),
      route,
      bus,
      notifications: normalizeNotifications(value.notifications),
      legacy: normalizeLegacy(value),
    };
  }

  function routineFromBusPreset(value) {
    const source = isObject(value) ? value : {};
    const id = asText(source.id);
    const bus = normalizeBus(source);
    if (!id || !bus) return null;
    return normalizeRoutine({
      id: `bus:${id}`,
      type: 'bus',
      name: asText(source.name) || 'Bus commute',
      schedule: {
        days: normalizeDays(source.days),
        startTime: source.startTime,
        endTime: source.endTime,
        timeMode: 'depart',
      },
      bus,
      notifications: source.notifications,
      legacy: { key: STORAGE_KEYS.presets, id },
    });
  }

  function busPresetFromRoutine(value) {
    const routine = normalizeRoutine(value);
    if (!routine || routine.type !== 'bus') return null;
    const id = routine.legacy?.key === STORAGE_KEYS.presets && routine.legacy.id
      ? routine.legacy.id
      : routine.id.replace(/^bus:/, '') || routine.id;
    return {
      id,
      name: routine.name,
      stopCode: routine.bus.stopCode,
      stopName: routine.bus.stopName,
      services: [...routine.bus.services],
      days: Array.isArray(routine.schedule.days) ? [...routine.schedule.days] : [1, 2, 3, 4, 5],
      startTime: routine.schedule.startTime || '07:30',
      endTime: routine.schedule.endTime || '09:00',
    };
  }

  function routineFromRoute(value) {
    const source = isObject(value) ? value : {};
    const id = asText(source.id) || 'route-1';
    const route = normalizeRoute(source);
    if (!route) return null;
    return normalizeRoutine({
      id: `route:${id}`,
      type: 'route',
      name: asText(source.name) || 'Saved commute',
      schedule: {
        departureTime: source.departureTime,
        timeMode: source.timeMode,
      },
      route,
      notifications: source.notifications,
      legacy: { key: STORAGE_KEYS.routes, id },
    });
  }

  function routeFromRoutine(value) {
    const routine = normalizeRoutine(value);
    if (!routine || routine.type !== 'route') return null;
    const id = routine.legacy?.key === STORAGE_KEYS.routes && routine.legacy.id
      ? routine.legacy.id
      : routine.id.replace(/^route:/, '') || routine.id;
    return {
      id,
      name: routine.name,
      ...routine.route,
      departureTime: routine.schedule.departureTime || '08:30',
      timeMode: routine.schedule.timeMode,
    };
  }

  function createEnvelope(routines = []) {
    const normalized = Array.isArray(routines)
      ? routines.map(normalizeRoutine).filter(Boolean)
      : [];
    return { version: VERSION, routines: normalized };
  }

  function normalizeEnvelope(value) {
    if (!isObject(value) || value.version !== VERSION || !Array.isArray(value.routines)) return null;
    return createEnvelope(value.routines);
  }

  function defaultStorage() {
    try {
      return typeof globalThis !== 'undefined' && globalThis.localStorage ? globalThis.localStorage : null;
    } catch {
      return null;
    }
  }

  function readJson(storage, key) {
    if (!storage || typeof storage.getItem !== 'function') return { found: false, valid: false, value: null };
    try {
      const raw = storage.getItem(key);
      if (raw === null) return { found: false, valid: false, value: null };
      try {
        return { found: true, valid: true, value: JSON.parse(raw) };
      } catch {
        return { found: true, valid: false, value: null };
      }
    } catch {
      return { found: false, valid: false, value: null };
    }
  }

  function legacyBusRoutines(storage) {
    const stored = readJson(storage, STORAGE_KEYS.presets);
    if (!stored.valid || !Array.isArray(stored.value)) return [];
    return stored.value.map(routineFromBusPreset).filter(Boolean);
  }

  function legacyRouteRoutines(storage) {
    const stored = readJson(storage, STORAGE_KEYS.routes);
    if (!stored.valid) return [];
    return [routineFromRoute(stored.value)].filter(Boolean);
  }

  function readLegacy(storage) {
    return [...legacyRouteRoutines(storage), ...legacyBusRoutines(storage)];
  }

  function load(storage = defaultStorage()) {
    const stored = readJson(storage, STORAGE_KEYS.routines);
    if (stored.found && stored.valid) {
      const envelope = normalizeEnvelope(stored.value);
      if (envelope) return { ...envelope, source: 'routines', needsMigration: false, invalidStoredValue: false };
    }
    const routines = readLegacy(storage);
    return {
      ...createEnvelope(routines),
      source: routines.length ? 'legacy' : 'empty',
      needsMigration: routines.length > 0,
      invalidStoredValue: stored.found,
    };
  }

  function save(routines, storage = defaultStorage()) {
    const envelope = createEnvelope(routines);
    if (!storage || typeof storage.setItem !== 'function') return { ok: false, ...envelope };
    try {
      storage.setItem(STORAGE_KEYS.routines, JSON.stringify(envelope));
      return { ok: true, ...envelope };
    } catch {
      return { ok: false, ...envelope };
    }
  }

  return {
    VERSION,
    STORAGE_KEYS,
    createEnvelope,
    normalizeEnvelope,
    normalizeRoutine,
    routineFromBusPreset,
    busPresetFromRoutine,
    routineFromRoute,
    routeFromRoutine,
    readLegacy,
    load,
    save,
  };
}));
