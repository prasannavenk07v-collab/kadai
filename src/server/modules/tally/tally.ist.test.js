import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  assertDateOnly,
  dateOnlyFromDb,
  istDateString,
  istPeriodRange,
  monthPeriod,
  previousMonthPeriod,
} from './tally.ist.js';

test('IST dates: an invoice at 23:59 IST stays in its month', () => {
  // 2026-10-31T18:29:59Z is 23:59:59 IST on 31 October.
  assert.equal(istDateString(new Date('2026-10-31T18:29:59Z')), '2026-10-31');
  // One minute later the IST calendar has turned over.
  assert.equal(istDateString(new Date('2026-10-31T18:30:00Z')), '2026-11-01');
});

test('IST period: half-open bounds are expressed in absolute time', () => {
  const range = istPeriodRange('2026-11-01', '2026-12-01');
  assert.equal(range.from, '2026-10-31T18:30:00.000Z');
  assert.equal(range.to, '2026-11-30T18:30:00.000Z');
});

test('IST period: rejects reversed or malformed periods', () => {
  assert.throws(() => istPeriodRange('2026-12-01', '2026-11-01'), /period_end must be after period_start/);
  assert.throws(() => istPeriodRange('2026-02-30', '2026-03-01'), /not a real calendar date/);
  assert.throws(() => assertDateOnly('01-11-2026'), /YYYY-MM-DD/);
});

test('IST period: previous month crosses the year boundary', () => {
  assert.deepEqual(previousMonthPeriod(new Date('2026-01-15T06:00:00Z')), {
    period_start: '2025-12-01',
    period_end: '2026-01-01',
  });
  assert.deepEqual(monthPeriod(new Date('2026-01-15T06:00:00Z')), {
    period_start: '2026-01-01',
    period_end: '2026-02-01',
  });
});

test('IST period: leap day arithmetic', () => {
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2028-02-29', 1), '2028-03-01');
});

test('date columns round-trip without a UTC shift', () => {
  const localMidnight = new Date(2026, 10, 4);
  assert.equal(dateOnlyFromDb(localMidnight), '2026-11-04');
  assert.equal(dateOnlyFromDb('2026-11-04'), '2026-11-04');
  assert.equal(dateOnlyFromDb(null), null);
});
