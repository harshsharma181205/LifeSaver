const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../db');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const { createToken } = require('../services/jwtService');

const originalExecute = pool.execute;
const originalConnection = pool.getConnection;
const originalQuery = pool.query;
const originalListen = express.application.listen;
const originalPort = process.env.PORT;
const jwtNames = ['JWT_SECRET', 'JWT_EXPIRES_IN'];
const originalJwtEnvironment = Object.fromEntries(jwtNames.map(name => [name, process.env[name]]));
const testSecret = randomBytes(32).toString('hex');
const otherSecret = randomBytes(32).toString('hex');
function recipientHeaders(id = 1) {
  return { Authorization: 'Bearer ' + createToken(id, 'recipient') };
}
let server;
let baseUrl;
let queries;
let recipientExists;
let bankExists;
let bankLookupError;
let lookupError;
let insertError;
let listError;
let listedRequests;
let extraQueries, allocationRows, acceptedRows, transactionLog, providerType;
const validInput = { bank_id: 1, recipient_id: 1, blood_group: 'O+', units_required: 2, urgency_level: 'Emergency' };

function assertSafe(body) {
  for (const [key, value] of Object.entries(body)) {
    assert.ok(!['password', 'password_hash', 'stack', 'sql'].includes(key));
    if (value && typeof value === 'object') assertSafe(value);
  }
}

async function post(body, expectedStatus, raw = false) {
  const response = await fetch(baseUrl + '/api/requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...recipientHeaders(Number.isInteger(body?.recipient_id) && body.recipient_id > 0 ? body.recipient_id : 1) },
    body: raw ? body : JSON.stringify(body),
  });
  assert.equal(response.status, expectedStatus);
  const result = await response.json();
  assert.equal(typeof result.message, 'string');
  assertSafe(result);
  return result;
}

