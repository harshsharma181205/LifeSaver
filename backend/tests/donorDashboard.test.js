const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const pool = require('../db');
const { createToken } = require('../services/jwtService');
const original = { execute: pool.execute, query: pool.query, connection: pool.getConnection,
  listen: express.application.listen, port: process.env.PORT, secret: process.env.JWT_SECRET, expiry: process.env.JWT_EXPIRES_IN };
const secret = randomBytes(32).toString('hex');
let server, base, donors, requests, stock, allocations, queries, failure;
const row = { request_id: 27, recipient_id: 16, blood_group: 'O+', units_required: 3,
  bank_id: 1, donor_matching_started_at: '2026-10-07T06:30:00.000Z', donor_response: null,
  state: 'Maharashtra', city: 'Pune', screening_result: null, organization_id: 101,
  urgency_level: 'Normal', status: 'Pending', request_date: '2026-10-07T06:30:00.000Z' };
function allocationTotals(item) {
  const records = allocations.get(item.request_id) || [];
  return {
    fulfilled_units: records.reduce((sum, allocation) => sum + allocation.units_allocated, 0),
    inventory_units: records.filter(allocation => allocation.inventory_id != null).reduce((sum, allocation) => sum + allocation.units_allocated, 0),
    donation_units: records.filter(allocation => allocation.donation_id != null).reduce((sum, allocation) => sum + allocation.units_allocated, 0),
    allocation_count: records.length,
  };
}
const projection = item => {
  const totals = allocationTotals(item);
  const historical = item.status === 'Fulfilled' && totals.allocation_count === 0;
  const fulfilled = historical ? item.units_required : totals.fulfilled_units;
  return {
  request_id: item.request_id, blood_group: item.blood_group, units_required: item.units_required,
  urgency_level: item.urgency_level, status: item.status, request_date: item.request_date,
  organization_id: item.organization_id, state: item.state, city: item.city, organization_name: 'Selected Bank',
  bank_id: 1, bank_name: 'Selected Bank', bank_address: 'Pune', bank_phone: 'public-phone',
  bank_email: 'bank@example.org', donor_response: item.donor_response, screening_result: item.screening_result,
  fulfilled_units: fulfilled, inventory_units: totals.inventory_units, donation_units: totals.donation_units,
  remaining_units: item.units_required - fulfilled, history_available: !historical,
  ...(item.donor_response === 'Accepted' && item.screening_result !== 'Failed' ? {
    recipient: { name: 'Private recipient', age: 25, gender: 'Other', phone: '9876543299', email: 'private@example.invalid' },
  } : {}),
  };
};
async function get(token = createToken(1, 'donor'), query = '') {
  const response = await fetch(base + '/api/donors/me/matching-requests' + query, {
    headers: token === null ? {} : { Authorization: 'Bearer ' + token },
  });
  const data = await response.json();
  assert.ok(!JSON.stringify(data).includes('Private SQL'));
  return { status: response.status, data };
}
before(async () => {
  process.env.JWT_SECRET = secret; process.env.JWT_EXPIRES_IN = '1h';
  // Real SQL/writes disabled; matching fixtures memory mein hain.
  pool.query = pool.getConnection = async () => { throw new Error('Unexpected database operation'); };
  pool.execute = async (sql, values) => {
    assert.ok(sql.startsWith('SELECT')); assert.ok(!sql.includes('FOR UPDATE'));
    queries.push({ sql, values });
    if (failure) throw new Error('Private SQL details');
    if (sql === 'SELECT blood_group, is_available FROM donors WHERE donor_id = ? LIMIT 1') {
      const donor = donors.get(values[0]); return [donor ? [donor] : []];
    }
    assert.ok(sql.startsWith('SELECT r.request_id, r.blood_group'));
    assert.ok(sql.includes("r.urgency_level IN ('Normal','Emergency')") || sql.includes("r.urgency_level IN ('Normal', 'Emergency')"));
    assert.ok(/d\.donor_id\s*=\s*\?/.test(sql));
    assert.ok(sql.includes("r.status IN ('Pending','Processing')"));
    assert.ok(sql.includes('r.donor_matching_started_at IS NOT NULL'));
    assert.ok(sql.includes('SUM(a.units_allocated)'));
    assert.ok(sql.includes('AND a.inventory_id IS NOT NULL),0) AS inventory_units'));
    assert.ok(sql.includes('AND a.donation_id IS NOT NULL),0) AS donation_units'));
    assert.ok(sql.includes('COUNT(*) FROM request_allocations a WHERE a.request_id=r.request_id'));
    assert.ok(sql.includes('i.bank_id=r.bank_id AND i.blood_group=r.blood_group'));
    assert.ok(sql.includes('),0)>=0'));
    assert.ok(sql.includes('),0)<r.units_required-COALESCE('));
    assert.ok(/r\.request_date IS NULL ASC\s*,\s*r\.request_date(?: ASC)?/.test(sql));
    assert.ok(/d\.state\s*=\s*COALESCE\(r\.state,o\.state\)/.test(sql));
    assert.ok(/LOWER\(d\.city\)\s*=\s*LOWER\(COALESCE\(r\.city,o\.city\)\)/.test(sql));
    assert.ok(sql.includes("dr.response='Accepted'"));
    assert.ok(sql.includes("THEN p.phone END AS recipient_phone"));
    assert.ok(!/\b(?:password|latitude|radius|longitude)\b/i.test(sql));
    assert.deepEqual(values.length, 1);
    const donor = donors.get(values[0]);
    if (!donor) return [[]];
    const matches = requests.filter(item => {
      if (item.blood_group !== donor.blood_group || item.bank_id !== 1) return false;
      if (item.donor_response === 'Accepted') return true;
      const remaining = item.units_required - allocationTotals(item).fulfilled_units;
      const units = stock.find(bank => bank.bank_id === item.bank_id && bank.blood_group === item.blood_group)?.units_available ?? 0;
      return donor.is_available === 1 && ['Pending', 'Processing'].includes(item.status) &&
        item.donor_matching_started_at != null && item.donor_response == null &&
        ['Normal', 'Emergency'].includes(item.urgency_level) && item.recipient_id > 0 && remaining > 0 &&
        donor.state === item.state && typeof donor.city === 'string' && typeof item.city === 'string' &&
        donor.city.toLowerCase() === item.city.toLowerCase() && units >= 0 && units < remaining;
    });
    matches.sort((a, b) => Number(b.urgency_level === 'Emergency') - Number(a.urgency_level === 'Emergency')
      || Number(a.request_date === null) - Number(b.request_date === null)
      || String(a.request_date).localeCompare(String(b.request_date)) || a.request_id - b.request_id);
    return [matches.map(item => {
      const safe = projection(item);
      const { recipient, remaining_units, history_available, ...raw } = safe;
      const totals = allocationTotals(item);
      // MySQL SUM values decimal strings ke roop mein aa sakti hain.
      return { ...raw, fulfilled_units: String(totals.fulfilled_units), inventory_units: String(totals.inventory_units),
        donation_units: String(totals.donation_units), allocation_count: totals.allocation_count,
        recipient_name: recipient?.name || null, recipient_age: recipient?.age || null,
        recipient_gender: recipient?.gender || null, recipient_phone: recipient?.phone || null,
        recipient_email: recipient?.email || null };
    })];
  };
  express.application.listen = function (...args) { server = original.listen.apply(this, args); return server; };
  process.env.PORT = '0'; try { require('../index'); } finally { express.application.listen = original.listen; }
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(() => {
  process.env.JWT_SECRET = secret; process.env.JWT_EXPIRES_IN = '1h';
  donors = new Map([[1, { blood_group: 'O+', is_available: 1, location: 'Legacy area', state: 'Maharashtra', city: 'Pune' }],
    [2, { blood_group: 'A+', is_available: 1, location: null, state: 'Maharashtra', city: 'Pune' }]]);
  requests = [{ ...row }]; stock = []; allocations = new Map(); queries = []; failure = false;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  pool.execute = original.execute; pool.query = original.query; pool.getConnection = original.connection;
  express.application.listen = original.listen;
  for (const [key, value] of [['PORT', original.port], ['JWT_SECRET', original.secret], ['JWT_EXPIRES_IN', original.expiry]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await pool.end();
});
test('available donor sees safe provider/location/progress fields without private recipient contact', async () => {
  const result = await get();
  assert.equal(result.status, 200); assert.deepEqual(result.data, { requests: [projection(row)] });
  assert.deepEqual(queries[0].values, [1]); assert.deepEqual(queries[1].values, [1]);
});
for (const units of [0, 1, 2, 3, 4]) {
  test('same-group stock threshold ' + units, async () => {
    stock = [{ bank_id: 1, blood_group: 'O+', units_available: units }];
    assert.equal((await get()).data.requests.length, units < 3 ? 1 : 0);
  });
}
test('other bank stock cannot prevent selected-bank donor fallback', async () => {
  stock = [{ bank_id: 1, blood_group: 'O+', units_available: 2 }, { bank_id: 2, blood_group: 'O+', units_available: 999 },
    { bank_id: 1, blood_group: 'A+', units_available: 999 }];
  assert.equal((await get()).data.requests.length, 1);
});
test('request must have actually triggered donor matching', async () => {
  requests[0].donor_matching_started_at = null; assert.deepEqual((await get()).data.requests, []);
});
test('legacy unassigned request is never silently matched', async () => {
  requests[0].bank_id = null; assert.deepEqual((await get()).data.requests, []);
});
test('accepted response remains visible for screening while declined response is hidden', async () => {
  requests[0].donor_response = 'Accepted';
  assert.equal((await get()).data.requests[0].donor_response, 'Accepted');
  requests[0].donor_response = 'Declined'; assert.deepEqual((await get()).data.requests, []);
});

for (const availability of [0, null, 2]) {
  test('non-available donor has no candidates: ' + availability, async () => {
    donors.get(1).is_available = availability;
    assert.deepEqual((await get()).data.requests, []);
  });
}
test('unrelated blood groups stay hidden and URL/body identity cannot override donor', async () => {
  requests.push({ ...row, request_id: 28, blood_group: 'A+' });
  const first = await get(createToken(1, 'donor'), '?donor_id=2&blood_group=A%2B&is_available=1');
  assert.deepEqual(first.data.requests.map(item => item.request_id), [27]);
  const second = await get(createToken(2, 'donor'));
  assert.deepEqual(second.data.requests.map(item => item.request_id), [28]);
  assert.deepEqual(queries.at(-1).values, [2]);
});
for (const status of ['Fulfilled', 'Cancelled', null]) {
  test('closed or invalid request is hidden: ' + status, async () => {
    requests[0].status = status; assert.deepEqual((await get()).data.requests, []);
  });
}
for (const urgency of [null, 'Unsupported']) {
  test('invalid request urgency is not a fallback candidate: ' + urgency, async () => {
    requests[0].urgency_level = urgency; assert.deepEqual((await get()).data.requests, []);
  });
}

test('existing allocations exclude request without changing database data', async () => {
  allocations.set(27, [{ inventory_id: 2, donation_id: null, units_allocated: row.units_required }]);
  assert.deepEqual((await get()).data.requests, []);
});
test('same state/city controls matching while legacy free-text area cannot override it', async () => {
  donors.get(1).location = null; requests[0].location = 'Other area';
  assert.equal((await get()).data.requests.length, 1);
  donors.get(1).city = 'Mumbai';
  assert.equal((await get()).data.requests.length, 0);
  donors.get(1).city = 'Pune'; donors.get(1).state = 'Karnataka';
  assert.equal((await get()).data.requests.length, 0);
});
test('priority/date/ID ordering follows the existing request list', async () => {
  requests = [{ ...row, request_id: 30, request_date: null }, { ...row, request_id: 29 },
    { ...row, request_id: 28, urgency_level: 'Emergency' }, { ...row, request_id: 27 }];
  assert.deepEqual((await get()).data.requests.map(item => item.request_id), [28, 27, 29, 30]);
});
test('missing account returns safe404', async () => { donors.clear(); assert.equal((await get()).status, 404); });
test('database failure is safe500', async () => { failure = true; const result = await get(); assert.equal(result.status, 500); assert.deepEqual(Object.keys(result.data), ['message']); });
for (const [label, token] of [
  ['missing', () => null], ['invalid', () => 'not-a-jwt'],
  ['expired', () => jwt.sign({ user_id: 1, user_type: 'donor' }, secret, { expiresIn: '-1s' })],
  ['wrong secret', () => jwt.sign({ user_id: 1, user_type: 'donor' }, randomBytes(32).toString('hex'), { expiresIn: '1h' })],
]) {
  test(label + ' JWT is rejected before SQL', async () => { assert.equal((await get(token())).status, 401); assert.equal(queries.length, 0); });
}
test('recipient JWT is forbidden before SQL', async () => { assert.equal((await get(createToken(1, 'recipient'))).status, 403); assert.equal(queries.length, 0); });

test('blood bank JWT cannot see donor matching opportunities', async () => { assert.equal((await get(createToken(1, 'blood_bank'))).status, 403); assert.equal(queries.length, 0); });

test('corrupted negative stock is not eligible fallback', async () => { stock = [{ bank_id: 1, blood_group: 'O+', units_available: -1 }]; assert.deepEqual((await get()).data.requests, []); });


test('Processing requests with remaining units retain candidate matching', async () => {
  requests[0].status = 'Processing';
  allocations.set(27, [{ inventory_id: 2, donation_id: null, units_allocated: 1 }]);
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.data.requests[0].fulfilled_units, 1);
  assert.equal(result.data.requests[0].remaining_units, 2);
});
test('recipient contact unlocks after acceptance and hides again after Failed screening', async () => {
  let result = await get();
  assert.ok(!JSON.stringify(result.data).includes('9876543299'));
  assert.ok(!result.data.requests[0].recipient);
  requests[0].donor_response = 'Accepted'; requests[0].status = 'Processing';
  result = await get();
  assert.equal(result.data.requests[0].recipient.phone, '9876543299');
  requests[0].screening_result = 'Failed';
  result = await get();
  assert.ok(!JSON.stringify(result.data).includes('9876543299'));
  assert.ok(!result.data.requests[0].recipient);
});
test('accepted commitments remain visible after availability, location or fulfilled-status changes', async () => {
  requests[0].donor_response = 'Accepted'; requests[0].status = 'Fulfilled';
  donors.get(1).is_available = 0; donors.get(1).city = 'Mumbai';
  const result = await get();
  assert.equal(result.status, 200);
  assert.equal(result.data.requests[0].donor_response, 'Accepted');
});

test('reopening a partially fulfilled accepted request returns current numeric source totals', async () => {
  requests[0] = { ...row, units_required: 10, status: 'Processing', donor_response: 'Accepted', screening_result: 'Passed' };
  allocations.set(27, [
    { inventory_id: 2, donation_id: null, units_allocated: 3 },
    { inventory_id: null, donation_id: 8, units_allocated: 2 },
  ]);
  for (let reopen = 0; reopen < 2; reopen++) {
    const result = await get();
    assert.equal(result.status, 200);
    const request = result.data.requests[0];
    assert.deepEqual(request, projection(requests[0]));
    assert.deepEqual([request.fulfilled_units, request.inventory_units, request.donation_units, request.remaining_units], [5, 3, 2, 5]);
    assert.equal(request.history_available, true);
    assert.equal(request.recipient.phone, '9876543299');
    assert.equal(Object.hasOwn(request, 'allocation_count'), false);
    assert.equal(Object.hasOwn(request, 'recipient_phone'), false);
  }
  assert.equal(allocations.get(27).length, 2);
});

test('reopening a fulfilled accepted request preserves inventory plus actual donation totals', async () => {
  requests[0] = { ...row, status: 'Fulfilled', donor_response: 'Accepted', screening_result: 'Passed' };
  donors.get(1).is_available = 0;
  allocations.set(27, [
    { inventory_id: 2, donation_id: null, units_allocated: 2 },
    { inventory_id: null, donation_id: 8, units_allocated: 1 },
  ]);
  for (let reopen = 0; reopen < 2; reopen++) {
    const result = await get();
    assert.equal(result.status, 200);
    const request = result.data.requests[0];
    assert.deepEqual(request, projection(requests[0]));
    assert.deepEqual([request.fulfilled_units, request.inventory_units, request.donation_units, request.remaining_units], [3, 2, 1, 0]);
    assert.equal(request.history_available, true);
  }
});

test('historical fulfilled request without allocations remains fulfilled with unavailable source history', async () => {
  requests[0] = { ...row, units_required: 7, status: 'Fulfilled', donor_response: 'Accepted' };
  for (let reopen = 0; reopen < 2; reopen++) {
    const result = await get();
    assert.equal(result.status, 200);
    const request = result.data.requests[0];
    assert.equal(request.status, 'Fulfilled');
    assert.deepEqual([request.fulfilled_units, request.remaining_units, request.inventory_units, request.donation_units], [7, 0, 0, 0]);
    assert.equal(request.history_available, false);
  }
  assert.equal(allocations.size, 0);
  assert.ok(queries.every(query => query.sql.startsWith('SELECT')));
});

test('acceptance and Passed screening alone report zero fulfilled units', async () => {
  requests[0] = { ...row, status: 'Processing', donor_response: 'Accepted', screening_result: 'Passed' };
  const request = (await get()).data.requests[0];
  assert.deepEqual([request.fulfilled_units, request.remaining_units, request.inventory_units, request.donation_units], [0, 3, 0, 0]);
  assert.equal(request.history_available, true);
  assert.equal(request.recipient.phone, '9876543299');
});

test('source totals do not unlock private patient information before acceptance or after Failed screening', async () => {
  requests[0] = { ...row, units_required: 9, status: 'Processing' };
  allocations.set(27, [
    { inventory_id: 2, donation_id: null, units_allocated: 2 },
    { inventory_id: null, donation_id: 8, units_allocated: 1 },
  ]);
  for (const failed of [false, true]) {
    if (failed) { requests[0].donor_response = 'Accepted'; requests[0].screening_result = 'Failed'; }
    const result = await get();
    const request = result.data.requests[0];
    assert.deepEqual([request.fulfilled_units, request.inventory_units, request.donation_units, request.remaining_units], [3, 2, 1, 6]);
    assert.equal(Object.hasOwn(request, 'recipient'), false);
    assert.equal(Object.hasOwn(request, 'recipient_name'), false);
    assert.equal(Object.hasOwn(request, 'recipient_phone'), false);
    assert.ok(!JSON.stringify(result.data).includes('9876543299'));
    assert.ok(!JSON.stringify(result.data).includes('private@example.invalid'));
  }
});
