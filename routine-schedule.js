(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JalanSchedule = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SINGAPORE_OFFSET_MS = 8 * 60 * 60 * 1000;
  const DEFAULT_OVERDUE_MINUTES = 90;
  const DEFAULT_HORIZON_DAYS = 370;

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function timestamp(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    return NaN;
  }

  function singaporeDate(now = Date.now()) {
    const value = timestamp(now);
    if (!Number.isFinite(value)) return null;
    return new Date(value + SINGAPORE_OFFSET_MS).toISOString().slice(0, 10);
  }

  function validTime(value) {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
    const [hour, minute] = value.split(':').map(Number);
    return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
  }

  function validDateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }

  function localParts(now) {
    const value = timestamp(now);
    if (!Number.isFinite(value)) return null;
    const date = new Date(value + SINGAPORE_OFFSET_MS);
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      weekday: date.getUTCDay(),
      minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
    };
  }

  function dateKey(parts) {
    return [parts.year, String(parts.month).padStart(2, '0'), String(parts.day).padStart(2, '0')]
      .join('-');
  }

  function datePartsForKey(value) {
    if (!validDateKey(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return { year, month, day, weekday: date.getUTCDay() };
  }

  function addDays(parts, amount) {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      weekday: date.getUTCDay(),
    };
  }

  function localTimestamp(parts, time) {
    if (!parts || !validTime(time)) return NaN;
    const [hour, minute] = time.split(':').map(Number);
    return Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute) - SINGAPORE_OFFSET_MS;
  }

  function normalizedDays(routine) {
    const schedule = isObject(routine?.schedule) ? routine.schedule : {};
    const value = Object.prototype.hasOwnProperty.call(schedule, 'days')
      ? schedule.days
      : routine?.days;
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value)) return [];
    return [...new Set(value
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))];
  }

  function scheduleFor(routine) {
    const schedule = isObject(routine?.schedule) ? routine.schedule : {};
    const departureTime = validTime(schedule.departureTime)
      ? schedule.departureTime
      : validTime(routine?.departureTime)
        ? routine.departureTime
        : validTime(schedule.startTime)
          ? schedule.startTime
          : validTime(routine?.startTime)
            ? routine.startTime
            : null;
    const timeMode = schedule.timeMode === 'arrive' || routine?.timeMode === 'arrive' ? 'arrive' : 'depart';
    const exceptions = {
      ...(isObject(schedule.exceptions) ? schedule.exceptions : {}),
      ...(isObject(routine?.route?.exceptions) ? routine.route.exceptions : {}),
      ...(isObject(routine?.exceptions) ? routine.exceptions : {}),
    };
    return { departureTime, timeMode, exceptions };
  }

  function normalizedException(value) {
    if (!isObject(value)) return null;
    if (value.skip === true) return { skip: true };
    const time = validTime(value.departureTime)
      ? value.departureTime
      : validTime(value.time)
        ? value.time
        : null;
    if (!time) return null;
    return {
      departureTime: time,
      timeMode: value.timeMode === 'arrive' ? 'arrive' : 'depart',
    };
  }

  function nextOccurrence(routine, now = Date.now(), options = {}) {
    if (!isObject(routine) || !String(routine.id || '').trim()) return null;
    if (isObject(now) && !(now instanceof Date)) {
      options = now;
      now = Date.now();
    }
    const current = timestamp(now);
    const today = localParts(current);
    if (!today) return null;
    const schedule = scheduleFor(routine);
    const days = normalizedDays(routine);
    const overdueEnabled = options.includeOverdue !== false && options.includeRecentOverdue !== false;
    const overdueOption = options.overdueWindowMinutes ?? options.overdueMinutes;
    const overdueMinutes = Number.isFinite(Number(overdueOption))
      ? Math.max(0, Number(overdueOption))
      : DEFAULT_OVERDUE_MINUTES;
    const overdueWindow = Number.isFinite(Number(options.overdueWindowMs))
      ? Math.max(0, Number(options.overdueWindowMs))
      : overdueMinutes * 60 * 1000;
    const horizonOption = options.horizonDays ?? options.horizon;
    const horizon = Number.isFinite(Number(horizonOption))
      ? Math.max(0, Math.floor(Number(horizonOption)))
      : DEFAULT_HORIZON_DAYS;
    let overdue = null;
    let future = null;

    // Include yesterday because a trip just before Singapore midnight can still
    // be the relevant departure for the next 90 minutes.
    for (let offset = -1; offset <= horizon; offset += 1) {
      const parts = addDays(today, offset);
      const date = dateKey(parts);
      const exception = normalizedException(schedule.exceptions[date]);
      if (exception?.skip) continue;
      const exceptionTime = exception?.departureTime || null;
      const scheduledDay = days === null || days.includes(parts.weekday);
      // A dated time change is also an explicit one-off occurrence, even when
      // its weekday is outside the recurring set.
      if (!scheduledDay && !exceptionTime) continue;
      const time = exceptionTime || schedule.departureTime;
      if (!time) continue;
      const candidateTimestamp = localTimestamp(parts, time);
      if (!Number.isFinite(candidateTimestamp)) continue;
      const candidate = {
        routineId: String(routine.id),
        date,
        time,
        timeMode: exception?.timeMode || schedule.timeMode,
        timestamp: candidateTimestamp,
      };
      if (candidateTimestamp >= current) {
        if (!future) future = candidate;
        // Dates are ascending, so this is the first future occurrence.
        break;
      }
      if (overdueEnabled && current - candidateTimestamp <= overdueWindow) {
        // A routine has one time per date; retain the most recent overdue
        // candidate in case the horizon starts with yesterday.
        if (!overdue || candidateTimestamp > overdue.timestamp) overdue = { ...candidate, overdue: true };
      }
    }
    return overdue || future;
  }

  function nextRelevant(routines, now = Date.now(), options = {}) {
    if (!Array.isArray(routines)) return null;
    if (isObject(now) && !(now instanceof Date)) {
      options = now;
      now = Date.now();
    }
    const occurrences = routines
      .map((routine) => nextOccurrence(routine, now, options))
      .filter(Boolean);
    if (!occurrences.length) return null;
    return occurrences.reduce((best, candidate) => {
      if (!best) return candidate;
      const bestOverdue = best.overdue === true;
      const candidateOverdue = candidate.overdue === true;
      if (candidateOverdue && !bestOverdue) return candidate;
      if (!candidateOverdue && bestOverdue) return best;
      if (candidateOverdue && bestOverdue) return candidate.timestamp > best.timestamp ? candidate : best;
      return candidate.timestamp < best.timestamp ? candidate : best;
    }, null);
  }

  function setException(routine, date, value) {
    if (!isObject(routine) || !validDateKey(date)) return routine;
    const exception = normalizedException(value);
    const schedule = isObject(routine.schedule) ? routine.schedule : {};
    const existing = isObject(routine.exceptions)
      ? routine.exceptions
      : isObject(schedule.exceptions)
        ? schedule.exceptions
        : {};
    const exceptions = { ...existing };
    if (exception) exceptions[date] = exception;
    else delete exceptions[date];
    return {
      ...routine,
      exceptions,
      schedule: { ...schedule, exceptions },
    };
  }

  return {
    SINGAPORE_OFFSET_MS,
    DEFAULT_OVERDUE_MINUTES,
    singaporeDate,
    nextOccurrence,
    nextRelevant,
    setException,
  };
}));