before(async () => {
  process.env.JWT_SECRET = testSecret;
  process.env.JWT_EXPIRES_IN = '1h';
  // Unit tests mein SQL memory mein simulate hoga; koi real test data save nahi hoga.
  pool.query = async () => { throw new Error('Real database access is disabled.'); };
  pool.getConnection = async () => ({
    execute: (...args) => pool.execute(...args),
    beginTransaction: async () => { transactionLog.push('begin'); },
    commit: async () => { transactionLog.push('commit'); },
    rollback: async () => { transactionLog.push('rollback'); },
    release: () => { transactionLog.push('release'); },
    destroy: () => { transactionLog.push('destroy'); },
  });
  pool.execute = async (sql, values) => {
    if (sql.startsWith('SELECT allocation_id, donation_id, inventory_id')) {
      assert.equal(sql, 'SELECT allocation_id, donation_id, inventory_id, units_allocated FROM request_allocations WHERE request_id = ?');
      assert.ok(listedRequests.some(row => row.request_id === values[0]));
      extraQueries.push({ sql, values });
      return [allocationRows.filter(row => row.request_id === values[0])];
    }
    if (sql.startsWith('SELECT d.donor_id, d.name')) {
      assert.ok(sql.includes("WHERE dr.request_id = ? AND dr.response = ?"));
      assert.equal(values[1], 'Accepted');
      extraQueries.push({ sql, values });
      return [acceptedRows.filter(row => row.request_id === values[0] && row.response === 'Accepted')
        .map(({ request_id, response, ...donor }) => donor)];
    }
    queries.push({ sql, values });
    if (sql.startsWith('SELECT recipient_id FROM recipients')) {
      assert.equal(sql, 'SELECT recipient_id FROM recipients WHERE recipient_id = ? LIMIT 1');
      assert.equal(values.length, 1);
      if (lookupError) { const error = new Error('Private database details'); error.code = lookupError; throw error; }
      return [recipientExists ? [{ recipient_id: values[0] }] : []];
    }
    if (sql.includes('FROM organizations o JOIN blood_banks')) {
      assert.ok(sql.endsWith(' = ? FOR SHARE'));
      assert.equal(values.length, 1);
      if (bankLookupError) throw new Error('Private database details');
      const organizationSelection = sql.includes('WHERE o.organization_id');
      return [bankExists ? [{ bank_id: organizationSelection ? 1 : values[0],
        organization_id: organizationSelection ? values[0] : 100 + values[0],
        organization_type: providerType, state: 'Maharashtra', city: 'Pune' }] : []];
    }
    if (sql.includes('FROM blood_banks b LEFT JOIN organizations')) {
      assert.equal(values.length, 1);
      return [bankExists ? [{ bank_id: values[0], organization_id: 100 + values[0],
        organization_type: providerType, state: 'Maharashtra', city: 'Pune', name: 'Selected bank' }] : []];
    }
    if (sql.startsWith('INSERT INTO blood_requests')) {
      assert.equal(sql, 'INSERT INTO blood_requests (recipient_id, bank_id, organization_id, state, city, blood_group, units_required, urgency_level, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      assert.equal(values.length, 9);
      assert.equal(values[8], 'Pending');
      if (insertError) { const error = new Error('Private database details'); error.code = insertError; throw error; }
      listedRequests.push({ request_id: 10, recipient_id: values[0], bank_id: values[1], organization_id: values[2], state: values[3], city: values[4], blood_group: values[5],
        units_required: values[6], urgency_level: values[7], status: values[8],
        request_date: '2026-01-01T00:00:00.000Z', donor_matching_started_at: null,
        bank_name:'Selected bank',bank_address:'Bank address',bank_phone:null,bank_email:null });
      return [{ insertId: 10 }];
    }
    if (sql.startsWith('SELECT r.request_id')) {
      assert.ok(sql.includes('LEFT JOIN blood_banks b ON b.bank_id = r.bank_id'));
      assert.ok(!/password|approved_by|phone FROM recipients/.test(sql));
      assert.ok(sql.includes('b.address AS bank_address, b.phone AS bank_phone, b.email AS bank_email'));
      const detail = sql.includes('AND r.request_id = ?');
      const owner = sql.includes('WHERE r.bank_id = ?') ? 'bank_id' : 'recipient_id';
      assert.equal(values.length, detail ? 2 : 1);
      if (listError) throw new Error('Private database details');
      const selected = listedRequests.filter(row => row[owner] === values[0] && (!detail || row.request_id === values[1]));
      assert.ok(sql.includes("ORDER BY CASE WHEN r.urgency_level = 'Emergency' THEN 0 ELSE 1 END"));
      assert.ok(sql.includes('r.request_date IS NULL ASC, r.request_date ASC'));
      return [(detail ? selected.slice(0, 1) : selected).map(requestRecord)];
    }
    throw new Error('Unexpected SQL statement');
  };
  // Actual index.js start karenge, taaki mounting aur JSON middleware bhi test ho.
  express.application.listen = function (...args) { server = originalListen.apply(this, args); return server; };
  process.env.PORT = '0';
  try { require('../index'); } finally {
    express.application.listen = originalListen;
    if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  }
  if (!server.listening) await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

beforeEach(() => {
  queries = []; extraQueries = []; allocationRows = []; acceptedRows = []; transactionLog = []; providerType = 'Blood Bank';
  recipientExists = true;
  bankExists = true;
  bankLookupError = null;
  lookupError = null;
  insertError = null;
  listError = null;
  listedRequests = [];
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  pool.execute = originalExecute;
  pool.getConnection = originalConnection; pool.query = originalQuery;
  express.application.listen = originalListen;
  if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  for (const name of jwtNames) {
    if (originalJwtEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = originalJwtEnvironment[name];
  }
  await pool.end();
});

test('request creation returns 201 and generated request ID', async () => {
  assert.deepEqual(await post(validInput, 201), { message: 'Blood request created successfully.', request_id: 10 });
  assert.equal(queries.length, 3);
  assert.deepEqual(queries[0].values, [1]);
  assert.deepEqual(queries[1].values, [1]);
  assert.deepEqual(queries[2].values, [1, 1, 101, 'Maharashtra', 'Pune', 'O+', 2, 'Emergency', 'Pending']);
});

for (const field of ['recipient_id', 'bank_id', 'blood_group', 'units_required']) {
  test('missing required ' + field + ' returns 400', async () => {
    const body = { ...validInput }; delete body[field];
    await post(body, 400);
    assert.equal(queries.length, 0);
  });
}

test('missing urgency uses the schema Normal default', async () => {
  const body = { ...validInput }; delete body.urgency_level;
  await post(body, 201);
  assert.equal(queries[2].values[7], 'Normal');
});

test('Normal urgency is accepted', async () => {
  await post({ ...validInput, urgency_level: 'Normal' }, 201);
  assert.equal(queries[2].values[7], 'Normal');
});

for (const field of ['recipient_id', 'bank_id', 'units_required']) {
  [null, '', '   ', '1', 0, -1, 1.5, 2147483648, true, [], {}, '1 OR 1=1'].forEach((value, index) => {
    test(field + ': invalid type/range case ' + (index + 1), async () => {
      await post({ ...validInput, [field]: value }, 400);
      assert.equal(queries.length, 0);
    });
  });
  for (const value of [1, 2147483647]) {
    test(field + ': positive INT boundary ' + value, async () => {
      await post({ ...validInput, [field]: value }, 201);
    });
  }
}

for (const blood_group of ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']) {
  test('supported blood group ' + blood_group, async () => {
    await post({ ...validInput, blood_group }, 201);
    assert.equal(queries[2].values[5], blood_group);
  });
}

['', '   ', null, 123, 'Unknown', 'o+', [], {}].forEach((value, index) => {
  test('invalid blood group case ' + (index + 1), async () => {
    await post({ ...validInput, blood_group: value }, 400);
    assert.equal(queries.length, 0);
  });
});

['', '   ', null, 123, 'Urgent', 'emergency', [], {}].forEach((value, index) => {
  test('invalid urgency case ' + (index + 1), async () => {
    await post({ ...validInput, urgency_level: value }, 400);
    assert.equal(queries.length, 0);
  });
});

test('client cannot set even Pending status', async () => {
  await post({ ...validInput, status: 'Pending' }, 400);
  assert.equal(queries.length,0);
});

['Processing', 'Fulfilled', 'Cancelled', '', 'pending', 'Unknown', null, 123].forEach((value, index) => {
  test('non-initial or invalid status case ' + (index + 1), async () => {
    await post({ ...validInput, status: value }, 400);
    assert.equal(queries.length, 0);
  });
});

for (const [field, value] of [
  ['request_id', 1], ['request_date', 'invalid-date'], ['request_date', '2026-01-01 00:00:00'],
  ['request_date', null], ['approved_by', 1], ['approved_by', null], ['donor_matching_started_at', '2026-01-01'], ['quantity', 2], ['priority', 1]
]) {
  test('server-managed or unsupported field rejected: ' + field + ' case ' + String(value === null ? 'null' : typeof value), async () => {
    await post({ ...validInput, [field]: value }, 400);
    assert.equal(queries.length, 0);
  });
}

[undefined, null, [], 'text', 123].forEach((value, index) => {
  test('invalid request body case ' + (index + 1), async () => {
    await post(value, 400);
    assert.equal(queries.length, 0);
  });
});

test('nonexistent recipient returns 404 without insert', async () => {
  recipientExists = false;
  assert.deepEqual(await post(validInput, 404), { message: 'Recipient not found.' });
  assert.equal(queries.length, 1);
});

test('bank or recipient removed between lookup and insert returns safe400', async () => {
  insertError = 'ER_NO_REFERENCED_ROW_2';
  assert.deepEqual(await post(validInput, 400), { message: 'The selected provider or recipient is no longer available.' });
});

test('genuine unique conflict returns safe 409', async () => {
  insertError = 'ER_DUP_ENTRY';
  assert.deepEqual(await post(validInput, 409), { message: 'Another operation changed this request. Refresh before retrying.' });
});

test('lookup database failure returns safe 500', async () => {
  lookupError = 'ER_ACCESS_DENIED_ERROR';
  assert.deepEqual(await post(validInput, 500), { message: 'Unable to create blood request.' });
  assert.equal(queries.length, 1);
});

test('insert deadlock returns safe retryable conflict', async () => {
  insertError = 'ER_LOCK_DEADLOCK';
  assert.deepEqual(await post(validInput, 409), { message: 'Another operation changed this request. Refresh before retrying.' });
});

test('malformed JSON returns 400', async () => {
  assert.deepEqual(await post('{', 400, true), { message: 'Invalid JSON request body.' });
  assert.equal(queries.length, 0);
});

test('oversized JSON returns 413', async () => {
  await post({ ...validInput, blood_group: 'x'.repeat(110000) }, 413);
  assert.equal(queries.length, 0);
});

test('GET returns an empty request list safely', async () => {
  const response = await fetch(baseUrl + '/api/requests', { headers: recipientHeaders() });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requests: [] });
  assert.equal(queries.length, 1);
});

test('GET preserves safe request columns and database priority order', async () => {
  listedRequests = [
    { request_id: 2, recipient_id: 1, blood_group: 'O+', units_required: 1,
      request_date: '2026-01-01T00:00:00.000Z', status: 'Pending', urgency_level: 'Emergency', approved_by: null },
    { request_id: 1, recipient_id: 1, blood_group: 'A+', units_required: 2,
      request_date: '2025-01-01T00:00:00.000Z', status: 'Pending', urgency_level: 'Normal', approved_by: null },
  ];
  const response = await fetch(baseUrl + '/api/requests', { headers: recipientHeaders() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assertSafe(body);
  assert.deepEqual(body, { requests: listedRequests.map(detailRecord) });
});

test('GET query-string input is not interpolated into SQL', async () => {
  const response = await fetch(baseUrl + '/api/requests?order=DROP%20TABLE%20blood_requests', { headers: recipientHeaders() });
  assert.equal(response.status, 200);
  assert.ok(!queries[0].sql.includes('DROP TABLE'));
});

test('GET failure returns safe 500', async () => {
  listError = 'ER_ACCESS_DENIED_ERROR';
  const response = await fetch(baseUrl + '/api/requests', { headers: recipientHeaders() });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { message: 'Unable to retrieve blood requests.' });
});

function historyRow(requestId, recipientId) {
  return { request_id: requestId, recipient_id: recipientId, blood_group: 'O+', units_required: 1,
    request_date: '2026-01-01T00:00:00.000Z', status: 'Pending', urgency_level: 'Normal', approved_by: null };
}
async function history(authorization, query = '') {
  const response = await fetch(baseUrl + '/api/requests' + query, {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
  const data = await response.json();
  assertSafe(data);
  return { status: response.status, data };
}
for (const owner of [1, 2]) {
  test('GET returns only JWT recipient ' + owner + ' records', async () => {
    listedRequests = [historyRow(31, 1), historyRow(41, 2)];
    const result = await history('Bearer ' + createToken(owner, 'recipient'));
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { requests: listedRequests.filter(row => row.recipient_id === owner).map(detailRecord) });
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].values, [owner]);
  });
}
for (const query of ['?recipient_id=2', '?recipient_id[]=2', '?recipient_id=2&recipient_id=1', '?recipient_id=1%20OR%201%3D1']) {
  test('GET query cannot override JWT ownership: ' + query, async () => {
    listedRequests = [historyRow(31, 1), historyRow(41, 2)];
    const result = await history('Bearer ' + createToken(1, 'recipient'), query);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { requests: [detailRecord(listedRequests[0])] });
    assert.deepEqual(queries[0].values, [1]);
    assert.ok(!queries[0].sql.includes('1 OR 1=1'));
  });
}
const rejectedHeaders = [
  ['missing token', () => undefined],
  ['malformed scheme', () => 'Basic abc'],
  ['invalid JWT', () => 'Bearer not-a-jwt'],
  ['expired JWT', () => 'Bearer ' + jwt.sign({ user_id: 1, user_type: 'recipient' }, testSecret, { algorithm: 'HS256', expiresIn: '-1s' })],
  ['wrong signing secret', () => 'Bearer ' + jwt.sign({ user_id: 1, user_type: 'recipient' }, otherSecret, { algorithm: 'HS256', expiresIn: '1h' })],
  ['tampered identity', () => {
    const [header, encoded, signature] = createToken(1, 'recipient').split('.');
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    payload.user_id = 2;
    return 'Bearer ' + header + '.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.' + signature;
  }],
];
for (const [label, makeHeader] of rejectedHeaders) {
  test('GET rejects ' + label + ' before SQL', async () => {
    const result = await history(makeHeader());
    assert.equal(result.status, 401);
    assert.deepEqual(Object.keys(result.data), ['message']);
    assert.equal(queries.length, 0);
  });
}
test('GET rejects donor identity before SQL', async () => {
  const result = await history('Bearer ' + createToken(1, 'donor'));
  assert.equal(result.status, 403);
  assert.deepEqual(result.data, { message: 'Your account cannot view these requests.' });
  assert.equal(queries.length, 0);
});
test('created request appears in a fresh authenticated history fetch', async () => {
  const created = await post(validInput, 201);
  const result = await history('Bearer ' + createToken(1, 'recipient'));
  assert.equal(result.status, 200);
  assert.equal(result.data.requests.length, 1);
  assert.equal(result.data.requests[0].request_id, created.request_id);
  assert.equal(result.data.requests[0].bank_id, validInput.bank_id);
  assert.equal(result.data.requests[0].status, 'Pending');
  assert.equal(queries.length, 4);
  assert.deepEqual(queries[3].values, [1]);
});

function requestRecord(row) {
  const { request_id, recipient_id, blood_group, units_required, urgency_level, status, request_date } = row;
  return { request_id, recipient_id, blood_group, units_required, urgency_level, status, request_date,
    bank_id: row.bank_id ?? null, organization_id: row.organization_id ?? (row.bank_id ? 100 + row.bank_id : null),
    state: row.state ?? (row.bank_id ? 'Maharashtra' : null), city: row.city ?? (row.bank_id ? 'Pune' : null),
    organization_type: row.bank_id ? 'Blood Bank' : null, organization_name: row.bank_name ?? null,
    donor_matching_started_at: row.donor_matching_started_at ?? null,
    bank_name: row.bank_name ?? null, bank_address: row.bank_address ?? null,
    bank_phone: row.bank_phone ?? null, bank_email: row.bank_email ?? null };
}
function detailRecord(row) {
  const allocations = allocationRows.filter(item => item.request_id === row.request_id);
  const inventory = allocations.filter(item => item.inventory_id != null).reduce((sum, item) => sum + item.units_allocated, 0);
  const donation = allocations.filter(item => item.donation_id != null).reduce((sum, item) => sum + item.units_allocated, 0);
  const historical = row.status === 'Fulfilled' && allocations.length === 0;
  const fulfilled = historical ? row.units_required : inventory + donation;
  const accepted = acceptedRows.filter(item => item.request_id === row.request_id && item.response === 'Accepted')
    .map(({ request_id, response, ...donor }) => {
      if (donor.screening_result !== 'Failed') return donor;
      return { donor_id: donor.donor_id, name: donor.name, blood_group: donor.blood_group,
        screening_result: donor.screening_result, screened_at: donor.screened_at };
    });
  return { ...requestRecord(row), fulfilled_units: fulfilled, remaining_units: row.units_required - fulfilled,
    inventory_units: inventory, donation_units: donation, history_available: !historical, accepted_donors: accepted };
}
async function details(rawId, authorization, query = '') {
  const response = await fetch(baseUrl + '/api/requests/' + encodeURIComponent(rawId) + query, {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
  const data = await response.json();
  assertSafe(data);
  return { status: response.status, data };
}
for (const status of ['Pending', 'Processing', 'Fulfilled', 'Cancelled']) {
  test('detail returns own request with stored ' + status + ' status', async () => {
    listedRequests = [{ ...historyRow(31, 1), status, urgency_level: 'Emergency' }];
    const result = await details('31', recipientHeaders().Authorization);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { request: detailRecord(listedRequests[0]) });
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].values, [1, 31]);
  });
}
test('detail preserves nullable legacy status and request date', async () => {
  listedRequests = [{ ...historyRow(31, 1), status: null, request_date: null }];
  const result = await details('31', recipientHeaders().Authorization);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { request: detailRecord(listedRequests[0]) });
});
for (const rawId of ['1', '0001', '2147483647']) {
  test('detail accepts digits-only ID boundary ' + rawId, async () => {
    listedRequests = [historyRow(Number(rawId), 1)];
    const result = await details(rawId, recipientHeaders().Authorization);
    assert.equal(result.status, 200);
    assert.equal(result.data.request.request_id, Number(rawId));
    assert.deepEqual(queries[0].values, [1, Number(rawId)]);
  });
}
for (const rawId of ['0', '-1', '1.5', '2147483648', '1e3', 'abc', 'null', '+1', ' 1 ', '1 OR 1=1']) {
  test('detail rejects invalid ID before SQL: ' + rawId, async () => {
    const result = await details(rawId, recipientHeaders().Authorization);
    assert.equal(result.status, 400);
    assert.deepEqual(Object.keys(result.data), ['message']);
    assert.equal(queries.length, 0);
  });
}
test('other-owner and missing request have the same safe 404', async () => {
  listedRequests = [historyRow(31, 2), historyRow(41, 1)];
  const other = await details('31', recipientHeaders().Authorization);
  const missing = await details('999', recipientHeaders().Authorization);
  assert.equal(other.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(other.data, missing.data);
  assert.deepEqual(Object.keys(other.data), ['message']);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries.map(query => query.values), [[1, 31], [1, 999]]);
});
test('detail binds a second authenticated owner correctly', async () => {
  listedRequests = [historyRow(31, 2)];
  const result = await details('31', recipientHeaders(2).Authorization);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { request: detailRecord(listedRequests[0]) });
  assert.deepEqual(queries[0].values, [2, 31]);
});
test('detail rejects donor JWT before SQL', async () => {
  const result = await details('31', 'Bearer ' + createToken(1, 'donor'));
  assert.equal(result.status, 403);
  assert.deepEqual(Object.keys(result.data), ['message']);
  assert.equal(queries.length, 0);
});
for (const [label, makeHeader] of rejectedHeaders) {
  test('detail rejects ' + label + ' before SQL', async () => {
    const result = await details('31', makeHeader());
    assert.equal(result.status, 401);
    assert.deepEqual(Object.keys(result.data), ['message']);
    assert.equal(queries.length, 0);
  });
}
for (const query of ['?recipient_id=2&request_id=31', '?recipient_id=1%20OR%201%3D1']) {
  test('detail query cannot replace URL/JWT identity: ' + query, async () => {
    listedRequests = [historyRow(31, 2), historyRow(41, 1)];
    const result = await details('41', recipientHeaders().Authorization, query);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { request: detailRecord(listedRequests[1]) });
    assert.deepEqual(queries[0].values, [1, 41]);
    assert.equal(queries.length, 1);
  });
}
test('detail hides database failure details', async () => {
  listError = 'ER_ACCESS_DENIED_ERROR';
  const result = await details('31', recipientHeaders().Authorization);
  assert.equal(result.status, 500);
  assert.deepEqual(result.data, { message: 'Unable to retrieve blood requests.' });
  assert.equal(queries.length, 1);
});
test('detail JWT configuration failure returns safe 500 before SQL', async () => {
  const authorization = recipientHeaders().Authorization;
  process.env.JWT_SECRET = 'short';
  try {
    const result = await details('31', authorization);
    assert.equal(result.status, 500);
    assert.deepEqual(result.data, { message: 'Authentication is temporarily unavailable.' });
    assert.equal(queries.length, 0);
  } finally {
    process.env.JWT_SECRET = testSecret;
  }
});

