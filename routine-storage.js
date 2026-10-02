(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JalanRoutines = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Version 1 is kept readable so existing users can be moved without touching
  // either of the old records. New writes always use the v2 key.
  const VERSION = 2;
  const STORAGE_KEYS = Object.freeze({
    routines: 'jalan-lite-routines-v2',
    routinesV2: 'jalan-lite-routines-v2',
    routinesV1: 'jalan-lite-routines-v1',
    routinesLegacy: 'jalan-lite-routines-v1',
    presets: 'jalan-lite-presets-v1',
    routes: 'jalan-lite-routes-v1',
    pushSubscription: 'jalan-lite-push-subscription-v1',
  });

  const LEGACY_UNIFIED_KEY = STORAGE_KEYS.routinesV1;

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
    return [...new Set(value
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
      .sort((left, right) => left - right);
  }

  function normalizePoint(value) {
    if (!isObject(value)) return null;
    const lat = Number(value.lat);
    const lng = Number(value.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }

  function validDateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const timestamp = Date.UTC(year, month - 1, day);
    const date = new Date(timestamp);
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  function normalizeExceptions(value) {
    if (!isObject(value)) return {};
    const exceptions = {};
    Object.keys(value).sort().forEach((date) => {
      if (!validDateKey(date) || !isObject(value[date])) return;
      const source = value[date];
      if (source.skip === true) {
        exceptions[date] = { skip: true };
        return;
      }
      const departureTime = normalizeTime(source.departureTime ?? source.time);
      if (!departureTime) return;
      exceptions[date] = {
        departureTime,
        timeMode: source.timeMode === 'arrive' ? 'arrive' : 'depart',
      };
    });
    return exceptions;
  }

  function normalizeSchedule(value = {}) {
    const source = isObject(value) ? value : {};
    const days = normalizeDays(source.days, { nullable: true });
    const departureTime = normalizeTime(source.departureTime);
    const timeMode = source.timeMode === 'arrive' ? 'arrive' : 'depart';
    const schedule = {
      days,
      startTime: normalizeTime(source.startTime),
      endTime: normalizeTime(source.endTime),
      departureTime,
      timeMode,
    };
    if (Object.prototype.hasOwnProperty.call(source, 'exceptions')) {
      schedule.exceptions = normalizeExceptions(source.exceptions);
    }
    return schedule;
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

  function normalizedRouteExtras(source, fallback = {}) {
    const value = isObject(source) ? source : {};
    const backup = isObject(fallback) ? fallback : {};
    const extras = {};
    const signature = asText(value.usualRouteSignature) || asText(backup.usualRouteSignature);
    const linkedRoutineId = asText(value.linkedRoutineId) || asText(backup.linkedRoutineId);
    const hasDays = Object.prototype.hasOwnProperty.call(value, 'days')
      || Object.prototype.hasOwnProperty.call(backup, 'days');
    if (hasDays) {
      const days = Object.prototype.hasOwnProperty.call(value, 'days') ? value.days : backup.days;
      extras.days = normalizeDays(days, { nullable: true });
    }
    if (signature) extras.usualRouteSignature = signature;
    if (linkedRoutineId) extras.linkedRoutineId = linkedRoutineId;
    if (Object.prototype.hasOwnProperty.call(value, 'exceptions')
      || Object.prototype.hasOwnProperty.call(backup, 'exceptions')) {
      extras.exceptions = normalizeExceptions(
        Object.prototype.hasOwnProperty.call(value, 'exceptions') ? value.exceptions : backup.exceptions,
      );
    }
    return extras;
  }

  function normalizeRoute(value) {
    if (!isObject(value)) return null;
    const origin = asText(value.origin);
    const destination = asText(value.destination);
    if (!origin || !destination) return null;
    const route = {
      origin,
      destination,
      originPoint: normalizePoint(value.originPoint),
      destinationPoint: normalizePoint(value.destinationPoint),
    };
    return route;
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

    const scheduleSource = isObject(value.schedule) ? value.schedule : {};
    const schedule = normalizeSchedule(scheduleSource);
    const routine = {
      id,
      type: value.type,
      name,
      homeWorkLabel: ['home', 'work'].includes(value.homeWorkLabel) ? value.homeWorkLabel : null,
      schedule,
      route,
      bus,
      notifications: normalizeNotifications(value.notifications),
      legacy: normalizeLegacy(value),
    };

    if (value.type === 'route') {
      const extras = normalizedRouteExtras(value, value.route);
      // A route's recurring days live in schedule for the unified shape. The
      // flattened fields remain available on the route record below.
      if (Object.prototype.hasOwnProperty.call(value, 'days') && !Object.prototype.hasOwnProperty.call(scheduleSource, 'days')) {
        schedule.days = normalizeDays(value.days, { nullable: true });
      }
      if (Object.prototype.hasOwnProperty.call(value, 'exceptions')) routine.exceptions = normalizeExceptions(value.exceptions);
      else if (Object.prototype.hasOwnProperty.call(scheduleSource, 'exceptions')) routine.exceptions = normalizeExceptions(scheduleSource.exceptions);
      else if (Object.prototype.hasOwnProperty.call(value.route || {}, 'exceptions')) routine.exceptions = normalizeExceptions(value.route.exceptions);
      if (extras.usualRouteSignature) routine.usualRouteSignature = extras.usualRouteSignature;
      if (extras.linkedRoutineId) routine.linkedRoutineId = extras.linkedRoutineId;
      if (extras.days !== undefined && !Object.prototype.hasOwnProperty.call(scheduleSource, 'days')) schedule.days = extras.days;
    }
    return routine;
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
      homeWorkLabel: source.homeWorkLabel,
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
    const preset = {
      id,
      name: routine.name,
      stopCode: routine.bus.stopCode,
      stopName: routine.bus.stopName,
      services: [...routine.bus.services],
      days: Array.isArray(routine.schedule.days) ? [...routine.schedule.days] : [1, 2, 3, 4, 5],
      startTime: routine.schedule.startTime || '07:30',
      endTime: routine.schedule.endTime || '09:00',
    };
    if (routine.homeWorkLabel) preset.homeWorkLabel = routine.homeWorkLabel;
    if (routine.notifications.disruptionAlerts || routine.notifications.routeAlerts) {
      preset.notifications = { ...routine.notifications };
    }
    return preset;
  }

  function routineFromRoute(value) {
    const source = isObject(value) ? value : {};
    const id = asText(source.id) || 'route-1';
    const route = normalizeRoute(source);
    if (!route) return null;
    const days = Object.prototype.hasOwnProperty.call(source, 'days')
      ? normalizeDays(source.days, { nullable: true })
      : null;
    const exceptions = Object.prototype.hasOwnProperty.call(source, 'exceptions')
      ? normalizeExceptions(source.exceptions)
      : {};
    return normalizeRoutine({
      id: `route:${id}`,
      type: 'route',
      name: asText(source.name) || 'Saved commute',
      homeWorkLabel: source.homeWorkLabel,
      schedule: {
        days,
        departureTime: source.departureTime,
        timeMode: source.timeMode,
        exceptions,
      },
      route,
      usualRouteSignature: source.usualRouteSignature,
      linkedRoutineId: source.linkedRoutineId,
      exceptions,
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
    const exceptions = normalizeExceptions(
      routine.exceptions
      || routine.schedule.exceptions
      || routine.route?.exceptions,
    );
    const route = {
      id,
      name: routine.name,
      ...routine.route,
      days: Array.isArray(routine.schedule.days) ? [...routine.schedule.days] : null,
      departureTime: routine.schedule.departureTime || '08:30',
      timeMode: routine.schedule.timeMode,
      usualRouteSignature: routine.usualRouteSignature || routine.route?.usualRouteSignature || '',
      linkedRoutineId: routine.linkedRoutineId || routine.route?.linkedRoutineId || null,
      exceptions,
    };
    if (routine.homeWorkLabel) route.homeWorkLabel = routine.homeWorkLabel;
    if (routine.notifications.disruptionAlerts || routine.notifications.routeAlerts) {
      route.notifications = { ...routine.notifications };
    }
    return route;
  }

  function createReturnRoutine(value, options = {}) {
    const routine = normalizeRoutine(value);
    if (!routine || routine.type !== 'route') return null;
    const sourceRoute = routine.route;
    const id = asText(options.id) || `${routine.id}:return`;
    const schedule = isObject(options.schedule)
      ? options.schedule
      : {
        // A return trip normally needs its own time choice. Keep the recurring
        // days, but leave the time blank until the UI asks for it.
        days: routine.schedule.days,
        departureTime: null,
        timeMode: 'depart',
      };
    const homeWorkLabel = options.homeWorkLabel
      || (routine.homeWorkLabel === 'home' ? 'work' : routine.homeWorkLabel === 'work' ? 'home' : null);
    return normalizeRoutine({
      id,
      type: 'route',
      name: asText(options.name) || `${routine.name} return`,
      homeWorkLabel,
      schedule,
      route: {
        origin: sourceRoute.destination,
        destination: sourceRoute.origin,
        originPoint: sourceRoute.destinationPoint,
        destinationPoint: sourceRoute.originPoint,
      },
      usualRouteSignature: options.usualRouteSignature,
      linkedRoutineId: asText(options.linkedRoutineId) || routine.id,
      exceptions: options.exceptions || {},
      notifications: options.notifications || routine.notifications,
    });
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

  function normalizeLegacyEnvelope(value) {
    if (!isObject(value) || value.version !== 1 || !Array.isArray(value.routines)) return null;
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
    if (!storage || typeof storage.getItem !== 'function') return { found: false, valid: false, value: null, raw: null };
    try {
      const raw = storage.getItem(key);
      if (raw === null) return { found: false, valid: false, value: null, raw: null };
      try {
        return { found: true, valid: true, value: JSON.parse(raw), raw: String(raw) };
      } catch {
        return { found: true, valid: false, value: null, raw: String(raw) };
      }
    } catch {
      return { found: false, valid: false, value: null, raw: null };
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
    if (Array.isArray(stored.value)) return stored.value.map(routineFromRoute).filter(Boolean);
    return [routineFromRoute(stored.value)].filter(Boolean);
  }

  function readLegacy(storage) {
    return [...legacyRouteRoutines(storage), ...legacyBusRoutines(storage)];
  }

  function restoreRaw(storage, key, previous) {
    try {
      if (previous.found && typeof storage.setItem === 'function') storage.setItem(key, previous.raw);
      else if (!previous.found && typeof storage.removeItem === 'function') storage.removeItem(key);
    } catch {
      // There is no stronger rollback operation available on Storage.
    }
  }

  function writeAndVerify(envelope, storage) {
    if (!storage || typeof storage.setItem !== 'function' || typeof storage.getItem !== 'function') {
      return { ok: false, error: 'storage-unavailable' };
    }
    const key = STORAGE_KEYS.routines;
    const previous = readJson(storage, key);
    const serialized = JSON.stringify(envelope);
    try {
      storage.setItem(key, serialized);
      const stored = readJson(storage, key);
      const verified = stored.valid ? normalizeEnvelope(stored.value) : null;
      if (!verified || JSON.stringify(verified) !== serialized) throw new Error('storage-verification-failed');
      return { ok: true };
    } catch (error) {
      restoreRaw(storage, key, previous);
      return { ok: false, error: error?.message || 'storage-write-failed' };
    }
  }

  function migrationSource(storage, current = null) {
    const inlineLegacyEnvelope = current?.valid ? normalizeLegacyEnvelope(current.value) : null;
    if (inlineLegacyEnvelope) return { envelope: inlineLegacyEnvelope, source: 'routines-v1', found: true };
    const unified = readJson(storage, LEGACY_UNIFIED_KEY);
    const unifiedEnvelope = unified.valid ? normalizeLegacyEnvelope(unified.value) : null;
    if (unifiedEnvelope) return { envelope: unifiedEnvelope, source: 'routines-v1', found: true };

    const route = readJson(storage, STORAGE_KEYS.routes);
    const presets = readJson(storage, STORAGE_KEYS.presets);
    const routines = [
      ...legacyRouteRoutines(storage),
      ...legacyBusRoutines(storage),
    ];
    const found = route.found || presets.found || unified.found;
    const validLegacyRecord = (route.found && route.valid) || (presets.found && presets.valid);
    if (!found) return { envelope: null, source: 'empty', found: false };
    if (!validLegacyRecord && !routines.length) return { envelope: null, source: 'empty', found: true };
    return { envelope: createEnvelope(routines), source: 'legacy', found: true };
  }

  function migrate(storage = defaultStorage()) {
    const current = readJson(storage, STORAGE_KEYS.routines);
    const currentEnvelope = current.valid ? normalizeEnvelope(current.value) : null;
    if (currentEnvelope) {
      return {
        ok: true,
        ...currentEnvelope,
        source: 'routines',
        needsMigration: false,
        migrated: false,
        invalidStoredValue: false,
      };
    }

    // An existing value that is neither v2 nor a recognized v1 envelope is
    // preserved. A migration must never turn an unknown value into a silent
    // data loss, even when an older legacy record is available as a fallback.
    const currentLegacyEnvelope = current.valid ? normalizeLegacyEnvelope(current.value) : null;
    if (current.found && !currentLegacyEnvelope) {
      const fallback = migrationSource(storage, current);
      const envelope = fallback.envelope || createEnvelope([]);
      return {
        ok: false,
        ...envelope,
        source: fallback.source,
        needsMigration: Boolean(fallback.envelope),
        migrated: false,
        invalidStoredValue: true,
        error: 'invalid-stored-value',
      };
    }

    const candidate = migrationSource(storage, current);
    if (!candidate.envelope) {
      return {
        ok: true,
        ...createEnvelope([]),
        source: 'empty',
        needsMigration: false,
        migrated: false,
        invalidStoredValue: current.found,
      };
    }

    const result = writeAndVerify(candidate.envelope, storage);
    if (result.ok) {
      return {
        ok: true,
        ...candidate.envelope,
        source: 'routines',
        migrationSource: candidate.source,
        needsMigration: false,
        migrated: true,
        invalidStoredValue: current.found,
      };
    }
    return {
      ok: false,
      ...candidate.envelope,
      source: candidate.source,
      needsMigration: true,
      migrated: false,
      invalidStoredValue: current.found,
      error: result.error || 'storage-write-failed',
    };
  }

  function load(storage = defaultStorage()) {
    return migrate(storage);
  }

  function save(routines, storage = defaultStorage()) {
    const envelope = createEnvelope(routines);
    const result = writeAndVerify(envelope, storage);
    if (result.ok) return { ok: true, ...envelope };

    const previous = readJson(storage, STORAGE_KEYS.routines);
    const previousEnvelope = previous.valid ? normalizeEnvelope(previous.value) : null;
    return {
      ok: false,
      ...(previousEnvelope || envelope),
      error: result.error || 'storage-write-failed',
    };
  }

  return {
    VERSION,
    STORAGE_KEYS,
    createEnvelope,
    normalizeEnvelope,
    normalizeRoutine,
    normalizeExceptions,
    routineFromBusPreset,
    busPresetFromRoutine,
    routineFromRoute,
    routeFromRoutine,
    createReturnRoutine,
    readLegacy,
    migrate,
    load,
    save,
  };
}));
