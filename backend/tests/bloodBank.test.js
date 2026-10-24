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
const password = randomBytes(16).toString('hex');
const original = { execute: pool.execute, query: pool.query, getConnection: pool.getConnection,
  listen: express.application.listen, port: process.env.PORT,
  secret: process.env.JWT_SECRET, expiry: process.env.JWT_EXPIRES_IN };
let server, baseUrl, banks, fixture, queries, databaseError;

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
function safeProfile(bank, identity = false) {
  return { ...(identity ? { user_id: bank.bank_id, user_type: 'blood_bank' } : { bank_id: bank.bank_id }),
    bank_name: bank.bank_name, email: bank.email, phone: bank.phone, address: bank.address };
}
function safeCurrentProfile(bank) {
  return { ...safeProfile(bank, true), bank_id: bank.bank_id,
    organization_id: bank.organization_id || null, organization_type: bank.organization_type,
    state: bank.state || null, city: bank.city || null };
}
function assertSafe(body) {
  for (const [key, value] of Object.entries(body)) {
    assert.ok(!['password', 'password_hash', 'stack', 'sql', 'JWT_SECRET'].includes(key));
    if (value && typeof value === 'object') assertSafe(value);
  }
  assert.ok(!JSON.stringify(body).includes(password));
  assert.ok(!JSON.stringify(body).includes(secret));
}
async function request(method, path, body, status, token) {
  const response = await fetch(baseUrl + path, {
    method, headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  assertSafe(data);
  return data;
}
function login(body = { email: fixture.email, password }, status = 200) {
  return request('POST', '/api/auth/blood-bank/login', body, status);
}

before(async () => {
  process.env.JWT_SECRET = secret;
  process.env.JWT_EXPIRES_IN = '1h';
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 64);
  fixture = { bank_id: 7, bank_name: 'Memory Bank', email: 'bank@example.test',
    phone: '9876543210', address: 'Memory City', organization_id: 17, organization_type: 'Blood Bank', state: 'Maharashtra', city: 'Pune', password_hash: 'scrypt:' + salt + ':' + key.toString('hex') };
  // Real MySQL access band hai; saare rows sirf memory fixtures hain.
  pool.execute = async (sql, values = []) => {
    queries.push({ sql, values });
    if (databaseError) throw new Error('Private database details');
    if (sql.includes('WHERE b.email = ?')) {
      assert.equal(sql, "SELECT b.bank_id, b.bank_name, b.email, b.phone, b.address, b.password_hash FROM blood_banks b LEFT JOIN organizations o ON o.organization_id = b.organization_id WHERE b.email = ? AND (b.organization_id IS NULL OR o.organization_type = 'Blood Bank') LIMIT 2");
      assert.equal(values.length, 1);
      return [banks.filter(bank => bank.email === values[0] && (!bank.organization_id || bank.organization_type === 'Blood Bank')).slice(0, 2)];
    }
    if (sql.includes('FROM blood_banks b LEFT JOIN organizations')) {
      assert.ok(sql.includes('WHERE b.bank_id = ? LIMIT 1'));
      assert.ok(!sql.includes('password_hash'));
      return [banks.filter(bank => bank.bank_id === values[0]).slice(0, 1)];
    }
    assert.ok(!sql.includes('password_hash'));
    if (sql.includes('ORDER BY')) {
      assert.equal(sql, 'SELECT bank_id, bank_name, email, phone, address FROM blood_banks ORDER BY bank_name, bank_id');
      assert.deepEqual(values, []);
      return [banks];
    }
    assert.equal(sql, 'SELECT bank_id, bank_name, email, phone, address FROM blood_banks WHERE bank_id = ? LIMIT 1');
    assert.equal(values.length, 1);
    return [banks.filter(bank => bank.bank_id === values[0]).slice(0, 1)];
  };
  pool.query = pool.getConnection = async () => { throw new Error('Real database access is disabled.'); };
  express.application.listen = function (...args) {
    server = original.listen.apply(this, args); return server;
  };
  process.env.PORT = '0';
  try { require('../index'); } finally {
    express.application.listen = original.listen; restoreEnv('PORT', original.port);
  }
  if (!server.listening) await new Promise((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

beforeEach(() => {
  banks = [structuredClone(fixture)]; queries = []; databaseError = false;
  process.env.JWT_SECRET = secret; process.env.JWT_EXPIRES_IN = '1h';
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  pool.execute = original.execute; pool.query = original.query; pool.getConnection = original.getConnection;
  express.application.listen = original.listen;
  restoreEnv('PORT', original.port); restoreEnv('JWT_SECRET', original.secret); restoreEnv('JWT_EXPIRES_IN', original.expiry);
  await pool.end();
});

test('Blood Bank login returns the specified safe account and minimal JWT', async () => {
  const data = await login();
  assert.deepEqual(Object.keys(data).sort(), ['message', 'token', 'user']);
  assert.deepEqual(data.user, safeProfile(fixture, true));
  const payload = jwt.verify(data.token, secret, { algorithms: ['HS256'] });
  assert.deepEqual(Object.keys(payload).sort(), ['exp', 'iat', 'user_id', 'user_type']);
  assert.equal(payload.user_id, 7); assert.equal(payload.user_type, 'blood_bank');
  assert.equal(payload.exp - payload.iat, 3600);
  assert.deepEqual(verifyToken(data.token), { user_id: 7, user_type: 'blood_bank' });
});

test('Blood Bank wrong password and nonexistent email return the same safe 401', async () => {
  const wrong = await login({ email: fixture.email, password: password + 'wrong' }, 401);
  const missing = await login({ email: 'missing@example.test', password }, 401);
  assert.deepEqual(wrong, { message: 'Invalid email or password.' });
  assert.deepEqual(missing, wrong);
});

test('Hospital provider cannot use the legacy Blood Bank login', async () => {
  banks[0].organization_type = 'Hospital';
  assert.deepEqual(await login(undefined, 401), { message: 'Invalid email or password.' });
});

test('Original unlinked Blood Bank login remains compatible', async () => {
  banks[0].organization_id = null;
  delete banks[0].organization_type;
  await login();
});

for (const [field, values] of [
  ['email', [undefined, null, '', ' ', 'bad', 'a@b', 'a b@c.test', 123, true, [], {}, 'a'.repeat(101) + '@x.test']],
  ['password', [undefined, null, '', ' ', 123, true, [], {}]],
]) {
  values.forEach((value, index) => test('Blood Bank rejects invalid ' + field + ' case ' + index + ' before SQL', async () => {
    await login({ email: fixture.email, password, [field]: value }, 400);
    assert.equal(queries.length, 0);
  }));
}
for (const value of [undefined, null, [], 'text', 123]) {
  test('Blood Bank rejects invalid body ' + JSON.stringify(value), async () => {
    await request('POST', '/api/auth/blood-bank/login', value, 400);
    assert.equal(queries.length, 0);
  });
}

test('Blood Bank trimmed email is passed as an SQL parameter', async () => {
  await login({ email: '  ' + fixture.email + '  ', password });
  assert.deepEqual(queries[0].values, [fixture.email]);
});

test('Blood Bank duplicate email cannot select an ambiguous account', async () => {
  banks.push({ ...fixture, bank_id: 8 });
  await login(undefined, 401);
});

for (const hash of [null, '', 'plaintext', 'scrypt:bad:bad', 'scrypt:' + '0'.repeat(32) + ':' + 'z'.repeat(128)]) {
  test('Blood Bank invalid stored hash returns safe unauthorized: ' + (hash === null ? 'null' : hash.slice(0, 15)), async () => {
    banks[0].password_hash = hash;
    await login(undefined, 401);
  });
}

test('Blood Bank password whitespace stays part of the password', async () => {
  const spaced = '  ' + password + '  ';
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(spaced, salt, 64);
  banks[0].password_hash = 'scrypt:' + salt + ':' + key.toString('hex');
  await login({ email: fixture.email, password: spaced });
  await login(undefined, 401);
});

test('Blood Bank login database failure returns only a safe message', async () => {
  databaseError = true;
  assert.deepEqual(await login(undefined, 500), { message: 'Unable to log in.' });
});

test('Blood Bank current profile uses JWT identity and only safe current fields', async () => {
  banks[0].bank_name = 'Updated bank name';
  banks[0].address = null; banks[0].phone = null;
  const data = await request('GET', '/api/auth/me?user_id=999&user_type=donor', undefined, 200, createToken(7, 'blood_bank'));
  assert.deepEqual(data, safeCurrentProfile(banks[0]));
  assert.deepEqual(queries[0].values, [7]);
});

test('deleted Blood Bank current profile returns 404', async () => {
  banks = [];
  assert.deepEqual(await request('GET', '/api/auth/me', undefined, 404, createToken(7, 'blood_bank')), { message: 'Account not found.' });
});

test('Blood Bank current profile database failure is private', async () => {
  databaseError = true;
  assert.deepEqual(await request('GET', '/api/auth/me', undefined, 500, createToken(7, 'blood_bank')), { message: 'Unable to retrieve your profile.' });
});

for (const role of ['donor', 'recipient', 'blood_bank']) {
  test(role + ' can load the authenticated safe Blood Bank directory', async () => {
    const data = await request('GET', '/api/blood-banks', undefined, 200, createToken(7, role));
    assert.deepEqual(data, { blood_banks: [safeProfile(fixture)] });
    assert.ok(queries.every(query => !query.sql.includes('password_hash')));
  });
  test(role + ' can load safe Blood Bank details', async () => {
    const data = await request('GET', '/api/blood-banks/7', undefined, 200, createToken(7, role));
    assert.deepEqual(data, { blood_bank: safeProfile(fixture) });
    assert.deepEqual(queries[0].values, [7]);
  });
}

for (const path of ['/api/blood-banks', '/api/blood-banks/7']) {
  test(path + ' rejects missing JWT without SQL', async () => {
    await request('GET', path, undefined, 401);
    assert.equal(queries.length, 0);
  });
  test(path + ' rejects invalid JWT without SQL', async () => {
    await request('GET', path, undefined, 401, 'invalid');
    assert.equal(queries.length, 0);
  });
  test(path + ' database failure exposes only a safe message', async () => {
    databaseError = true;
    const data = await request('GET', path, undefined, 500, createToken(7, 'recipient'));
    assert.deepEqual(Object.keys(data), ['message']);
  });
}

test('empty Blood Bank directory returns no fabricated profiles', async () => {
  banks = [];
  assert.deepEqual(await request('GET', '/api/blood-banks', undefined, 200, createToken(7, 'recipient')), { blood_banks: [] });
  assert.equal(queries.length, 1);
});

test('nonexistent Blood Bank details return 404', async () => {
  assert.deepEqual(await request('GET', '/api/blood-banks/999', undefined, 404, createToken(7, 'recipient')), { message: 'Blood bank not found.' });
});

for (const id of ['0', '-1', '1.5', '2147483648', '1e3', 'abc', '7 OR 1=1']) {
  test('invalid Blood Bank ID rejected before SQL: ' + id, async () => {
    await request('GET', '/api/blood-banks/' + encodeURIComponent(id), undefined, 400, createToken(7, 'recipient'));
    assert.equal(queries.length, 0);
  });
}