async function createWithAuth(body, authorization) {
  const response=await fetch(baseUrl+'/api/requests',{method:'POST',
    headers:{'Content-Type':'application/json',...(authorization?{Authorization:authorization}:{})},
    body:JSON.stringify(body)});
  const data=await response.json();assertSafe(data);return {status:response.status,data};
}
for(const [label,makeHeader] of rejectedHeaders){
  test('POST rejects '+label+' before SQL',async()=>{
    assert.equal((await createWithAuth(validInput,makeHeader())).status,401);assert.equal(queries.length,0);
  });
}
for(const role of ['donor','blood_bank']){
  test(role+' cannot create recipient requests',async()=>{
    assert.equal((await createWithAuth(validInput,'Bearer '+createToken(1,role))).status,403);assert.equal(queries.length,0);
  });
}
test('body recipient identity cannot override verified JWT',async()=>{
  assert.equal((await createWithAuth({...validInput,recipient_id:2},recipientHeaders().Authorization)).status,403);
  assert.equal(queries.length,0);
});
test('nonexistent selected bank is rejected before INSERT',async()=>{
  bankExists=false;await post(validInput,400);assert.equal(queries.length,2);
});
test('bank lookup failure is safely handled',async()=>{
  bankLookupError=true;await post(validInput,500);assert.equal(queries.length,2);
});
for(const owner of [1,2]){
  test('bank '+owner+' lists only selected own requests',async()=>{
    listedRequests=[{...historyRow(31,1),bank_id:1},{...historyRow(41,2),bank_id:2},{...historyRow(51,1),bank_id:null}];
    const result=await history('Bearer '+createToken(owner,'blood_bank'),'?bank_id=999&recipient_id=999');
    assert.equal(result.status,200);assert.deepEqual(result.data,{requests:[detailRecord(listedRequests[owner-1])]});
    assert.deepEqual(queries[0].values,[owner]);
  });
}
test('bank detail rejects foreign and legacy unassigned requests',async()=>{
  listedRequests=[{...historyRow(31,1),bank_id:1},{...historyRow(41,2),bank_id:2},{...historyRow(51,1),bank_id:null}];
  const authorization='Bearer '+createToken(1,'blood_bank');
  assert.equal((await details('31',authorization)).status,200);
  const foreign=await details('41',authorization);const legacy=await details('51',authorization);
  assert.equal(foreign.status,404);assert.deepEqual(foreign,legacy);
});
test('recipient sees public bank fields and actual fallback marker only',async()=>{
  listedRequests=[{...historyRow(31,1),bank_id:1,bank_name:'Selected bank',bank_address:'Bank address',
    bank_phone:'9876543210',bank_email:'contact@example.com',donor_matching_started_at:'2026-10-07T06:00:00.000Z'}];
  const result=await details('31',recipientHeaders().Authorization);
  assert.deepEqual(result.data.request,detailRecord(listedRequests[0]));
  assert.equal(result.data.request.accepted_donors.length, 0);
  assert.ok(!JSON.stringify(result.data.request).includes('password'));
});


