const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomBytes, scrypt } = require('node:crypto');
const { promisify } = require('node:util');
const pool = require('../db');

const deriveKey = promisify(scrypt);
const originalExecute = pool.execute;
const originalListen = express.application.listen;
const originalPort = process.env.PORT;
const jwtNames = ['JWT_SECRET', 'JWT_EXPIRES_IN'];
const originalJwtEnvironment = Object.fromEntries(jwtNames.map(name => [name, process.env[name]]));
const testSecret = randomBytes(32).toString('hex');
const password = randomBytes(16).toString('hex');
let donorFixture;
let recipientFixture;
let donors;
let recipients;
let queries;
let databaseError;
let server;
let baseUrl;

async function makeHash(value) {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(value, salt, 64);
  return 'scrypt:' + salt + ':' + key.toString('hex');
}

function assertSafe(body) {
  // Nested response mein bhi password ya hash nahi aana chahiye.
  for (const [key, value] of Object.entries(body)) {
    assert.ok(!['password', 'password_hash', 'stack', 'sql'].includes(key), 'Response contains a sensitive field');
    if (value && typeof value === 'object') assertSafe(value);
  }
  assert.ok(!JSON.stringify(body).includes(password), 'Response contains password');
}

async function post(path, body, expectedStatus, raw = false) {
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
  assert.equal(response.status, expectedStatus);
  const result = await response.json();
  assert.equal(typeof result.message, 'string');
  assertSafe(result);
  if (expectedStatus === 200 && path.startsWith('/api/auth/')) {
    const role = path.split('/')[3];
    assert.equal(typeof result.token, 'string');
    const payload = jwt.verify(result.token, testSecret, { algorithms: ['HS256'] });
    assert.deepEqual(Object.keys(payload).sort(), ['exp', 'iat', 'user_id', 'user_type']);
    assert.equal(payload.user_id, result[role][role + '_id']);
    assert.equal(payload.user_type, role);
    assert.ok(Number.isInteger(payload.iat));
    assert.equal(payload.exp - payload.iat, 3600);
    assert.ok(payload.exp > Math.floor(Date.now() / 1000));
    assertSafe(payload);
  }
  return result;
}

