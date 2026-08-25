const test = require('node:test');
const assert = require('node:assert/strict');
const source = require('../train-schedule-source');

test('accepts the signed LTA train schedule link from JSON index', () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ value: [{ Link: 'https://dmprod-datasets.s3.ap-southeast-1.amazonaws.com/train-gtfs-schedule/gtfs_schedule.zip?X-Amz-Signature=test' }] }));
  assert.match(source.parseScheduleIndex(bytes), /train-gtfs-schedule\/gtfs_schedule\.zip/);
});

test('rejects an unsafe GTFS schedule download host', () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ value: [{ link: 'https://example.com/train-gtfs-schedule/gtfs_schedule.zip' }] }));
  assert.throws(() => source.parseScheduleIndex(bytes), /unsafe download link/);
});