test('organization request selection validates canonical location and saves real provider snapshots', async () => {
  const result = await post({ recipient_id: 1, organization_id: 101, state: 'Maharashtra', city: ' pune ',
    blood_group: 'O+', units_required: 7 }, 201);
  assert.equal(result.request_id, 10);
  assert.deepEqual(queries[2].values, [1, 1, 101, 'Maharashtra', 'Pune', 'O+', 7, 'Normal', 'Pending']);
  assert.deepEqual(transactionLog, ['begin', 'commit', 'release']);
});
test('NGO and mismatched selected state/city cannot create clinical requests', async () => {
  await post({ ...validInput, organization_id: 101, state: 'Karnataka', city: 'Pune' }, 400);
  await post({ ...validInput, organization_id: 101, state: 'Maharashtra', city: 'Mumbai' }, 400);
  providerType = 'NGO';
  await post({ ...validInput, organization_id: 101, state: 'Maharashtra', city: 'Pune' }, 400);
  assert.ok(queries.every(row => !row.sql.startsWith('INSERT')));
  assert.ok(!transactionLog.includes('commit'));
});
test('recipient contact privacy hides unaccepted and failed-screening donor contact', async () => {
  listedRequests = [historyRow(31, 1)];
  const donor = { request_id: 31, donor_id: 7, name: 'Memory donor', blood_group: 'O+',
    phone: '9876543209', email: 'private@example.invalid', response: 'Declined', screening_result: null, screened_at: null };
  acceptedRows = [donor];
  let result = await details('31', recipientHeaders().Authorization);
  assert.deepEqual(result.data.request.accepted_donors, []);
  donor.response = 'Accepted';
  result = await details('31', recipientHeaders().Authorization);
  assert.equal(result.data.request.accepted_donors[0].phone, donor.phone);
  donor.screening_result = 'Failed'; donor.screened_at = '2026-10-07';
  result = await details('31', recipientHeaders().Authorization);
  assert.ok(!JSON.stringify(result.data).includes(donor.phone));
  assert.ok(!JSON.stringify(result.data).includes(donor.email));
});
test('request detail reports donation/inventory progress and preserves historical missing allocations', async () => {
  listedRequests = [{ ...historyRow(31, 1), units_required: 8, status: 'Processing' }];
  allocationRows = [
    { request_id: 31, allocation_id: 1, donation_id: null, inventory_id: 1, units_allocated: 2 },
    { request_id: 31, allocation_id: 2, donation_id: 4, inventory_id: null, units_allocated: 1 },
  ];
  let result = await details('31', recipientHeaders().Authorization);
  assert.equal(result.data.request.fulfilled_units, 3);
  assert.equal(result.data.request.remaining_units, 5);
  assert.equal(result.data.request.inventory_units, 2);
  assert.equal(result.data.request.donation_units, 1);
  assert.equal(result.data.request.status, 'Processing');
  listedRequests[0].status = 'Fulfilled'; allocationRows = [];
  result = await details('31', recipientHeaders().Authorization);
  assert.equal(result.data.request.history_available, false);
  assert.equal(result.data.request.fulfilled_units, 8);
  assert.equal(result.data.request.inventory_units, 0);
  assert.equal(result.data.request.donation_units, 0);
  assert.ok(queries.every(row => !row.sql.startsWith('INSERT INTO request_allocations')));
});
