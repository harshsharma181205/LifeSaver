const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomBytes, scrypt } = require('node:crypto');
const { promisify } = require('node:util');
const pool = require('../db');
const { createToken, verifyToken } = require('../services/jwtService');
const { resolveProvider } = require('../services/organizationService');
const { INDIAN_STATES, normalizeState, normalizeCity, sameCity } = require('../services/locationService');
const deriveKey = promisify(scrypt);
const original = { execute: pool.execute, getConnection: pool.getConnection,
  secret: process.env.JWT_SECRET, expiry: process.env.JWT_EXPIRES_IN };
const password = 'Temporary-password-for-memory-only';
let server, baseUrl, hash, queries, transaction, failInsert, organizations, persons, bankRows;

function safe(body) {
  for (const [key, value] of Object.entries(body || {})) {
    assert.ok(!['password', 'password_hash', 'sql', 'stack'].includes(key));
    if (value && typeof value === 'object') safe(value);
  }
  assert.ok(!JSON.stringify(body).includes(password));
}

async function request(method, path, body, identity) {
  const response = await fetch(baseUrl + path, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(identity ? { Authorization: 'Bearer ' + createToken(identity.id, identity.type) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  safe(data);
  return { status: response.status, data };
}

const registration = type => ({ organization_type: type, name: 'Memory provider',
  state: 'Maharashtra', city: 'Pune', address: 'Temporary test address',
  phone: '9876543200', email: 'memory@example.invalid', password });

before(async () => {
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.JWT_EXPIRES_IN = '1h';
  const salt = randomBytes(16).toString('hex');
  hash = 'scrypt:' + salt + ':' + (await deriveKey(password, salt, 64)).toString('hex');
  pool.execute = async (sql, values = []) => {
    queries.push({ sql, values });
    if (sql.startsWith('SELECT DISTINCT o.city')) return [[{ city: 'Pune' }, { city: 'pune' }, { city: 'Nagpur' }]];
    if (sql.startsWith('SELECT o.organization_id, o.organization_type, o.name, o.state, o.city, o.address, b.bank_id')) {
      return [organizations.filter(row => row.bank_id && row.organization_type !== 'NGO' &&
        row.state && row.city && (!values[0] || row.state === values[0]) &&
        (!values[1] || sameCity(row.city, values[1])))
        .map(({ phone, email, password_hash, ...row }) => row)];
    }
    if (sql.includes('FROM organizations o')) {
      let rows = organizations;
      if (sql.includes('WHERE o.email')) rows = rows.filter(row => row.email.toLowerCase() === values[0]);
      else if (sql.includes('WHERE o.phone')) rows = rows.filter(row => row.phone === values[0]);
      else if (sql.includes('WHERE o.organization_id')) rows = rows.filter(row => row.organization_id === values[0]);
      else if (sql.includes('WHERE b.bank_id')) rows = rows.filter(row => row.bank_id === values[0]);
      return [rows];
    }
    if (sql.startsWith('SELECT donor_id') || sql.startsWith('SELECT recipient_id')) {
      const type = sql.startsWith('SELECT donor_id') ? 'donor' : 'recipient';
      const column = sql.includes('WHERE email') ? 'email' : 'phone';
      assert.ok(sql.includes('WHERE ' + column + ' = ? LIMIT 2'));
      return [persons[type].filter(row => row[column] === values[0])];
    }
    if (sql.includes('FROM blood_banks b LEFT JOIN organizations')) {
      if (sql.includes('WHERE b.email = ?')) {
        assert.ok(sql.includes("b.organization_id IS NULL OR o.organization_type = 'Blood Bank'"));
        return [bankRows.filter(row => row.email === values[0] && (!row.organization_id || row.organization_type === 'Blood Bank'))];
      }
      const bank = bankRows.find(row => row.bank_id === values[0]);
      return [bank ? [bank] : []];
    }
    if (sql.startsWith('SELECT bank_id, bank_name')) return [bankRows.filter(row => row.email === values[0])];
    throw new Error('Unexpected SQL in organization test fixture: ' + sql);
  };
  pool.getConnection = async () => ({
    beginTransaction: async () => { transaction.push('begin'); },
    commit: async () => { transaction.push('commit'); },
    rollback: async () => { transaction.push('rollback'); },
    release: () => { transaction.push('release'); },
    execute: async (sql, values) => {
      queries.push({ sql, values });
      if (sql.startsWith('INSERT INTO organizations')) {
        if (failInsert && failInsert !== 'BANK_FAILURE') { const error = new Error('Private SQL data'); error.code = failInsert; throw error; }
        return [{ insertId: 42 }];
      }
      if (sql.startsWith('INSERT INTO blood_banks')) {
        if (failInsert === 'BANK_FAILURE') throw new Error('Bank insertion failed');
        return [{ insertId: 7 }];
      }
      if (sql.startsWith('UPDATE organizations')) {
        const row = organizations.find(row => row.organization_id === values[2]);
        row.state = values[0]; row.city = values[1];
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('FOR UPDATE')) {
        const identityColumn = sql.includes('WHERE o.organization_id') ? 'organization_id' : 'bank_id';
        return [organizations.filter(row => row[identityColumn] === values[0])];
      }
      throw new Error('Unexpected transaction SQL');
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/organizations', require('../routes/organizationRoutes'));
  app.use('/api/auth', require('../routes/authRoutes'));
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

beforeEach(() => {
  queries = []; transaction = []; failInsert = null;
  organizations = [{ organization_id: 42, organization_type: 'Hospital', name: 'Memory hospital',
    state: 'Maharashtra', city: 'Pune', address: 'Temporary address', phone: '9876543200',
    email: 'hospital@example.invalid', password_hash: hash, bank_id: 7 }];
  persons = {
    donor: [{ donor_id: 3, name: 'Memory donor', blood_group: 'O+', location: 'Pune',
      phone: '9876543201', email: 'donor@example.invalid', is_available: 1, password_hash: hash }],
    recipient: [{ recipient_id: 4, name: 'Memory recipient', gender: 'Other', blood_group: 'A+',
      age: 20, phone: '9876543202', email: 'recipient@example.invalid', monitored_by: null, password_hash: hash }],
  };
  bankRows = [{ bank_id: 7, bank_name: 'Memory hospital', organization_id: 42,
    organization_type: 'Hospital', name: 'Memory hospital', state: null, city: null,
    phone: '9876543200', email: 'bank@example.invalid', address: 'Temporary address', password_hash: hash }];
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  pool.execute = original.execute; pool.getConnection = original.getConnection;
  for (const [name, value] of [['JWT_SECRET', original.secret], ['JWT_EXPIRES_IN', original.expiry]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await pool.end();
});

test('canonical locations cover all states and normalize city whitespace/case', () => {
  assert.equal(INDIAN_STATES.length, 36);
  assert.equal(new Set(INDIAN_STATES).size, 36);
  assert.equal(normalizeState('  maharashtra '), 'Maharashtra');
  assert.equal(normalizeState('invented state'), null);
  assert.equal(normalizeCity('  Navi   Mumbai '), 'Navi Mumbai');
  assert.equal(sameCity('navi mumbai', ' Navi  Mumbai '), true);
  assert.equal(sameCity('Pune', 'Mumbai'), false);
  assert.equal(normalizeCity('Pune\nprivate'), null);
  assert.equal(normalizeCity('<script>'), null);
});

for (const type of ['Hospital', 'Blood Bank', 'NGO']) {
  test(type + ' registration creates the correct companion in one transaction', async () => {
    const body = registration(type); body.city = ' Navi   Mumbai '; body.state = 'maharashtra';
    const result = await request('POST', '/api/organizations', body);
    assert.equal(result.status, 201);
    assert.equal(result.data.organization.organization_type, type);
    assert.equal(result.data.organization.state, 'Maharashtra');
    assert.equal(result.data.organization.city, 'Navi Mumbai');
    assert.equal(result.data.organization.bank_id, type === 'NGO' ? null : 7);
    assert.deepEqual(transaction, ['begin', 'commit', 'release']);
    const inserts = queries.filter(row => row.sql.startsWith('INSERT'));
    assert.equal(inserts.length, type === 'NGO' ? 1 : 2);
    assert.match(inserts[0].values[7], /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
    assert.ok(!inserts[0].values.includes(password));
    if (type !== 'NGO') assert.equal(inserts[1].values[0], 42);
  });
}
for (const invalid of [
  { organization_type: 'Admin' }, { state: 'Unknown' }, { city: '' }, { phone: 'invalid' },
  { email: 'invalid' }, { password: 'short' }, { address: '' }, { user_id: 99 },
]) {
  test('organization registration validates ' + Object.keys(invalid)[0] + ' before SQL', async () => {
    const result = await request('POST', '/api/organizations', { ...registration('Hospital'), ...invalid });
    assert.equal(result.status, 400);
    assert.equal(queries.length, 0);
    assert.equal(transaction.length, 0);
  });
}

test('duplicate organization identity rolls back with safe conflict response', async () => {
  failInsert = 'ER_DUP_ENTRY';
  const result = await request('POST', '/api/organizations', registration('Blood Bank'));
  assert.equal(result.status, 409);
  assert.deepEqual(transaction, ['begin', 'rollback', 'release']);
});

for (const type of ['Hospital', 'Blood Bank', 'NGO']) {
  test(type + ' organization phone/email login issues organization identity and safe profile', async () => {
    organizations[0].organization_type = type;
    organizations[0].bank_id = type === 'NGO' ? null : 7;
    for (const identifier of ['9876543200', 'HOSPITAL@example.invalid']) {
      const result = await request('POST', '/api/auth/organization/login', { identifier, password });
      assert.equal(result.status, 200);
      assert.deepEqual(verifyToken(result.data.token), { user_id: 42, user_type: 'organization' });
      assert.equal(result.data.user.organization_type, type);
      assert.equal(result.data.user.bank_id, type === 'NGO' ? null : 7);
    }
    const profile = await request('GET', '/api/auth/me', undefined, { id: 42, type: 'organization' });
    assert.equal(profile.status, 200);
    assert.equal(profile.data.organization_type, type);
  });
}
test('organization wrong password and ambiguous identifier return a safe 401', async () => {
  const wrong = await request('POST', '/api/auth/organization/login',
    { identifier: 'hospital@example.invalid', password: password + 'wrong' });
  assert.equal(wrong.status, 401);
  organizations.push({ ...organizations[0], organization_id: 43 });
  const duplicate = await request('POST', '/api/auth/organization/login',
    { identifier: 'hospital@example.invalid', password });
  assert.equal(duplicate.status, 401);
});

for (const type of ['donor', 'recipient']) {
  test(type + ' keeps legacy phone login and accepts email identifier', async () => {
    const row = persons[type][0];
    for (const identity of [{ phone: row.phone }, { identifier: row.phone }, { identifier: row.email }]) {
      const result = await request('POST', '/api/auth/' + type + '/login', { ...identity, password });
      assert.equal(result.status, 200);
      assert.deepEqual(verifyToken(result.data.token), { user_id: row[type + '_id'], user_type: type });
    }
  });
}
test('legacy blood-bank login keeps its bank identity and current profile shows location completion', async () => {
  bankRows[0].organization_type = 'Blood Bank';
  const result = await request('POST', '/api/auth/blood-bank/login', { email: bankRows[0].email, password });
  assert.equal(result.status, 200);
  assert.deepEqual(verifyToken(result.data.token), { user_id: 7, user_type: 'blood_bank' });
  const me = await request('GET', '/api/auth/me', undefined, { id: 7, type: 'blood_bank' });
  assert.equal(me.status, 200);
  assert.equal(me.data.organization_id, 42);
  assert.equal(me.data.organization_type, 'Blood Bank');
  assert.equal(me.data.state, null);
  assert.equal(me.data.bank_id, 7);
});

test('provider authorization resolves the database type and excludes NGO', async () => {
  const organization = await resolveProvider({ user_id: 42, user_type: 'organization', organization_type: 'NGO' });
  assert.equal(organization.bank_id, 7);
  assert.equal(organization.organization_type, 'Hospital');
  organizations[0].organization_type = 'NGO';
  assert.equal(await resolveProvider({ user_id: 42, user_type: 'organization', organization_type: 'Blood Bank' }), null);
  assert.equal(await resolveProvider({ user_id: 42, user_type: 'recipient' }), null);
  const legacy = await resolveProvider({ user_id: 7, user_type: 'blood_bank' });
  assert.equal(legacy.organization_id, 42);
});

test('directory filters real clinical providers by canonical state and city', async () => {
  organizations.push({ ...organizations[0], organization_id: 43, organization_type: 'NGO', bank_id: null });
  organizations.push({ ...organizations[0], organization_id: 44, city: 'Mumbai' });
  const result = await request('GET', '/api/organizations?state=maharashtra&city=PuNe');
  assert.equal(result.status, 200);
  assert.equal(result.data.organizations.length, 1);
  assert.equal(result.data.organizations[0].organization_id, 42);
  assert.deepEqual(queries[0].values, ['Maharashtra', 'PuNe']);
  assert.ok(!queries[0].sql.includes('password_hash'));
  assert.ok(!queries[0].sql.includes('email'));
  const cities = await request('GET', '/api/organizations/cities?state=Maharashtra');
  assert.equal(cities.status, 200);
  assert.deepEqual(cities.data.cities, ['Pune', 'Nagpur']);
});
test('directory rejects an unknown state or a city without a state before SQL', async () => {
  assert.equal((await request('GET', '/api/organizations?state=unknown')).status, 400);
  assert.equal((await request('GET', '/api/organizations?city=Pune')).status, 400);
  assert.equal(queries.length, 0);
});
for (const identity of [{ type: 'organization', id: 42 }, { type: 'blood_bank', id: 7 }]) {
  test(identity.type + ' location update uses the authenticated mapping and leaves request snapshots untouched', async () => {
    const result = await request('PUT', '/api/organizations/me/location',
      { state: 'Karnataka', city: '  Bengaluru  ' }, identity);
    assert.equal(result.status, 200);
    assert.equal(result.data.organization.organization_id, 42);
    assert.equal(result.data.organization.state, 'Karnataka');
    assert.deepEqual(transaction, ['begin', 'commit', 'release']);
    assert.ok(queries[0].sql.includes('FOR UPDATE'));
    assert.deepEqual(queries[0].values, [identity.id]);
    assert.ok(queries.every(row => !row.sql.includes('blood_requests')));
  });
}
test('donor and anonymous callers cannot edit organization location', async () => {
  const result = await request('PUT', '/api/organizations/me/location',
    { state: 'Maharashtra', city: 'Pune' }, { type: 'donor', id: 3 });
  assert.equal(result.status, 403);
  assert.equal((await request('PUT', '/api/organizations/me/location',
    { state: 'Maharashtra', city: 'Pune' })).status, 401);
  assert.equal(queries.length, 0);
});

test('companion provider insertion failure rolls back the organization creation', async () => {
  failInsert = 'BANK_FAILURE';
  const result = await request('POST', '/api/organizations', registration('Hospital'));
  assert.equal(result.status, 500);
  assert.deepEqual(transaction, ['begin', 'rollback', 'release']);
  assert.equal(queries.filter(row => row.sql.startsWith('INSERT')).length, 2);
});
