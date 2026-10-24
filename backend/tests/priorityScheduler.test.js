const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { compareRequests, selectNextRequest, buildSchedule, LONG_WAIT_THRESHOLD_SECONDS } = require('../services/priorityScheduler');
const now = Date.parse('2026-10-21T12:00:00Z');
const row = (request_id, urgency_level = 'Normal', request_date = '2026-10-21T10:00:00Z', extra = {}) => ({
  request_id, bank_id: 7, blood_group: 'A+', units_required: 17, remaining_units: 11,
  urgency_level, request_date, status: 'Pending', ...extra,
});
const schedule = rows => buildSchedule(rows, { now });
const ids = rows => schedule(rows).queue.map(item => item.request_id);

test('explicit priority, FCFS and numeric request ID ties choose 103,104,102,101', () => {
  assert.deepEqual(ids([row(101, 'Normal', '2026-10-21T09:00:00Z'), row(102, 'Emergency', '2026-10-21T09:20:00Z'),
    row(104, 'Emergency', '2026-10-21T09:10:00Z'), row(103, 'Emergency', '2026-10-21T09:10:00Z')]), [103, 104, 102, 101]);
});
for (const priority of ['Normal', 'Emergency']) {
  test(priority + ' uses FCFS before request ID', () => assert.deepEqual(ids([
    row(1, priority, '2026-10-21T11:00:00Z'), row(20, priority, '2026-10-21T09:00:00Z')]), [20, 1]));
  test(priority + ' identical timestamps use numeric IDs', () => assert.deepEqual(ids([row(100, priority), row(2, priority)]), [2, 100]));
}
test('comparator is antisymmetric and exact same request compares equal', () => {
  const first = row(1, 'Emergency'), second = row(2);
  assert.equal(compareRequests(first, second), -1); assert.equal(compareRequests(second, first), 1);
  assert.equal(compareRequests(first, first), 0);
});
test('empty and single queues have deterministic metadata', () => {
  assert.deepEqual(schedule([]), { algorithm: 'Non-preemptive Priority + FCFS', generated_at: new Date(now).toISOString(),
    long_wait_threshold_seconds: LONG_WAIT_THRESHOLD_SECONDS, queue: [] });
  assert.equal(schedule([row(1)]).queue[0].position, 1); assert.equal(selectNextRequest([]), null);
});
test('active review is preserved even when an Emergency arrives', () => {
  const active = row(1); const emergency = row(2, 'Emergency');
  assert.equal(selectNextRequest([emergency], active), active);
  assert.equal(selectNextRequest([active, emergency]), emergency);
});
test('finished or cancelled requests and zero remaining units are excluded', () => {
  assert.deepEqual(ids([row(1, 'Normal', null, { status: 'Fulfilled' }), row(2, 'Normal', null, { status: 'Cancelled' }),
    row(3, 'Normal', null, { remaining_units: 0 }), row(4, 'Normal', null, { status: 'Processing' })]), [4]);
});
test('input arrays, rows and Date objects remain untouched', () => {
  const date = new Date('2026-10-21T10:00:00Z');
  const input = Object.freeze([Object.freeze(row(2)), Object.freeze(row(1, 'Emergency', date))]);
  const before = JSON.stringify(input); schedule(input); assert.equal(JSON.stringify(input), before);
  assert.equal(date.toISOString(), '2026-10-21T10:00:00.000Z');
});
test('all permutations produce the same schedule regardless of SQL result order', () => {
  const records = [row(1), row(2, 'Emergency'), row(3, 'Emergency', null), row(4)];
  function check(remaining, prefix = []) {
    if (!remaining.length) return assert.deepEqual(ids(prefix), [2, 3, 1, 4]);
    for (let i = 0; i < remaining.length; i++) check(remaining.filter((_, index) => index !== i), [...prefix, remaining[i]]);
  }
  check(records);
});
for (const date of [null, '', 'not-a-date', '2026-10-21 10:00:00', new Date('invalid'),
  '2026-02-30T10:00:00Z', '2026-02-29T10:00:00Z', '2026-10-21T24:00:00Z']) {
  test('unusable time safely goes last within its priority: ' + String(date), () => {
    const result = schedule([row(1, 'Emergency', date), row(2, 'Normal'), row(3, 'Emergency')]).queue;
    assert.deepEqual(result.map(item => item.request_id), [3, 1, 2]);
    assert.equal(result[1].waiting_seconds, null); assert.equal(result[1].request_date, null);
    assert.match(result[1].time_warning, /unavailable/);
  });
}
test('unknown dates tie by ID without Infinity subtraction producing NaN', () => assert.deepEqual(ids([
  row(20, 'Normal', null), row(2, 'Normal', 'bad')]), [2, 20]));
