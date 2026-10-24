const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomBytes, scrypt } = require('node:crypto');
const { promisify } = require('node:util');
const pool = require('../db');
const { createToken, verifyToken } = require('../services/jwtService');

const deriveKey = promisify(scrypt);
const secret = randomBytes(32).toString('hex');
const otherSecret = randomBytes(32).toString('hex');
const password = randomBytes(16).toString('hex');
const original = {
  execute: pool.execute, query: pool.query, getConnection: pool.getConnection,
  listen: express.application.listen,
  port: process.env.PORT, secret: process.env.JWT_SECRET, expiry: process.env.JWT_EXPIRES_IN,
};
let server;
let baseUrl;
let queries;
let donor;
let recipient;
let profileRows;
let profileError;

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
function assertSafe(body) {
  for (const [key, value] of Object.entries(body)) {
    assert.ok(!['password', 'password_hash', 'stack', 'sql', 'JWT_SECRET'].includes(key), 'Sensitive response field');
    if (value && typeof value === 'object') assertSafe(value);
  }
  const text = JSON.stringify(body);
  assert.ok(!text.includes(password), 'Password must remain private');
  assert.ok(!text.includes(secret), 'Secret must remain private');
}
function sign(payload = { user_id: 21, user_type: 'donor' }, options = {}, signingSecret = secret) {
  return jwt.sign(payload, signingSecret, { algorithm: 'HS256', expiresIn: '1h', ...options });
}
async function request(method, path, body, authorization) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authorization !== undefined) headers.Authorization = authorization;
  const response = await fetch(baseUrl + path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assertSafe(data);
  return { status: response.status, data };
}
function profile(role, id, name) { return { user_id: id, user_type: role, name, ...(role === 'donor' ? { blood_group: donor.blood_group, location: donor.location, state: donor.state || null, city: donor.city || null, is_available: donor.is_available } : {}) }; }
async function me(token, expectedStatus = 200, expectedIdentity, expectedQueries = expectedStatus === 200 ? 1 : 0) {
  const count = queries.length;
  const result = await request('GET', '/api/auth/me', undefined, token === undefined ? undefined : 'Bearer ' + token);
  assert.equal(result.status, expectedStatus);
  assert.equal(queries.length, count + expectedQueries, '/me must query only after valid authentication');
  if (expectedIdentity) assert.deepEqual(result.data, expectedIdentity);
  else assert.deepEqual(Object.keys(result.data), ['message']);
  return result;
}

