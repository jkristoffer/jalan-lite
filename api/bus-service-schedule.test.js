const test = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('./bus-service-schedule');

test('parses LTA frequency ranges and operating-window clocks', () => {
  assert.deepEqual(schedule.parseFrequencyRange('14-17'), { minMinutes: 14, maxMinutes: 17, raw: '14-17' });
  assert.deepEqual(schedule.parseFrequencyRange('10'), { minMinutes: 10, maxMinutes: 10, raw: '10' });
  assert.equal(schedule.parseFrequencyRange('unknown'), null);
  assert.equal(schedule.parseClockMinutes('0630H'), 390);
  assert.equal(schedule.parseClockMinutes('2400'), 1440);
  assert.equal(schedule.parseClockMinutes('2560'), null);
});

test('normalizes a BusServices row and selects the documented frequency period', () => {
  const service = schedule.normalizeService({
    ServiceNo: '80',
    Operator: 'SBST',
    Direction: 1,
    AM_Peak_Freq: '14-17',
    AM_Offpeak_Freq: '10-16',
    PM_Peak_Freq: '12-15',
    PM_Offpeak_Freq: '15-20',
  });
  assert.equal(schedule.frequencyAtSeconds(service, 7 * 3600).period, 'amPeak');
  assert.equal(schedule.frequencyAtSeconds(service, 12 * 3600).maxMinutes, 16);
  assert.equal(schedule.frequencyAtSeconds(service, 18 * 3600).minMinutes, 12);
  assert.equal(schedule.frequencyAtSeconds(service, 20 * 3600).period, 'pmOffpeak');
  assert.equal(schedule.frequencyAtSeconds(service, 5 * 3600), null);
});

test('checks BusRoutes operating windows by Singapore calendar day', () => {
  const window = schedule.normalizeOperatingWindow({
    WD_FirstBus: '0530',
    WD_LastBus: '2330',
    SAT_FirstBus: '0600',
    SAT_LastBus: '2400',
  });
  assert.equal(schedule.operatingAt(window, '20260825', 12 * 3600), true);
  assert.equal(schedule.operatingAt(window, '20260825', 23 * 3600 + 45 * 60), false);
  assert.equal(schedule.operatingAt(window, '20260829', 23 * 3600 + 50 * 60), true);
});

test('loads and validates the cached BusServices feed', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        value: [{
          ServiceNo: '80',
          Operator: 'SBST',
          Direction: 1,
          AM_Offpeak_Freq: '10-16',
          PM_Peak_Freq: '12-15',
        }],
      }),
    };
  };
  schedule.reset();
  try {
    const services = await schedule.loadServiceSchedules('test-key');
    assert.equal(services.get('80|1').frequencies.amOffpeak.maxMinutes, 16);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /BusServices/);
  } finally {
    global.fetch = originalFetch;
    schedule.reset();
  }
});
