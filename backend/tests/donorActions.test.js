const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomBytes } = require('node:crypto');
const pool = require('../db');
const { createToken } = require('../services/jwtService');
const { findMatchingDonors } = require('../services/donorMatchingService');
const donorRoutes = require('../routes/donorRoutes');
const original = { execute: pool.execute, getConnection: pool.getConnection, secret: process.env.JWT_SECRET, expiry: process.env.JWT_EXPIRES_IN };
let server, base, state, queries, events, failure, lockQueue;
const request = { request_id: 27, bank_id: 1, blood_group: 'A+', units_required: 3, urgency_level: 'Normal',
  recipient_id: 1, state: 'Uttar Pradesh', city: 'Ghaziabad', status: 'Pending', donor_matching_started_at: '2026-10-07T06:30:00Z' };
const donor = { donor_id: 16, blood_group: 'A+', is_available: 1, state: 'Uttar Pradesh', city: 'Ghaziabad' };

async function call(method, path, body, role = 'donor', id = 16, token) {
  const response = await fetch(base + path, { method,
    headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: 'Bearer ' + (token || createToken(id, role)) }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  assert.ok(!JSON.stringify(data).includes('Private SQL'));
  assert.ok(!/password_hash|password/.test(JSON.stringify(data)));
  return { status: response.status, data };
}
const availability = (body, role, id, token) => call('PATCH', '/api/donors/me/availability', body, role, id, token);
const response = (body = { response: 'Accepted' }, role, id, token, requestId = '27') =>
  call('POST', '/api/donors/me/requests/' + requestId + '/response', body, role, id, token);

before(async () => {
  process.env.JWT_SECRET = randomBytes(32).toString('hex'); process.env.JWT_EXPIRES_IN = '1h';
  pool.execute = async (sql, values) => {
    queries.push({ sql, values });
    if (failure === 'availability') throw new Error('Private SQL');
    if (sql.startsWith('UPDATE donors')) {
      assert.equal(sql, 'UPDATE donors SET is_available = ? WHERE donor_id = ?');
      const account = state.donors.get(values[1]);
      if (!account) return [{ affectedRows: 0 }];
      const changed = account.is_available !== values[0]; account.is_available = values[0];
      return [{ affectedRows: Number(changed) }];
    }
    assert.equal(sql, 'SELECT donor_id FROM donors WHERE donor_id = ? LIMIT 1');
    return [state.donors.has(values[0]) ? [{ donor_id: values[0] }] : []];
  };
  pool.getConnection = async () => {
    if (failure === 'connect') throw new Error('Private SQL');
    let working, unlock;
    const connection = {
      async beginTransaction() { events.push('begin'); },
      async execute(sql, values) {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT r.request_id')) {
          assert.ok(sql.endsWith('FOR UPDATE'));
          const preceding = lockQueue;
          lockQueue = new Promise(resolve => { unlock = resolve; });
          await preceding;
          working = structuredClone(state);
          return [working.request && working.request.request_id === values[0] ? [working.request] : []];
        }
        if (failure === 'read') throw new Error('Private SQL');
        if (sql.startsWith('SELECT donor_id, blood_group')) {
          assert.ok(sql.endsWith('FOR UPDATE'));
          const account = working.donors.get(values[0]); return [account ? [account] : []];
        }
        if (sql.startsWith('SELECT response')) {
          assert.equal(sql, 'SELECT response FROM donor_responses WHERE request_id = ? AND donor_id = ? FOR UPDATE');
          const previous = working.responses.get(values.join(':')); return [previous ? [{ response: previous }] : []];
        }
        if (sql.startsWith('SELECT allocation_id')) return [working.allocated ? [{ allocation_id: 1, donation_id: 1, inventory_id: null, units_allocated: typeof working.allocated === 'number' ? working.allocated : working.request.units_required }] : []];
        if (sql.startsWith('SELECT units_available')) {
          assert.equal(sql, 'SELECT units_available FROM blood_inventory WHERE bank_id = ? AND blood_group = ? FOR UPDATE');
          assert.deepEqual(values, [1, 'A+']);
          return [working.units === null ? [] : [{ units_available: working.units }]];
        }
        if (sql.startsWith('UPDATE blood_requests SET status')) { working.request.status = values[0]; return [{ affectedRows: 1 }]; }
        if (sql.startsWith('SELECT recipient_id, phone FROM recipients')) return [[{ recipient_id: 1, phone: '9876543210' }]];
        if (sql.startsWith('SELECT donor_id, phone FROM donors')) return [[{ donor_id: values[0], phone: '9876543211' }]];
        if (sql.startsWith('SELECT request_id FROM blood_requests')) return [[{ request_id: working.request.request_id }]];
        if (sql.startsWith('INSERT INTO notifications')) return [{ affectedRows: 1, insertId: 1 }];
        // Acceptance records no donation or inventory mutation.
        assert.equal(sql, 'INSERT INTO donor_responses (request_id, donor_id, response) VALUES (?, ?, ?)');
        if (failure === 'insert' || failure === 'rollback') throw new Error('Private SQL');
        if (failure === 'deadlock') { const error = new Error('Private SQL'); error.code = 'ER_LOCK_DEADLOCK'; throw error; }
        working.responses.set(values.slice(0, 2).join(':'), values[2]);
        return [{ affectedRows: 1 }];
      },
      async commit() {
        if (failure === 'commit') throw new Error('Private SQL');
        state = working; events.push('commit'); if (unlock) { unlock(); unlock = null; }
      },
      async rollback() { events.push('rollback'); if (failure === 'rollback') throw new Error('Private SQL rollback'); if (unlock) { unlock(); unlock = null; } },
      release() { events.push('release'); },
      destroy() { events.push('destroy'); if (unlock) { unlock(); unlock = null; } },
    };
    return connection;
  };
  const app = express(); app.use(express.json()); app.use('/api/donors', donorRoutes); app.use((error, req, res, next) => res.status(error.status || 500).json({ message: 'Invalid request.' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(() => {
  state = { request: { ...request }, donors: new Map([[16, { ...donor }], [17, { ...donor, donor_id: 17 }]]),
    units: 2, responses: new Map(), allocated: false, donations: [] };
  queries = []; events = []; failure = null; lockQueue = Promise.resolve();
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  pool.execute = original.execute; pool.getConnection = original.getConnection;
  for (const [key, value] of [['JWT_SECRET', original.secret], ['JWT_EXPIRES_IN', original.expiry]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await pool.end();
});

for (const value of [true, false]) test('JWT donor changes only own availability to ' + value, async () => {
  const before = { ...state.donors.get(17) };
  assert.equal((await availability({ is_available: value })).status, 200);
  assert.equal(state.donors.get(16).is_available, Number(value)); assert.deepEqual(state.donors.get(17), before);
  assert.deepEqual(queries[0].values, [Number(value), 16]);
});
for (const body of [undefined, null, [], {}, { is_available: 1 }, { is_available: 0 }, { is_available: 'true' },
  { is_available: null }, { is_available: false, donor_id: 17 }]) test('availability rejects invalid body ' + JSON.stringify(body), async () => {
  assert.equal((await availability(body)).status, 400); assert.equal(queries.length, 0);
});
test('unchanged availability remains successful', async () => { assert.equal((await availability({ is_available: true })).status, 200); assert.equal(queries.length, 2); });
test('missing own donor account has safe404', async () => { state.donors.delete(16); assert.equal((await availability({ is_available: false })).status, 404); });
test('availability SQL failure is safe500', async () => { failure = 'availability'; assert.equal((await availability({ is_available: false })).status, 500); });
for (const role of ['recipient', 'blood_bank']) test(role + ' cannot change donor availability or respond', async () => {
  assert.equal((await availability({ is_available: false }, role)).status, 403);
  assert.equal((await response(undefined, role)).status, 403); assert.equal(queries.length, 0); assert.equal(events.length, 0);
});
test('missing JWT denies both actions before SQL', async () => {
  assert.equal((await availability({ is_available: false }, 'donor', 16, null)).status, 401);
  assert.equal((await response(undefined, 'donor', 16, null)).status, 401); assert.equal(queries.length, 0);
});
for (const answer of ['Accepted', 'Declined']) test(answer + ' records response and acceptance status, preserving stock/donations', async () => {
  const before = structuredClone(state);
  const result = await response({ response: answer });
  assert.equal(result.status, 201); assert.equal(result.data.response, answer);
  assert.equal(state.responses.get('27:16'), answer);
  assert.deepEqual(state.request, { ...before.request, status: answer === 'Accepted' ? 'Processing' : before.request.status }); assert.equal(state.units, before.units); assert.deepEqual(state.donations, []);
  assert.deepEqual(events, ['begin', 'commit', 'release']);
});
test('same repeated response is idempotent and contradictory response is409', async () => {
  await response(); assert.equal((await response()).status, 200);
  assert.equal((await response({ response: 'Declined' })).status, 409); assert.equal(state.responses.size, 1);
});
test('recorded acceptance remains idempotent after request closes', async () => {
  await response(); state.request.status = 'Fulfilled'; state.donors.get(16).is_available = 0;
  assert.equal((await response()).status, 200); assert.equal(state.request.status, 'Fulfilled');
});
test('concurrent contradictory responses serialize on locked request', async () => {
  const results = await Promise.all([response(), response({ response: 'Declined' })]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]); assert.equal(state.responses.size, 1);
});
test('different donors can respond independently without fulfilling request', async () => {
  assert.equal((await response()).status, 201); assert.equal((await response({ response: 'Declined' }, 'donor', 17)).status, 201);
  assert.equal(state.responses.size, 2); assert.equal(state.request.status, 'Processing'); assert.equal(state.units, 2);
});
for (const body of [null, {}, [], { response: 'Accept' }, { response: 'Donated' }, { response: true },
  { response: 'Accepted', donor_id: 17 }, { response: 'Accepted', status: 'Fulfilled' }]) test('response rejects invalid body ' + JSON.stringify(body), async () => {
  assert.equal((await response(body)).status, 400); assert.equal(queries.length, 0);
});
for (const id of ['0', '-1', '1.5', 'abc', '2147483648', '1 OR 1=1']) test('response rejects invalid request ID ' + id, async () => {
  assert.equal((await response(undefined, 'donor', 16, undefined, encodeURIComponent(id))).status, 400); assert.equal(queries.length, 0);
});
test('missing request rolls back404', async () => { state.request = null; assert.equal((await response()).status, 404); assert.deepEqual(events, ['begin', 'rollback', 'release']); });
test('missing donor rolls back404', async () => { state.donors.delete(16); assert.equal((await response()).status, 404); });
for (const [field, value] of [['status', 'Fulfilled'], ['status', 'Cancelled'],
  ['donor_matching_started_at', null], ['bank_id', null], ['units_required', 0], ['urgency_level', null]]) test('request ineligible for new response: ' + field + '=' + value, async () => {
  state.request[field] = value; assert.equal((await response()).status, 409); assert.equal(state.responses.size, 0);
});
for (const [field, value] of [['blood_group', 'O+'], ['is_available', 0], ['is_available', null]]) test('donor ineligible: ' + field + '=' + value, async () => {
  state.donors.get(16)[field] = value; assert.equal((await response()).status, 409); assert.equal(state.responses.size, 0);
});
for (const units of [3, 5, -1]) test('response rejects sufficient/invalid selected inventory ' + units, async () => {
  state.units = units; assert.equal((await response()).status, 409); assert.equal(state.responses.size, 0); assert.equal(state.units, units);
});
for (const units of [0, null]) test('zero/missing inventory permits triggered fallback only: ' + units, async () => {
  state.units = units; assert.equal((await response()).status, 201); assert.equal(state.units, units);
});
test('fully allocated request prevents response without stock changes', async () => { state.allocated = true; assert.equal((await response()).status, 409); assert.equal(state.units, 2); });
for (const stage of ['connect', 'read', 'insert', 'commit', 'deadlock']) test('response ' + stage + ' failure safely rolls back', async () => {
  failure = stage; assert.equal((await response()).status, stage === 'deadlock' ? 409 : 500); assert.equal(state.responses.size, 0);
  if (stage !== 'connect') { assert.ok(events.includes('rollback')); assert.equal(events.at(-1), 'release'); }
});
test('shared matching service accepts transaction executor with original rules', async () => {
  const calls = [], executor = { execute: async (sql, values) => { calls.push({ sql, values }); return [[donor]]; } };
  assert.deepEqual(await findMatchingDonors('A+', executor, { state: 'Uttar Pradesh', city: 'Ghaziabad' }), [donor]);
  assert.deepEqual(calls[0].values, ['A+', 1, 'Uttar Pradesh', 'Ghaziabad']); assert.ok(calls[0].sql.includes('blood_group = ? AND is_available = ?'));
});

test('failed rollback destroys connection rather than returning open transaction to pool', async () => { failure = 'rollback'; assert.equal((await response()).status, 500); assert.deepEqual(events, ['begin', 'rollback', 'destroy']); assert.equal(state.responses.size, 0); });

test('Processing requests with partial allocations still accept eligible local donors', async () => {
  state.request.status = 'Processing'; state.allocated = 1; state.units = 0;
  assert.equal((await response()).status, 201); assert.equal(state.request.status, 'Processing');
});
test('another city or unknown canonical donor location never accepts', async () => {
  state.donors.get(16).city = 'Noida';
  assert.equal((await response()).status, 409); assert.equal(state.responses.size, 0);
});
test('missing canonical request location never accepts globally', async () => {
  state.request.city = null;
  assert.equal((await response()).status, 409); assert.equal(state.responses.size, 0);
});