before(async () => {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 64);
  const password_hash = 'scrypt:' + salt + ':' + key.toString('hex');
  donor = { donor_id: 21, name: 'JWT donor fixture', blood_group: 'O+', phone: '9876543210',
    email: null, location: 'Fixture city', is_available: 1, password_hash };
  recipient = { recipient_id: 42, name: 'JWT recipient fixture', gender: 'Other',
    blood_group: 'A+', age: 25, phone: '9876543211', email: null, monitored_by: null, password_hash };
  process.env.JWT_SECRET = secret;
  process.env.JWT_EXPIRES_IN = '1h';

  // Real MySQL call nahi hoga; fixture rows sirf memory mein hain.
  pool.execute = async (sql, values) => {
    queries.push({ sql, values });
    if (sql.startsWith('SELECT name')) {
      const role = sql === 'SELECT name FROM recipients WHERE recipient_id = ? LIMIT 1' ? 'recipient'
        : sql === 'SELECT name, blood_group, location, state, city, is_available FROM donors WHERE donor_id = ? LIMIT 1' ? 'donor' : null;
      assert.ok(role, 'Profile query must select only name from a fixed role table');
      assert.equal(values.length, 1);
      if (profileError) throw new Error('Private database details');
      const rows = profileRows[role];
      return [rows.has(values[0]) ? [{ name: rows.get(values[0]), ...(role === 'donor' ? { blood_group: donor.blood_group, location: donor.location, state: donor.state || null, city: donor.city || null, is_available: donor.is_available } : {}) }] : []];
    }
    assert.ok(sql.includes('WHERE phone = ? LIMIT'), 'Login must use parameterized SQL');
    assert.equal(values.length, 1);
    const row = sql.startsWith('SELECT donor_id') ? donor
      : sql.startsWith('SELECT recipient_id') ? recipient : null;
    assert.ok(row, 'Unexpected SQL');
    return [values[0] === row.phone ? [row] : []];
  };
  pool.query = pool.getConnection = async () => { throw new Error('Real database access is disabled in JWT tests.'); };
  express.application.listen = function (...args) {
    server = original.listen.apply(this, args);
    return server;
  };
  process.env.PORT = '0';
  try { require('../index'); } finally {
    express.application.listen = original.listen;
    restoreEnv('PORT', original.port);
  }
  if (!server.listening) await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(() => {
  queries = [];
  profileError = false;
  donor.blood_group = 'O+'; donor.location = 'Fixture city'; donor.is_available = 1;
  profileRows = {
    donor: new Map([[21, donor.name]]),
    recipient: new Map([[42, recipient.name], [21, 'Same ID recipient fixture']]),
  };
  process.env.JWT_SECRET = secret;
  process.env.JWT_EXPIRES_IN = '1h';
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  pool.execute = original.execute;
  pool.query = original.query;
  pool.getConnection = original.getConnection;
  express.application.listen = original.listen;
  restoreEnv('PORT', original.port);
  restoreEnv('JWT_SECRET', original.secret);
  restoreEnv('JWT_EXPIRES_IN', original.expiry);
  await pool.end();
});

for (const role of ['donor', 'recipient']) {
  test(role + ' login returns a signed minimal JWT and its unchanged safe account', async () => {
    const row = role === 'donor' ? donor : recipient;
    const result = await request('POST', '/api/auth/' + role + '/login', { phone: row.phone, password });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.data).sort(), ['message', role, 'token'].sort());
    const payload = jwt.verify(result.data.token, secret, { algorithms: ['HS256'] });
    assert.deepEqual(Object.keys(payload).sort(), ['exp', 'iat', 'user_id', 'user_type']);
    assert.equal(payload.user_id, row[role + '_id']);
    assert.equal(payload.user_type, role);
    assert.equal(payload.exp - payload.iat, 3600);
    assert.equal(result.data[role][role + '_id'], row[role + '_id']);
    assert.equal(result.data[role].name, row.name);
    assertSafe(payload);
    const identity = profile(role, row[role + '_id'], row.name);
    await me(result.data.token, 200, identity);
    assert.equal(queries.length, 2);
  });
  test(role + ' wrong password still returns 401 without a token', async () => {
    const row = role === 'donor' ? donor : recipient;
    const result = await request('POST', '/api/auth/' + role + '/login', { phone: row.phone, password: password + 'wrong' });
    assert.equal(result.status, 401);
    assert.deepEqual(Object.keys(result.data), ['message']);
  });
  test(role + ' missing password still returns 400 without SQL', async () => {
    const row = role === 'donor' ? donor : recipient;
    const result = await request('POST', '/api/auth/' + role + '/login', { phone: row.phone });
    assert.equal(result.status, 400);
    assert.equal(queries.length, 0);
  });
}
test('same numeric ID preserves separate donor and recipient identity', async () => {
  for (const user_type of ['donor', 'recipient']) {
    await me(createToken(21, user_type), 200, profile(user_type, 21, profileRows[user_type].get(21)));
  }
});
test('missing Authorization is rejected', async () => { await me(undefined, 401); });
for (const header of ['', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer a b', 'Bearer a,b', 'Bearer a.b.c extra', 'Bearer  a.b.c']) {
  test('malformed Authorization header: ' + JSON.stringify(header), async () => {
    const result = await request('GET', '/api/auth/me', undefined, header);
    assert.equal(result.status, 401);
    assert.deepEqual(Object.keys(result.data), ['message']);
    assert.equal(queries.length, 0);
  });
}
test('Bearer scheme is case insensitive', async () => {
  const result = await request('GET', '/api/auth/me', undefined, 'bEaReR ' + sign());
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, profile('donor', 21, donor.name));
  assert.equal(queries.length, 1);
});
for (const token of ['not-a-jwt', 'a.b.c', '.payload.signature', 'header..signature']) {
  test('invalid JWT format: ' + token, async () => { await me(token, 401); });
}
test('expired signed token is rejected', async () => { await me(sign(undefined, { expiresIn: '-1s' }), 401); });
test('token expires at the current second', async () => { await me(sign(undefined, { expiresIn: '0s' }), 401); });
test('token signed with a different secret is rejected', async () => { await me(sign(undefined, {}, otherSecret), 401); });
test('tampered payload is rejected', async () => {
  const [header, payload, signature] = sign().split('.');
  const modified = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  modified.user_id = 42;
  await me(header + '.' + Buffer.from(JSON.stringify(modified)).toString('base64url') + '.' + signature, 401);
});
test('tampered signature is rejected', async () => {
  const [header, payload, signature] = sign().split('.');
  const changed = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
  await me(header + '.' + payload + '.' + changed, 401);
});
test('unsigned algorithm none is rejected', async () => {
  const payload = { user_id: 21, user_type: 'donor', exp: Math.floor(Date.now() / 1000) + 3600 };
  const token = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') + '.'
    + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.';
  await me(token, 401);
});
test('signed HS512 token is rejected by the HS256 allowlist', async () => {
  await me(sign(undefined, { algorithm: 'HS512' }), 401);
});
test('signed JWT without expiry is rejected', async () => {
  await me(jwt.sign({ user_id: 21, user_type: 'donor' }, secret, { algorithm: 'HS256' }), 401);
});
test('future not-before token is rejected', async () => {
  await me(sign(undefined, { notBefore: '1h' }), 401);
});
test('fractional expiry claim is rejected', async () => {
  await me(jwt.sign({ user_id: 21, user_type: 'donor', exp: Math.floor(Date.now() / 1000) + 3600.5 }, secret, { algorithm: 'HS256' }), 401);
});
for (const user_id of [0, -1, '21', 1.5, null, Number.MAX_SAFE_INTEGER + 1]) {
  test('invalid identity ID: ' + JSON.stringify(user_id), async () => {
    await me(sign({ user_id, user_type: 'donor' }), 401);
    assert.throws(() => createToken(user_id, 'donor'));
  });
}
for (const user_type of ['admin', 'Donor', '', null]) {
  test('unsupported user type: ' + JSON.stringify(user_type), async () => {
    await me(sign({ user_id: 21, user_type }), 401);
    assert.throws(() => createToken(21, user_type));
  });
}
test('missing identity claims are rejected', async () => { await me(sign({}), 401); });
for (const setting of [
  ['JWT_SECRET', undefined], ['JWT_SECRET', ''], ['JWT_SECRET', 'short'],
  ['JWT_SECRET', ' '.repeat(32)], ['JWT_EXPIRES_IN', undefined],
  ['JWT_EXPIRES_IN', ''], ['JWT_EXPIRES_IN', '3600'],
  ['JWT_EXPIRES_IN', '0h'], ['JWT_EXPIRES_IN', '-1h'], ['JWT_EXPIRES_IN', 'invalid'],
]) {
  test('invalid ' + setting[0] + ' configuration safely returns 500: case ' + JSON.stringify(setting[1]), async () => {
    const token = sign();
    restoreEnv(setting[0], setting[1]);
    const response = await me(token, 500);
    assert.deepEqual(response.data, { message: 'Authentication is temporarily unavailable.' });
    const result = await request('POST', '/api/auth/donor/login', { phone: donor.phone, password });
    assert.equal(result.status, 500);
    assert.deepEqual(result.data, { message: 'Unable to log in.' });
    assert.throws(() => createToken(21, 'donor'), { code: 'JWT_CONFIG_ERROR' });
  });
}
test('configured expiry controls issued JWT lifetime', async () => {
  process.env.JWT_EXPIRES_IN = '15m';
  const payload = jwt.verify(createToken(42, 'recipient'), secret, { algorithms: ['HS256'] });
  assert.equal(payload.exp - payload.iat, 900);
  assert.deepEqual(verifyToken(createToken(42, 'recipient')), { user_id: 42, user_type: 'recipient' });
});
test('root endpoint remains public', async () => {
  const result = await request('GET', '/');
  assert.equal(result.status, 200);
  assert.equal(result.data.message, 'LifeSaver backend is running');
  assert.equal(queries.length, 0);
});

