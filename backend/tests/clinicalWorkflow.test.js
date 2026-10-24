const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomBytes, randomUUID } = require('node:crypto');
const pool = require('../db');
const { createToken } = require('../services/jwtService');
const original = { execute: pool.execute, query: pool.query, getConnection: pool.getConnection,
  secret: process.env.JWT_SECRET, expiry: process.env.JWT_EXPIRES_IN };
let server, base, data, events, failNotification, notificationAttempts, rollbackFails;

function initialData() {
  return {
    providers: [
      { organization_id: 101, bank_id: 1, organization_type: 'Hospital', name: 'Memory hospital', state: 'Maharashtra', city: 'Pune' },
      { organization_id: 202, bank_id: 2, organization_type: 'Blood Bank', name: 'Memory blood bank', state: 'Maharashtra', city: 'Pune' },
      { organization_id: 303, bank_id: null, organization_type: 'NGO', name: 'Memory NGO', state: 'Maharashtra', city: 'Pune' },
    ],
    requests: [{ request_id: 27, recipient_id: 16, bank_id: 2, organization_id: 202,
      state: 'Maharashtra', city: 'Pune', blood_group: 'O+', units_required: 7,
      urgency_level: 'Emergency', status: 'Processing', donor_matching_started_at: '2026-10-07' }],
    donors: [{ donor_id: 3, name: 'Memory donor', blood_group: 'O+', is_available: 1,
      state: 'Maharashtra', city: 'Pune', phone: 'private-donor-phone', email: 'private-donor-email', last_donation: null }],
    recipients: [{ recipient_id: 16, phone: 'private-recipient-phone' }],
    responses: [{ request_id: 27, donor_id: 3, response: 'Accepted',
      screening_result: null, screened_at: null, screened_by_organization_id: null }],
    inventory: [{ inventory_id: 5, bank_id: 2, blood_group: 'O+', units_available: 0, version: 0 }],
    donations: [], allocations: [], notifications: [], nextDonation: 1, nextAllocation: 1,
  };
}
const identity = (id = 202, type = 'organization') => ({ id, type });
const donationBody = (units = 2, key = randomUUID(), donor = 3) => ({ donor_id: donor, units_donated: units, operation_key: key });

