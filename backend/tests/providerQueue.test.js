const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomBytes } = require('node:crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { createToken } = require('../services/jwtService');
const scheduler = require('../services/priorityScheduler');
const originalBuildSchedule = scheduler.buildSchedule;

const original = { execute: pool.execute, query: pool.query, getConnection: pool.getConnection };
const environment = { JWT_SECRET: process.env.JWT_SECRET, JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN };
const secret = randomBytes(32).toString('hex');
let server, baseUrl, provider, requests, allocations, queries, events, failure, rawRows;
const request = (id, overrides = {}) => ({ request_id: id, bank_id: 7, blood_group: 'O+',
  units_required: 5, urgency_level: 'Normal', status: 'Pending', request_date: '2020-01-01T00:00:00.000Z', ...overrides });

function simulatedFailure(stage) {
  if (failure === stage) throw new Error('Private SQL host and credentials must stay private.');
}
async function execute(sql, values, source) {
  queries.push({ sql, values, source });
  assert.match(sql, /^SELECT /);
  assert.doesNotMatch(sql, /FOR UPDATE|FOR SHARE|\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/);
  if (source === 'pool') {
    simulatedFailure('provider');
    assert.ok(sql.includes('FROM organizations o LEFT JOIN blood_banks') || sql.includes('FROM blood_banks b LEFT JOIN organizations'));
    assert.equal(values.length, 1);
    return [provider ? [{ ...provider }] : []];
  }
  if (sql.includes('FROM blood_requests r') && !sql.includes('LEFT JOIN')) {
    simulatedFailure('requests');
    assert.equal(sql, 'SELECT r.request_id, r.bank_id, r.blood_group, r.units_required, r.urgency_level, r.status, r.request_date FROM blood_requests r WHERE r.bank_id = ? AND r.status IN (?, ?)');
    assert.deepEqual(values, [7, 'Pending', 'Processing']);
    return [rawRows ?? requests.filter(row => row.bank_id === values[0] && values.slice(1).includes(row.status)).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT allocation_id, donation_id, inventory_id')) {
    simulatedFailure('progress');
    assert.equal(sql, 'SELECT allocation_id, donation_id, inventory_id, units_allocated FROM request_allocations WHERE request_id = ?');
    assert.ok(requests.some(row => row.request_id === values[0]) || rawRows?.some(row => row.request_id === values[0]));
    return [allocations.filter(row => row.request_id === values[0]).map(row => ({ ...row }))];
  }
  // Existing /:requestId route is exercised without changing its handler.
  if (sql.includes('FROM blood_requests r LEFT JOIN')) {
    assert.deepEqual(values, [7, 12]);
    return [requests.filter(row => row.bank_id === 7 && row.request_id === 12)];
  }
  if (sql.startsWith('SELECT d.donor_id, d.name')) return [[]];
  throw new Error('Unexpected query in in-memory test.');
}

before(async () => {
  process.env.JWT_SECRET = secret;
  process.env.JWT_EXPIRES_IN = '1h';
  // Har SQL call memory mein mock hai; real database use nahi hoga.
  pool.query = async () => { throw new Error('Real database calls are disabled.'); };
  pool.execute = (sql, values) => execute(sql, values, 'pool');
  pool.getConnection = async () => {
    events.push('acquire');
    simulatedFailure('acquire');
    return {
      execute: (sql, values) => execute(sql, values, 'connection'),
      beginTransaction: async () => { events.push('begin'); simulatedFailure('begin'); },
      commit: async () => { events.push('commit'); simulatedFailure('commit'); },
      rollback: async () => { events.push('rollback'); if (failure === 'rollback') throw new Error('Rollback failed.'); },
      release: () => events.push('release'),
      destroy: () => events.push('destroy'),
    };
  };
  const app = express();
  app.use(express.json());
  scheduler.buildSchedule = (...args) => {
    assert.equal(events.at(-1), 'release', 'Scheduling must happen after releasing the DB connection.');
    if (failure === 'scheduler') {
      const error = new Error('Private scheduler diagnostic.');
      error.code = 'SCHEDULER_DATA_ERROR';
      throw error;
    }
    return originalBuildSchedule(...args);
  };
  app.use('/api/requests', require('../routes/requestRoutes'));
  scheduler.buildSchedule = originalBuildSchedule;
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/requests';
});

beforeEach(() => {
  provider = { organization_id: 1, organization_type: 'Blood Bank', bank_id: 7 };
  requests = [request(12)];
  allocations = [];
  queries = [];
  events = [];
  failure = null;
  rawRows = null;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  Object.assign(pool, original);
  for (const key of Object.keys(environment)) {
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
});

async function get(path = '/provider-queue', role = 'organization', token) {
  const headers = token === null ? {} : { Authorization: 'Bearer ' + (token ?? createToken(role === 'blood_bank' ? 7 : 1, role)) };
  const response = await fetch(baseUrl + path, { headers });
  return { status: response.status, body: await response.json() };
}
function assertSafe(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(!['password', 'password_hash', 'recipient_id', 'phone', 'email', 'sql', 'stack'].includes(key));
    assertSafe(item);
  }
}

test('provider queue rejects unauthenticated requests before SQL', async () => {
  assert.equal((await get('/provider-queue', 'organization', null)).status, 401);
  assert.deepEqual(queries, []);
  assert.deepEqual(events, []);
});
test('provider queue rejects invalid JWT before SQL', async () => {
  assert.equal((await get('/provider-queue', 'organization', 'invalid')).status, 401);
  assert.deepEqual(queries, []);
});
test('provider queue rejects expired JWT before SQL', async () => {
  const token = jwt.sign({ user_id: 1, user_type: 'organization' }, secret, { algorithm: 'HS256', expiresIn: -1 });
  assert.equal((await get('/provider-queue', 'organization', token)).status, 401);
  assert.deepEqual(queries, []);
});
for (const role of ['donor', 'recipient']) {
  test('provider queue denies ' + role + ' before database access', async () => {
    assert.equal((await get('/provider-queue', role)).status, 403);
    assert.deepEqual(queries, []);
    assert.deepEqual(events, []);
  });
}
for (const type of ['Hospital', 'Blood Bank']) {
  test(type + ' organization reads its current provider-owned queue', async () => {
    provider.organization_type = type;
    const result = await get();
    assert.equal(result.status, 200);
    assert.equal(result.body.bank_id, 7);
    assert.equal(result.body.organization_id, 1);
    assert.deepEqual(result.body.queue.map(row => row.request_id), [12]);
    assert.deepEqual(queries[0].values, [1]);
    assertSafe(result.body);
  });
}
test('legacy bank account can read queue without an organization ID', async () => {
  provider.organization_id = null;
  const result = await get('/provider-queue', 'blood_bank');
  assert.equal(result.status, 200);
  assert.equal(result.body.organization_id, null);
  assert.deepEqual(queries[0].values, [7]);
  assert.ok(queries[0].sql.includes('FROM blood_banks b LEFT JOIN organizations'));
});
for (const type of ['NGO', null]) {
  test('current database provider type ' + type + ' cannot enter clinical queue', async () => {
    provider.organization_type = type;
    assert.equal((await get()).status, 403);
    assert.equal(queries.length, 1);
    assert.deepEqual(events, []);
  });
}
test('missing organization provider cannot read the queue', async () => {
  provider = null;
  assert.equal((await get()).status, 403);
  assert.deepEqual(events, []);
});
test('organization without a linked bank cannot read the queue', async () => {
  provider.bank_id = null;
  assert.equal((await get()).status, 403);
  assert.deepEqual(events, []);
});
for (const query of ['bank_id=8', 'organization_id=8', 'priority=0', 'request_date=1900-01-01', 'now=0', 'anything=']) {
  test('queue rejects query override ' + query + ' without SQL', async () => {
    assert.equal((await get('/provider-queue?' + query)).status, 400);
    assert.deepEqual(queries, []);
    assert.deepEqual(events, []);
  });
}
test('queue filters other banks and closed requests while preserving remaining units', async () => {
  requests.push(request(13, { bank_id: 8 }), request(14, { status: 'Cancelled' }), request(15, { status: 'Fulfilled' }));
  allocations.push({ request_id: 12, allocation_id: 1, inventory_id: 2, donation_id: null, units_allocated: 2 });
  const result = await get();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.queue.map(row => row.request_id), [12]);
  assert.equal(result.body.queue[0].units_required, 5);
  assert.equal(result.body.queue[0].remaining_units, 3);
  assert.equal(queries.filter(query => query.sql.startsWith('SELECT allocation_id')).length, 1);
});
test('queue excludes an open request with zero remaining demand', async () => {
  allocations.push({ request_id: 12, allocation_id: 1, inventory_id: 2, donation_id: null, units_allocated: 5 });
  assert.deepEqual((await get()).body.queue, []);
});
test('queue returns valid empty schedule', async () => {
  requests = [];
  const result = await get();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.queue, []);
  assert.equal(result.body.algorithm, 'Non-preemptive Priority + FCFS');
  assert.ok(Number.isFinite(Date.parse(result.body.generated_at)));
  assert.equal(result.body.long_wait_threshold_seconds, 86400);
});
test('JavaScript schedules deliberately unordered SQL rows using priority FCFS and ID', async () => {
  requests = [request(15), request(14, { urgency_level: 'Emergency', request_date: '2021-01-01T00:00:00Z' }),
    request(13, { urgency_level: 'Emergency', request_date: '2020-01-01T00:00:00Z' }),
    request(12, { urgency_level: 'Emergency', request_date: '2020-01-01T00:00:00Z' })];
  const result = await get();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.queue.map(row => row.request_id), [12, 13, 14, 15]);
  assert.deepEqual(result.body.queue.map(row => row.position), [1, 2, 3, 4]);
  assert.deepEqual(result.body.queue.map(row => row.priority), [0, 0, 0, 1]);
  assert.ok(result.body.queue.every(row => typeof row.selection_reason === 'string' && row.selection_reason.length > 0));
  assert.ok(!queries.find(query => query.sql.includes('FROM blood_requests r')).sql.includes('ORDER BY'));
});
test('queue emits long-wait alerts only for Normal requests', async () => {
  requests.push(request(13, { urgency_level: 'Emergency' }));
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.body.queue.find(row => row.request_id === 12).long_waiting_normal, true);
  assert.equal(result.body.queue.find(row => row.request_id === 13).long_waiting_normal, false);
  assert.ok(result.body.queue.every(row => Number.isInteger(row.waiting_seconds) && row.waiting_seconds >= 0));
});
test('queue SELECTs are read-only and connections commit then release', async () => {
  assert.equal((await get()).status, 200);
  assert.deepEqual(events, ['acquire', 'begin', 'commit', 'release']);
  assert.ok(queries.every(query => query.sql.startsWith('SELECT ') && !/FOR UPDATE|FOR SHARE/.test(query.sql)));
});
for (const [field, value] of [['request_id', 0], ['bank_id', 8], ['units_required', -1],
  ['urgency_level', 'Urgent'], ['status', 'Cancelled'], ['blood_group', 'Unknown']]) {
  test('inconsistent request ' + field + ' returns safe conflict and rolls back', async () => {
    rawRows = [request(12, { [field]: value })];
    const result = await get();
    assert.equal(result.status, 409);
    assert.deepEqual(events, ['acquire', 'begin', 'rollback', 'release']);
    assertSafe(result.body);
  });
}
test('duplicate IDs return safe conflict', async () => {
  rawRows = [request(12), request(12)];
  assert.equal((await get()).status, 409);
});
for (const row of [
  { units_allocated: -1, inventory_id: 1, donation_id: null },
  { units_allocated: 1, inventory_id: null, donation_id: null },
  { units_allocated: 1, inventory_id: 1, donation_id: 2 },
  { units_allocated: 6, inventory_id: 1, donation_id: null },
]) {
  test('inconsistent allocation history is not presented as a valid queue: ' + JSON.stringify(row), async () => {
    allocations.push({ allocation_id: 1, request_id: 12, ...row });
    assert.equal((await get()).status, 409);
    assert.deepEqual(events, ['acquire', 'begin', 'rollback', 'release']);
  });
}
for (const stage of ['provider', 'acquire', 'begin', 'requests', 'progress', 'commit']) {
  test('failure at ' + stage + ' returns safe 500 and cleans up', async () => {
    failure = stage;
    const result = await get();
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { message: 'Unable to retrieve the provider review queue.' });
    if (['begin', 'requests', 'progress', 'commit'].includes(stage)) {
      assert.deepEqual(events.slice(-2), ['rollback', 'release']);
    } else assert.ok(!events.includes('release'));
  });
}
test('rollback failure destroys the connection rather than returning it to the pool', async () => {
  failure = 'rollback';
  rawRows = [request(12, { units_required: -1 })];
  assert.equal((await get()).status, 409);
  assert.deepEqual(events, ['acquire', 'begin', 'rollback', 'destroy']);
});
test('scheduler data errors produce a safe 409 after read transaction is released', async () => {
  failure = 'scheduler';
  const result = await get();
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { message: 'Provider queue contains inconsistent data.' });
  assert.deepEqual(events, ['acquire', 'begin', 'commit', 'release']);
});
test('unsupported creation time is flagged without inventing a waiting duration', async () => {
  rawRows = [request(12, { request_date: { invalid: true } })];
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.body.queue[0].request_date, null);
  assert.equal(result.body.queue[0].waiting_seconds, null);
  assert.ok(result.body.queue[0].time_warning);
});
test('specific queue route is reached rather than treating provider-queue as requestId', async () => {
  const result = await get();
  assert.equal(result.status, 200);
  assert.ok(Array.isArray(result.body.queue));
  assert.equal(result.body.request, undefined);
});
test('existing numeric request detail route remains reachable', async () => {
  const result = await get('/12');
  assert.equal(result.status, 200);
  assert.equal(result.body.request.request_id, 12);
  assert.equal(result.body.queue, undefined);
});