for (const role of ['donor', 'recipient']) {
  test(role + ' profile reads the current database name on each request', async () => {
    const row = role === 'donor' ? donor : recipient;
    const id = row[role + '_id'];
    const token = createToken(id, role);
    await me(token, 200, profile(role, id, row.name));
    profileRows[role].set(id, 'Updated ' + role + ' name');
    await me(token, 200, profile(role, id, 'Updated ' + role + ' name'));
    assert.equal(queries.length, 2);
    assert.deepEqual(queries[0].values, [id]);
    assert.deepEqual(queries[1].values, [id]);
    assert.deepEqual(Object.keys(jwt.verify(token, secret, { algorithms: ['HS256'] })).sort(), ['exp', 'iat', 'user_id', 'user_type']);
  });
  test(role + ' profile query cannot replace authenticated identity', async () => {
    const row = role === 'donor' ? donor : recipient;
    const id = row[role + '_id'];
    const result = await request('GET', '/api/auth/me?user_id=999&user_type=admin', undefined,
      'Bearer ' + createToken(id, role));
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, profile(role, id, row.name));
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].values, [id]);
  });
  test(role + ' missing profile safely returns 404', async () => {
    const row = role === 'donor' ? donor : recipient;
    const id = row[role + '_id'];
    profileRows[role].delete(id);
    const result = await me(createToken(id, role), 404, undefined, 1);
    assert.deepEqual(result.data, { message: 'Account not found.' });
  });
  test(role + ' profile database failure safely returns 500', async () => {
    const row = role === 'donor' ? donor : recipient;
    profileError = true;
    const result = await me(createToken(row[role + '_id'], role), 500, undefined, 1);
    assert.deepEqual(result.data, { message: 'Unable to retrieve your profile.' });
  });
}