test('future dates are flagged and never produce negative waiting or outrank dated peers', () => {
  const result = schedule([row(1, 'Emergency', '2026-10-22T12:00:00Z'), row(2, 'Emergency')]).queue;
  assert.equal(result[1].request_id, 1); assert.equal(result[1].waiting_seconds, null);
  assert.match(result[1].time_warning, /future/); assert.equal(result[1].long_waiting_normal, false);
});
test('Date objects and timezone-offset strings represent the same arrival time', () => {
  assert.deepEqual(ids([row(2, 'Normal', new Date('2026-10-21T10:00:00Z')),
    row(1, 'Normal', '2026-10-21T15:30:00+05:30')]), [1, 2]);
});
test('waiting uses one injected server clock and floors whole seconds', () => {
  const result = buildSchedule([row(1, 'Normal', '2026-10-21T11:59:58.500Z')], { now: new Date(now) }).queue[0];
  assert.equal(result.waiting_seconds, 1); assert.equal(result.time_warning, null);
});
test('long-wait threshold is inclusive and never promotes Normal ahead of Emergency', () => {
  const result = buildSchedule([row(1, 'Normal', '2026-10-21T11:00:00Z'), row(2, 'Emergency', '2026-10-21T11:59:59Z'),
    row(3, 'Normal', '2026-10-21T11:00:01Z')], { now, longWaitThresholdSeconds: 3600 }).queue;
  assert.deepEqual(result.map(item => item.request_id), [2, 1, 3]);
  assert.deepEqual(result.map(item => item.long_waiting_normal), [false, true, false]);
});
test('safe projection excludes recipient contacts and secrets', () => {
  const result = schedule([row(1, 'Normal', null, { password: 'fixture', password_hash: 'fixture', phone: 'fixture', recipient_id: 9 })]);
  assert.ok(!/password|phone|recipient_id/.test(JSON.stringify(result)));
});
test('each position and explanation describes explicit priority and FCFS policy', () => {
  const result = schedule([row(1), row(2, 'Emergency'), row(3, 'Normal', null)]).queue;
  assert.deepEqual(result.map(item => item.position), [1, 2, 3]);
  assert.match(result[0].selection_reason, /Emergency priority 0.*FCFS/);
  assert.match(result[2].selection_reason, /dated requests.*request ID/);
});
for (const fields of [{ request_id: 0 }, { request_id: '1' }, { bank_id: 0 }, { units_required: 0 },
  { remaining_units: -1 }, { remaining_units: 18 }, { remaining_units: 1.5 }, { urgency_level: 'Critical' },
  { status: null }, { blood_group: 'invalid' }]) {
  test('inconsistent source data is rejected: ' + JSON.stringify(fields), () => {
    assert.throws(() => schedule([row(1, 'Normal', null, fields)]), { code: 'SCHEDULER_DATA_ERROR' });
  });
}
test('duplicate request IDs are rejected', () => assert.throws(() => schedule([row(1), row(1)]), { code: 'SCHEDULER_DATA_ERROR' }));
for (const options of [{ now: NaN }, { now: Infinity }, { longWaitThresholdSeconds: 0 }, { longWaitThresholdSeconds: 1.5 }]) {
  test('invalid clock/threshold fails safely: ' + JSON.stringify(options), () => assert.throws(() => buildSchedule([], options), { code: 'SCHEDULER_DATA_ERROR' }));
}
test('scheduler source has explicit selection and no Array.sort or SQL dependency', () => {
  const source = fs.readFileSync(require.resolve('../services/priorityScheduler'), 'utf8');
  assert.ok(!/\.sort\s*\(/.test(source)); assert.ok(!/require\(['"](?:mysql|\.\.\/db)/.test(source));
});