function failPrivate() {
  const error = new Error('Private SQL details must not reach the response');
  error.code = 'ER_TEST_NOTIFICATION';
  return error;
}
function assertSafe(body) {
  if (body && typeof body === 'object') for (const [key, value] of Object.entries(body)) {
    assert.ok(!['password', 'password_hash', 'stack', 'sql'].includes(key)); assertSafe(value);
  }
  assert.ok(!JSON.stringify(body).includes('Private SQL'));
  assert.ok(!JSON.stringify(body).includes('private-donor-phone'));
  assert.ok(!JSON.stringify(body).includes('private-recipient-phone'));
}
async function api(method, path, body, user = identity()) {
  const response = await fetch(base + path, { method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(user ? { Authorization: 'Bearer ' + createToken(user.id, user.type) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json(); assertSafe(result);
  return { status: response.status, body: result };
}
const screen = (result = 'Passed', user = identity(), donor = 3) =>
  api('POST', '/api/screenings/27', { donor_id: donor, result }, user);
const donate = (body = donationBody(), user = identity()) => api('POST', '/api/donations/27', body, user);
const allocate = (key = randomUUID(), user = identity()) =>
  api('POST', '/api/allocations/process/27', { operation_key: key }, user);
function passed(by = 202) {
  Object.assign(data.responses[0], { screening_result: 'Passed', screened_at: '2026-10-07', screened_by_organization_id: by });
}

async function executeInTransaction(working, sql, values = []) {
  events.push({ kind: 'sql', sql, values });
  if (sql.startsWith('SELECT request_id, recipient_id, bank_id, organization_id')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [working.requests.filter(row => row.request_id === values[0] && row.bank_id === values[1]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT request_id, recipient_id, status FROM blood_requests')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [working.requests.filter(row => row.request_id === values[0] && row.recipient_id === values[1]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT r.request_id')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [working.requests.filter(row => row.request_id === values[0]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT allocation_id, donation_id, inventory_id')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [working.allocations.filter(row => row.request_id === values[0]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT a.allocation_id')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [working.allocations.filter(row => row.request_id === values[0] && row.operation_key === values[1]).map(row => ({
      ...row, donor_id: working.donations.find(donation => donation.donation_id === row.donation_id)?.donor_id || null,
    }))];
  }
  if (sql.startsWith('SELECT donor_id, blood_group')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [working.donors.filter(row => row.donor_id === values[0]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT response')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [working.responses.filter(row => row.request_id === values[0] && row.donor_id === values[1]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('UPDATE donor_responses SET screening_result')) {
    const response = working.responses.find(row => row.request_id === values[2] && row.donor_id === values[3]);
    Object.assign(response, { screening_result: values[0], screened_at: '2026-10-07', screened_by_organization_id: values[1] });
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('INSERT INTO donations')) {
    const id = working.nextDonation++;
    working.donations.push({ donation_id: id, donor_id: values[0], bank_id: values[1], blood_group: values[2], units_donated: values[3] });
    return [{ insertId: id }];
  }
  if (sql.startsWith('INSERT INTO request_allocations')) {
    const inventory = sql.includes('VALUES (?, NULL, ?, ?, ?)');
    const id = working.nextAllocation++;
    const row = { allocation_id: id, request_id: values[0], donation_id: inventory ? null : values[1],
      inventory_id: inventory ? values[1] : null, units_allocated: values[2], operation_key: values[3] };
    if (working.allocations.some(existing => existing.request_id === row.request_id && existing.operation_key === row.operation_key)) {
      const error = new Error('Private duplicate key'); error.code = 'ER_DUP_ENTRY'; throw error;
    }
    working.allocations.push(row); return [{ insertId: id }];
  }
  if (sql.startsWith('UPDATE donors SET last_donation')) {
    working.donors.find(row => row.donor_id === values[0]).last_donation = '2026-10-07';
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('UPDATE blood_requests SET status')) {
    working.requests.find(row => row.request_id === values[1]).status = values[0];
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('SELECT inventory_id, bank_id, blood_group, units_available')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [working.inventory.filter(row => row.bank_id === values[0] && row.blood_group === values[1]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT units_available FROM blood_inventory')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [working.inventory.filter(row => row.bank_id === values[0] && row.blood_group === values[1]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('UPDATE blood_inventory SET units_available = units_available -')) {
    const stock = working.inventory.find(row => row.inventory_id === values[1]);
    if (!stock || stock.units_available < values[2]) return [{ affectedRows: 0 }];
    stock.units_available -= values[0]; stock.version++; return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('UPDATE blood_requests SET donor_matching_started_at')) {
    const request = working.requests.find(row => row.request_id === values[0]);
    if (!request.donor_matching_started_at) request.donor_matching_started_at = '2026-10-07';
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('SELECT donor_id, name, gender')) {
    return [working.donors.filter(row => row.blood_group === values[0] && row.is_available === values[1] &&
      row.state === values[2] && row.city.toLowerCase() === values[3].toLowerCase()).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT donor_id, response, screening_result')) {
    return [working.responses.filter(row => row.request_id === values[0]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT notification_id')) {
    return [working.notifications.filter(row => row.donor_id === values[0] && row.request_id === values[1] &&
      row.channel === values[2] && row.message === values[3])];
  }
  if (sql.startsWith('SELECT recipient_id, phone FROM recipients')) {
    return [working.recipients.filter(row => row.recipient_id === values[0])];
  }
  if (sql.startsWith('SELECT donor_id, phone FROM donors')) return [working.donors.filter(row => row.donor_id === values[0])];
  if (sql.startsWith('SELECT request_id FROM blood_requests')) return [working.requests.filter(row => row.request_id === values[0])];
  if (sql.startsWith('INSERT INTO notifications')) {
    notificationAttempts++;
    if (failNotification === notificationAttempts) throw failPrivate();
    const id = working.notifications.length + 1;
    working.notifications.push({ notification_id: id, donor_id: values[0], recipient_id: values[1],
      request_id: values[2], channel: values[3], message: values[4] });
    return [{ insertId: id }];
  }
  if (sql.startsWith('SELECT donor_id FROM donor_responses')) {
    return [working.responses.filter(row => row.request_id === values[0] && row.response === values[1])];
  }
  if (sql.startsWith('INSERT INTO donor_responses')) {
    working.responses.push({ request_id: values[0], donor_id: values[1], response: values[2],
      screening_result: null, screened_at: null, screened_by_organization_id: null });
    return [{ affectedRows: 1 }];
  }
  throw new Error('Unexpected transaction SQL in isolated clinical fixture: ' + sql);
}

before(async () => {
  process.env.JWT_SECRET = randomBytes(32).toString('hex'); process.env.JWT_EXPIRES_IN = '1h';
  pool.query = async () => { throw new Error('Real database access is disabled.'); };
  pool.execute = async (sql, values) => {
    events.push({ kind: 'provider', sql, values });
    assert.ok(sql.startsWith('SELECT'));
    assert.ok(sql.includes('FROM organizations o') || sql.includes('FROM blood_banks b LEFT JOIN organizations'));
    assert.ok(!sql.includes('password_hash'));
    const organization = sql.includes('WHERE o.organization_id');
    return [data.providers.filter(row => row[organization ? 'organization_id' : 'bank_id'] === values[0])
      .map(row => ({ ...row }))];
  };
  pool.getConnection = async () => {
    let working = null;
    return {
      beginTransaction: async () => { events.push({ kind: 'begin' }); working = structuredClone(data); },
      execute: async (sql, values) => {
        assert.ok(working, 'Every clinical SQL operation must be inside the transaction');
        return executeInTransaction(working, sql, values);
      },
      query: async () => { throw new Error('Raw connection.query access is disabled.'); },
      commit: async () => { events.push({ kind: 'commit' }); data = working; working = null; },
      rollback: async () => {
        events.push({ kind: 'rollback' }); working = null;
        if (rollbackFails) throw failPrivate();
      },
      release: () => { events.push({ kind: 'release' }); },
      destroy: () => { working = null; events.push({ kind: 'destroy' }); },
    };
  };
  const app = express(); app.use(express.json());
  app.use('/api/screenings', require('../routes/screeningRoutes'));
  app.use('/api/donations', require('../routes/donationRoutes'));
  app.use('/api/allocations', require('../routes/allocationRoutes'));
  app.use('/api/requests', require('../routes/requestRoutes'));
  app.use('/api/donors', require('../routes/donorRoutes'));
  server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(() => {
  data = initialData(); events = []; notificationAttempts = 0; failNotification = null; rollbackFails = false;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  pool.execute = original.execute; pool.query = original.query; pool.getConnection = original.getConnection;
  for (const [name, value] of [['JWT_SECRET', original.secret], ['JWT_EXPIRES_IN', original.expiry]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await pool.end();
});

for (const type of ['Hospital', 'Blood Bank']) {
  test(type + ' records owned screening without fulfilling or creating blood', async () => {
    const provider = data.providers.find(row => row.organization_type === type);
    data.requests[0].bank_id = provider.bank_id; data.requests[0].organization_id = provider.organization_id;
    const result = await screen('Passed', identity(provider.organization_id));
    assert.equal(result.status, 200); assert.equal(result.body.status, 'Processing');
    assert.equal(result.body.fulfilled_units, 0); assert.equal(result.body.remaining_units, 7);
    assert.equal(data.responses[0].screened_by_organization_id, provider.organization_id);
    assert.equal(data.donations.length, 0); assert.equal(data.allocations.length, 0);
    assert.equal(data.inventory[0].units_available, 0); assert.equal(data.notifications.length, 2);
  });
}
test('foreign provider gets the same safe missing-request response for screening and donation', async () => {
  const beforeAttempt = structuredClone(data);
  const screening = await screen('Passed', identity(101));
  assert.equal(screening.status, 404);
  assert.deepEqual(screening.body, { message: 'Blood request not found.' });
  const donation = await donate(donationBody(), identity(101));
  assert.equal(donation.status, 404);
  assert.deepEqual(donation.body, screening.body);
  assert.deepEqual(data, beforeAttempt);
  assert.equal(events.filter(event => event.kind === 'rollback').length, 2);
  assert.equal(events.filter(event => event.kind === 'commit').length, 0);
});
