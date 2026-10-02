const test = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('./routine-schedule.js');

const singapore = (date, time) => Date.parse(`${date}T${time}:00+08:00`);

function route(id, days, departureTime = '08:00', extras = {}) {
  return {
    id,
    type: 'route',
    name: id,
    schedule: { days, departureTime, timeMode: 'depart' },
    ...extras,
  };
}

test('singaporeDate follows Singapore midnight at the UTC boundary', () => {
  assert.equal(schedule.singaporeDate(Date.parse('2026-01-01T15:59:59Z')), '2026-01-01');
  assert.equal(schedule.singaporeDate(Date.parse('2026-01-01T16:00:00Z')), '2026-01-02');
});

test('nextOccurrence advances weekday and weekend schedules in Singapore time', () => {
  const fridayMorning = singapore('2026-01-02', '09:00');
  const weekday = schedule.nextOccurrence(route('weekday', [1, 2, 3, 4, 5]), fridayMorning, { includeOverdue: false });
  const weekend = schedule.nextOccurrence(route('weekend', [0, 6]), fridayMorning);

  assert.deepEqual(weekday, {
    routineId: 'weekday',
    date: '2026-01-05',
    time: '08:00',
    timeMode: 'depart',
    timestamp: singapore('2026-01-05', '08:00'),
  });
  assert.deepEqual(weekend, {
    routineId: 'weekend',
    date: '2026-01-03',
    time: '08:00',
    timeMode: 'depart',
    timestamp: singapore('2026-01-03', '08:00'),
  });
});

test('exceptions skip a dated departure or override its time and mode', () => {
  const now = singapore('2026-01-05', '07:00');
  const skipped = schedule.nextOccurrence(route('skip', [1, 2, 3, 4, 5], '08:00', {
    exceptions: { '2026-01-05': { skip: true } },
  }), now);
  const changed = schedule.nextOccurrence(route('changed', [1, 2, 3, 4, 5], '08:00', {
    exceptions: { '2026-01-05': { departureTime: '09:15', timeMode: 'arrive' } },
  }), now);

  assert.equal(skipped.date, '2026-01-06');
  assert.equal(changed.date, '2026-01-05');
  assert.equal(changed.time, '09:15');
  assert.equal(changed.timeMode, 'arrive');
});

test('recently missed departures remain relevant for replanning', () => {
  const routine = route('overdue', [1, 2, 3, 4, 5]);
  const recent = schedule.nextOccurrence(routine, singapore('2026-01-05', '09:00'));
  const stale = schedule.nextOccurrence(routine, singapore('2026-01-05', '09:31'));

  assert.equal(recent.date, '2026-01-05');
  assert.equal(recent.overdue, true);
  assert.equal(stale.date, '2026-01-06');
  assert.equal(stale.overdue, undefined);
});

test('nextRelevant chooses an overdue departure before a later future routine', () => {
  const now = singapore('2026-01-05', '08:15');
  const result = schedule.nextRelevant([
    route('future', [1, 2, 3, 4, 5], '08:30'),
    route('overdue', [1, 2, 3, 4, 5], '08:00'),
  ], now);

  assert.equal(result.routineId, 'overdue');
  assert.equal(result.overdue, true);
});