before(async () => {
  // Test secret random hoga; real config use nahi karenge.
  process.env.JWT_SECRET = testSecret;
  process.env.JWT_EXPIRES_IN = '1h';
  donorFixture = { donor_id: 1, name: 'Test donor', blood_group: 'O+', phone: '9876543210',
    email: null, location: 'Test city', is_available: 1, password_hash: await makeHash(password) };
  recipientFixture = { recipient_id: 1, name: 'Test recipient', gender: 'Other', blood_group: 'A+',
    age: 25, phone: '9876543211', email: null, monitored_by: null, password_hash: await makeHash(password) };

  // SQL sirf memory mein simulate hoga; test suite real database mein kuch save nahi karegi.
  pool.execute = async (sql, values) => {
    queries.push({ sql, values });
    if (databaseError) {
      const error = new Error('Internal details must stay private');
      error.code = databaseError;
      throw error;
    }
    if (sql.startsWith('SELECT donor_id')) {
      assert.equal(sql, 'SELECT donor_id, name, blood_group, phone, email, location, is_available, password_hash FROM donors WHERE phone = ? LIMIT 2');
      assert.equal(values.length, 1);
      return [donors.filter(row => row.phone === values[0]).slice(0, 2)];
    }
    if (sql.startsWith('SELECT recipient_id')) {
      assert.equal(sql, 'SELECT recipient_id, name, gender, blood_group, age, phone, email, monitored_by, password_hash FROM recipients WHERE phone = ? LIMIT 2');
      assert.equal(values.length, 1);
      return [recipients.filter(row => row.phone === values[0]).slice(0, 2)];
    }
    if (sql.startsWith('INSERT INTO donors')) {
      assert.equal((sql.match(/\?/g) || []).length, 14);
      assert.equal(values.length, 14);
      const [name, gender, blood_group, date_of_birth, phone, email, address, location, last_donation, is_available, password_hash, bank_id, state, city] = values;
      const row = { donor_id: 10, name, gender, blood_group, date_of_birth, phone, email, address, location, last_donation, is_available, password_hash, bank_id, state, city };
      donors.push(row);
      return [{ insertId: row.donor_id }];
    }
    if (sql.startsWith('INSERT INTO recipients')) {
      assert.equal((sql.match(/\?/g) || []).length, 10);
      assert.equal(values.length, 10);
      const [name, gender, blood_group, age, phone, email, address, location, password_hash, monitored_by] = values;
      const row = { recipient_id: 10, name, gender, blood_group, age, phone, email, address, location, password_hash, monitored_by };
      recipients.push(row);
      return [{ insertId: row.recipient_id }];
    }
    throw new Error('Unexpected SQL statement');
  };

  // Actual index.js ko temporary port par start karenge, taaki route mounting bhi test ho.
  express.application.listen = function (...args) {
    server = originalListen.apply(this, args);
    return server;
  };
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
  donors = [structuredClone(donorFixture)];
  recipients = [structuredClone(recipientFixture)];
  queries = [];
  databaseError = null;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  pool.execute = originalExecute;
  express.application.listen = originalListen;
  if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  for (const name of jwtNames) {
    if (originalJwtEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = originalJwtEnvironment[name];
  }
  await pool.end();
});

for (const role of ['donor', 'recipient']) {
  const path = '/api/auth/' + role + '/login';
  const phone = role === 'donor' ? '9876543210' : '9876543211';
  const rows = () => role === 'donor' ? donors : recipients;

  test(role + ': valid login returns only safe fields', async () => {
    const result = await post(path, { phone, password }, 200);
    const keys = role === 'donor'
      ? ['donor_id', 'name', 'blood_group', 'phone', 'email', 'location', 'is_available']
      : ['recipient_id', 'name', 'gender', 'blood_group', 'age', 'phone', 'email', 'monitored_by'];
    assert.deepEqual(Object.keys(result[role]).sort(), keys.sort());
    assert.equal(result[role].phone, phone);
    assert.equal(result[role][role + '_id'], 1);
    assert.deepEqual(queries[0].values, [phone]);
  });

  test(role + ': wrong password returns 401', async () => {
    const result = await post(path, { phone, password: password + 'wrong' }, 401);
    assert.deepEqual(result, { message: 'Invalid phone or password.' });
  });

  test(role + ': nonexistent account uses the same 401 message', async () => {
    const result = await post(path, { phone: '9876543299', password }, 401);
    assert.deepEqual(result, { message: 'Invalid phone or password.' });
  });

  test(role + ': missing phone returns 400 before SQL', async () => {
    await post(path, { password }, 400);
    assert.equal(queries.length, 0);
  });

  test(role + ': missing password returns 400 before SQL', async () => {
    await post(path, { phone }, 400);
    assert.equal(queries.length, 0);
  });

  const badPhones = ['', '   ', null, 123, true, [], {}, '123456789', '1234567890123456',
    '+123456789012345', 'not-a-phone', '98765 43210', '98765-43210', '++919876543210', '??????????'];
  badPhones.forEach((value, index) => test(role + ': invalid phone case ' + (index + 1), async () => {
    await post(path, { phone: value, password }, 400);
    assert.equal(queries.length, 0);
  }));

  const badPasswords = ['', '   ', null, 123, true, [], {}];
  badPasswords.forEach((value, index) => test(role + ': invalid password case ' + (index + 1), async () => {
    await post(path, { phone, password: value }, 400);
    assert.equal(queries.length, 0);
  }));

  [undefined, null, [], 'text', 123].forEach((value, index) => test(role + ': invalid body case ' + (index + 1), async () => {
    await post(path, value, 400);
    assert.equal(queries.length, 0);
  }));

  test(role + ': trimmed phone is parameterized', async () => {
    await post(path, { phone: '  ' + phone + '  ', password }, 200);
    assert.deepEqual(queries[0].values, [phone]);
  });

  test(role + ': valid international phone boundary', async () => {
    rows()[0].phone = '+12345678901234';
    await post(path, { phone: '+12345678901234', password }, 200);
  });

  test(role + ': valid 15-digit phone boundary', async () => {
    rows()[0].phone = '123456789012345';
    await post(path, { phone: '123456789012345', password }, 200);
  });

  test(role + ': password whitespace is preserved', async () => {
    const spacedPassword = '  ' + password + '  ';
    rows()[0].password_hash = await makeHash(spacedPassword);
    await post(path, { phone, password: spacedPassword }, 200);
    await post(path, { phone, password }, 401);
  });

  test(role + ': existing short passwords remain verifiable', async () => {
    const legacyPassword = randomBytes(3).toString('hex');
    rows()[0].password_hash = await makeHash(legacyPassword);
    await post(path, { phone, password: legacyPassword }, 200);
  });

  const malformedHashes = [null, '', 'plaintext', 'bcrypt:invalid', 'scrypt:bad:bad',
    'scrypt:' + '0'.repeat(32) + ':' + 'z'.repeat(128),
    'scrypt:' + '0'.repeat(32) + ':' + '0'.repeat(127),
    'scrypt:' + '0'.repeat(31) + ':' + '0'.repeat(128),
    'scrypt:' + '0'.repeat(32) + ':' + '0'.repeat(128) + ':extra'];
  malformedHashes.forEach((value, index) => test(role + ': malformed stored hash case ' + (index + 1), async () => {
    rows()[0].password_hash = value;
    await post(path, { phone, password }, 401);
  }));

  test(role + ': uppercase key hex remains compatible', async () => {
    const parts = rows()[0].password_hash.split(':');
    parts[2] = parts[2].toUpperCase();
    rows()[0].password_hash = parts.join(':');
    await post(path, { phone, password }, 200);
  });

  test(role + ': database failure returns safe 500', async () => {
    databaseError = 'ER_ACCESS_DENIED_ERROR';
    const result = await post(path, { phone, password }, 500);
    assert.deepEqual(result, { message: 'Unable to log in.' });
  });

  test(role + ': malformed JSON returns 400', async () => {
    const result = await post(path, '{', 400, true);
    assert.equal(result.message, 'Invalid JSON request body.');
    assert.equal(queries.length, 0);
  });

  test(role + ': oversized request returns 413', async () => {
    await post(path, { phone, password: 'x'.repeat(110000) }, 413);
    assert.equal(queries.length, 0);
  });

  test(role + ': SQL-looking phone is rejected without a query', async () => {
    await post(path, { phone: "' OR 1=1 --", password }, 400);
    assert.equal(queries.length, 0);
  });
}

test('recipient: duplicate phone is rejected even when one password matches', async () => {
  recipients.push({ ...recipientFixture, recipient_id: 2, password_hash: await makeHash(password + 'other') });
  await post('/api/auth/recipient/login', { phone: recipientFixture.phone, password }, 401);
});

test('recipient: identical credentials cannot select an ambiguous account', async () => {
  recipients.push({ ...recipientFixture, recipient_id: 2 });
  await post('/api/auth/recipient/login', { phone: recipientFixture.phone, password }, 401);
});

test('donor registration still produces a login-compatible hash', async () => {
  const input = { name: 'Registration regression', gender: 'Other', blood_group: 'AB+',
    date_of_birth: '2000-01-01', phone: '9876543220', password };
  const created = await post('/api/donors', input, 201);
  assert.equal(created.donor_id, 10);
  assert.ok(donors[1].password_hash.startsWith('scrypt:'));
  const result = await post('/api/auth/donor/login', { phone: input.phone, password }, 200);
  assert.equal(result.donor.donor_id, created.donor_id);
});

test('recipient registration still produces a login-compatible hash', async () => {
  const input = { name: 'Registration regression', gender: 'Other', blood_group: 'AB+',
    age: 25, phone: '9876543221', password };
  const created = await post('/api/recipients', input, 201);
  assert.equal(created.recipient_id, 10);
  assert.ok(recipients[1].password_hash.startsWith('scrypt:'));
  const result = await post('/api/auth/recipient/login', { phone: input.phone, password }, 200);
  assert.equal(result.recipient.recipient_id, created.recipient_id);
});

test('donor registration validation remains active', async () => {
  await post('/api/donors', {}, 400);
  assert.equal(queries.length, 0);
});

test('recipient registration validation remains active', async () => {
  await post('/api/recipients', {}, 400);
  assert.equal(queries.length, 0);
});

test('root endpoint and CORS remain active', async () => {
  const response = await fetch(baseUrl + '/', { headers: { Origin: 'http://localhost:3000' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal((await response.json()).message, 'LifeSaver backend is running');
});