test('donor dashboard profile contains exactly eight safe fields', async () => {
  const result = await me(createToken(21, 'donor'), 200, profile('donor', 21, donor.name));
  assert.deepEqual(Object.keys(result.data).sort(), ['blood_group', 'city', 'is_available', 'location', 'name', 'state', 'user_id', 'user_type']);
  assert.deepEqual(queries[0].values, [21]);
});
for (const value of [0, 1]) {
  test('donor profile returns current availability ' + value + ' outside JWT', async () => {
    donor.is_available = value;
    const token = createToken(21, 'donor');
    await me(token, 200, profile('donor', 21, donor.name));
    assert.deepEqual(Object.keys(jwt.verify(token, secret)).sort(), ['exp', 'iat', 'user_id', 'user_type']);
  });
}
test('donor profile preserves nullable and subsequently updated location', async () => {
  donor.location = null;
  await me(createToken(21, 'donor'), 200, profile('donor', 21, donor.name));
  donor.location = 'Updated city';
  await me(createToken(21, 'donor'), 200, profile('donor', 21, donor.name));
  assert.equal(queries.length, 2);
});
test('recipient profile shape remains unchanged', async () => {
  const result = await me(createToken(42, 'recipient'), 200, profile('recipient', 42, recipient.name));
  assert.deepEqual(Object.keys(result.data).sort(), ['name', 'user_id', 'user_type']);
});

