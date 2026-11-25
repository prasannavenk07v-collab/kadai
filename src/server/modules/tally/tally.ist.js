// Every Tally period boundary is an Indian calendar day, not a server day.
// Periods are half-open: [period_start 00:00 IST, period_end 00:00 IST).
// An invoice issued at 23:59 IST belongs to that IST month even when the
// server clock (or the database session) is UTC.

export const IST_TIME_ZONE = 'Asia/Kolkata';
export const IST_OFFSET = '+05:30';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function toUtcMidnight(dateOnly) {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** 'YYYY-MM-DD' in IST for a timestamp. */
export function istDateString(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('istDateString expects a valid date');
  }
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function assertDateOnly(value, field = 'date') {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) {
    const err = new TypeError(`${field} must be a YYYY-MM-DD date`);
    err.statusCode = 400;
    err.code = 'INVALID_DATE';
    throw err;
  }
  const parsed = toUtcMidnight(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    const err = new TypeError(`${field} is not a real calendar date`);
    err.statusCode = 400;
    err.code = 'INVALID_DATE';
    throw err;
  }
  return value;
}

/** Add whole days to a 'YYYY-MM-DD' string. */
export function addDays(dateOnly, days) {
  assertDateOnly(dateOnly);
  const next = new Date(toUtcMidnight(dateOnly).getTime() + days * 86_400_000);
  return next.toISOString().slice(0, 10);
}

/**
 * Convert a half-open IST period to the absolute timestamptz bounds used by
 * `invoices.issued_at`. Returned as ISO strings for the driver.
 */
export function istPeriodRange(periodStart, periodEnd) {
  assertDateOnly(periodStart, 'period_start');
  assertDateOnly(periodEnd, 'period_end');
  if (periodEnd <= periodStart) {
    const err = new TypeError('period_end must be after period_start');
    err.statusCode = 400;
    err.code = 'INVALID_PERIOD';
    throw err;
  }
  return {
    from: new Date(`${periodStart}T00:00:00${IST_OFFSET}`).toISOString(),
    to: new Date(`${periodEnd}T00:00:00${IST_OFFSET}`).toISOString(),
  };
}

/** The month containing `reference`, as a half-open period. */
export function monthPeriod(reference = new Date()) {
  const today = istDateString(reference);
  const first = `${today.slice(0, 7)}-01`;
  const [year, month] = first.split('-').map(Number);
  const nextFirst = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return { period_start: first, period_end: nextFirst };
}

/** The IST month before the one containing `reference`. */
export function previousMonthPeriod(reference = new Date()) {
  const { period_start } = monthPeriod(reference);
  const [year, month] = period_start.split('-').map(Number);
  const previousFirst = month === 1
    ? `${year - 1}-12-01`
    : `${year}-${String(month - 1).padStart(2, '0')}-01`;
  return { period_start: previousFirst, period_end: period_start };
}

/** The IST calendar date of a timestamptz, as a voucher date. */
export function voucherDateFrom(issuedAt) {
  return istDateString(issuedAt);
}

/**
 * A `date` column value back to 'YYYY-MM-DD'. node-postgres hands back a Date
 * at local midnight, so read local components — toISOString() would shift the
 * day west of UTC.
 */
export function dateOnlyFromDb(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    const pad = (part) => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}
