const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const { createToken } = require('../services/jwtService');
const pool = require('../db');
const smsService = require('../services/smsService');
const { createNotification, notifyDonor, NotificationError } = require('../services/notificationService');

const originalExecute = pool.execute;
const originalListen = express.application.listen;
const originalSendSMS = smsService.sendSMS;
const originalFetch = global.fetch;
const originalPort = process.env.PORT;
const originalJwtEnvironment = { JWT_SECRET: process.env.JWT_SECRET, JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN };
const jwtSecret = randomBytes(32).toString('hex');
const otherJwtSecret = randomBytes(32).toString('hex');
const smsNames = ['SMS_ENABLED', 'SMS_PROVIDER', 'SMS_API_KEY', 'SMS_SENDER_ID'];
const originalSmsEnvironment = Object.fromEntries(smsNames.map(name => [name, process.env[name]]));
const fakeKey = 'private-test-key-not-a-real-credential';
const validBody = { donor_id: 1, message: 'A blood request needs your help.' };
let server, baseUrl, queries, users, requests, notifications, nextId, failAt, errorCode, unchangedReadZero;

function safe(value) {
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!['password', 'password_hash', 'stack', 'sql', 'apiKey', 'SMS_API_KEY'].includes(key));
      safe(item);
    }
  }
  assert.ok(!JSON.stringify(value).includes(fakeKey));
  assert.ok(!JSON.stringify(value).includes('Private database details'));
}

function fail(stage) {
  if (failAt === stage) {
    const error = new Error('Private database details ' + fakeKey);
    error.code = errorCode;
    throw error;
  }
}

function seed(overrides = {}) {
  const row = { notification_id: nextId++, donor_id: 1, recipient_id: null, request_id: null,
    channel: 'InApp', message: 'Saved message', is_read: 0, sent_at: '2026-01-01T00:00:00.000Z', ...overrides };
  notifications.push(row);
  return row;
}

async function api(method, path, body, status, raw = false, authorization) {
  const headers = { 'Content-Type': 'application/json' };
  const auth = authorization === undefined && method !== 'POST' ? 'Bearer ' + createToken(1, 'donor') : authorization;
  if (auth !== undefined && auth !== null) headers.Authorization = auth;
  const response = await fetch(baseUrl + path, {
    method, headers,
    body: raw ? body : JSON.stringify(body),
  });
  assert.equal(response.status, status);
  const result = await response.json();
  safe(result);
  return result;
}

async function trustedCreate(body, status = 201, raw = false) {
  // Existing validation/SMS tests trusted service par hain; public creation ab forbidden hai.
  if (raw || JSON.stringify(body)?.length > 100000) {
    return api('POST', '/api/notifications', body, status, raw);
  }
  try {
    const result = await createNotification(body);
    assert.equal(status, 201);
    safe(result);
    return { message: 'Notification created successfully.', ...result };
  } catch (error) {
    const actual = error instanceof NotificationError ? error.status
      : error.code === 'ER_NO_REFERENCED_ROW_2' ? 404 : error.code === 'ER_DUP_ENTRY' ? 409 : 500;
    assert.equal(actual, status);
    return { message: 'Trusted notification validation rejected this input.' };
  }
}

function get(userType = 'donor', userId = '1', status = 200, authorization) {
  const auth = authorization === undefined ? 'Bearer ' + createToken(1, userType === 'recipient' ? 'recipient' : 'donor') : authorization;
  return api('GET', '/api/notifications/' + encodeURIComponent(userType) + '/' + encodeURIComponent(userId), undefined, status, false, auth);
}

function read(id = '1', status = 200, body = undefined, authorization) {
  return api('PATCH', '/api/notifications/' + encodeURIComponent(id) + '/read', body, status, false, authorization);
}

function mockProvider(adapter) {
  process.env.SMS_ENABLED = 'true';
  process.env.SMS_PROVIDER = 'mock';
  process.env.SMS_API_KEY = fakeKey;
  process.env.SMS_SENDER_ID = 'LifeSaver';
  smsService.sendSMS = (phone, message) => originalSendSMS(phone, message, adapter);
}

before(async () => {
  process.env.JWT_SECRET = jwtSecret;
  process.env.JWT_EXPIRES_IN = '1h';
  // SQL memory mein simulate hogi; test users ya notifications real database mein nahi jayenge.
  pool.execute = async (sql, values) => {
    queries.push({ sql, values });
    if (sql.startsWith('SELECT donor_id, phone FROM donors') ||
        sql.startsWith('SELECT recipient_id, phone FROM recipients')) {
      fail('user');
      const type = sql.includes('FROM donors') ? 'donor' : 'recipient';
      const column = type + '_id';
      assert.equal(sql, 'SELECT ' + column + ', phone FROM ' + (type === 'donor' ? 'donors' : 'recipients') +
        ' WHERE ' + column + ' = ? LIMIT 1');
      const phone = users[type].get(values[0]);
      return [phone === undefined ? [] : [{ [column]: values[0], phone }]];
    }
    if (sql.startsWith('SELECT request_id FROM blood_requests')) {
      fail('request');
      assert.equal(sql, 'SELECT request_id FROM blood_requests WHERE request_id = ? LIMIT 1');
      return [requests.has(values[0]) ? [{ request_id: values[0] }] : []];
    }
    if (sql.startsWith('INSERT INTO notifications')) {
      fail('insert');
      assert.equal(sql, 'INSERT INTO notifications (donor_id, recipient_id, request_id, channel, message) VALUES (?, ?, ?, ?, ?)');
      assert.equal(values.length, 5);
      const row = seed({ donor_id: values[0], recipient_id: values[1], request_id: values[2],
        channel: values[3], message: values[4] });
      return [{ insertId: row.notification_id }];
    }
    if (sql.startsWith('SELECT notification_id, donor_id')) {
      fail('list');
      const column = sql.includes('WHERE donor_id') ? 'donor_id' : 'recipient_id';
      assert.equal(sql, 'SELECT notification_id, donor_id, recipient_id, request_id, channel, message, is_read, sent_at FROM notifications WHERE ' +
        column + ' = ? ORDER BY sent_at IS NULL ASC, sent_at DESC, notification_id DESC');
      const rows = notifications.filter(row => row[column] === values[0]).sort((a, b) =>
        Number(a.sent_at === null) - Number(b.sent_at === null) ||
        String(b.sent_at).localeCompare(String(a.sent_at)) || b.notification_id - a.notification_id);
      return [structuredClone(rows)];
    }
    if (sql.startsWith('UPDATE notifications')) {
      fail('update');
      const column = sql.includes('AND donor_id = ?') ? 'donor_id' : 'recipient_id';
      assert.equal(sql, 'UPDATE notifications SET is_read = ? WHERE notification_id = ? AND ' + column + ' = ?');
      assert.equal(values.length, 3);
      assert.equal(values[0], 1);
      const row = notifications.find(item => item.notification_id === values[1] && item[column] === values[2]);
      if (!row) return [{ affectedRows: 0 }];
      const affectedRows = unchangedReadZero && row.is_read === 1 ? 0 : 1;
      row.is_read = 1;
      return [{ affectedRows }];
    }
    if (sql.startsWith('SELECT notification_id FROM notifications')) {
      fail('read_lookup');
      const column = sql.includes('AND donor_id = ?') ? 'donor_id' : 'recipient_id';
      assert.equal(sql, 'SELECT notification_id FROM notifications WHERE notification_id = ? AND ' + column + ' = ? LIMIT 1');
      assert.equal(values.length, 2);
      const row = notifications.find(item => item.notification_id === values[0] && item[column] === values[1]);
      return [row ? [{ notification_id: row.notification_id }] : []];
    }
    throw new Error('Unexpected SQL or write to an unrelated table');
  };
  express.application.listen = function (...args) { server = originalListen.apply(this, args); return server; };
  process.env.PORT = '0';
  try { require('../index'); } finally {
    express.application.listen = originalListen;
    if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  }
  if (!server.listening) await new Promise((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  // Sirf local test API calls allow karenge; accidental external SMS/network request test fail karegi.
  global.fetch = (url, options) => {
    assert.ok(String(url).startsWith(baseUrl + '/'), 'External network requests are forbidden in notification tests');
    return originalFetch(url, options);
  };
});

beforeEach(() => {
  process.env.JWT_SECRET = jwtSecret;
  process.env.JWT_EXPIRES_IN = '1h';
  queries = [];
  users = { donor: new Map([[1, '9876543210'], [2, '9876543211']]),
    recipient: new Map([[1, '9876543212'], [2, '9876543213']]) };
  requests = new Set([1]);
  notifications = [];
  nextId = 1;
  failAt = null;
  errorCode = 'ER_ACCESS_DENIED_ERROR';
  unchangedReadZero = false;
  for (const name of smsNames) delete process.env[name];
  process.env.SMS_ENABLED = 'false';
  smsService.sendSMS = originalSendSMS;
});

after(async () => {
  global.fetch = originalFetch;
  if (server) await new Promise(resolve => server.close(resolve));
  pool.execute = originalExecute;
  smsService.sendSMS = originalSendSMS;
  express.application.listen = originalListen;
  if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  for (const [name, value] of Object.entries(originalSmsEnvironment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  for (const [name, value] of Object.entries(originalJwtEnvironment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await pool.end();
});

test('donor notification is created unread with defaults', async () => {
  const result = await trustedCreate(validBody);
  assert.deepEqual(result, { message: 'Notification created successfully.', notification_id: 1,
    channel: 'InApp', sms: { status: 'disabled', sent: false } });
  assert.equal(notifications[0].is_read, 0);
  assert.equal(notifications[0].request_id, null);
  assert.deepEqual(queries[1].values, [1, null, null, 'InApp', validBody.message]);
});

test('recipient notification is created with request reference', async () => {
  await trustedCreate({ recipient_id: 1, request_id: 1, message: 'Request update', channel: 'InApp' });
  assert.deepEqual(queries[2].values, [null, 1, 1, 'InApp', 'Request update']);
});

test('missing user identifier is rejected', async () => {
  await trustedCreate({ message: 'Hello' }, 400); assert.equal(queries.length, 0);
});

test('missing message is rejected', async () => {
  await trustedCreate({ donor_id: 1 }, 400); assert.equal(queries.length, 0);
});

test('two user identifiers are rejected', async () => {
  await trustedCreate({ ...validBody, recipient_id: 1 }, 400); assert.equal(queries.length, 0);
});

test('two null identifiers are rejected', async () => {
  await trustedCreate({ donor_id: null, recipient_id: null, message: 'Hello' }, 400);
});

test('null unused identifier and null request reference are accepted', async () => {
  await trustedCreate({ ...validBody, recipient_id: null, request_id: null });
  assert.equal(notifications[0].recipient_id, null);
});

for (const field of ['donor_id', 'recipient_id', 'request_id']) {
  ['1', 0, -1, 1.5, 2147483648, true, [], {}, '1 OR 1=1'].forEach((value, index) => {
    test('invalid ' + field + ' case ' + (index + 1), async () => {
      const body = field === 'recipient_id' ? { recipient_id: value, message: 'Hello' } : { ...validBody, [field]: value };
      await trustedCreate(body, 400); assert.equal(queries.length, 0);
    });
  });
}

for (const field of ['donor_id', 'recipient_id', 'request_id']) {
  test('positive INT boundary for ' + field, async () => {
    users.donor.set(2147483647, '9876543210');
    users.recipient.set(2147483647, '9876543212');
    requests.add(2147483647);
    await trustedCreate(field === 'recipient_id' ? { recipient_id: 2147483647, message: 'Hello' } :
      { ...validBody, [field]: 2147483647 });
  });
}

[null, '', '   ', 123, true, [], {}, 'x'.repeat(501), '\u{1FA78}'.repeat(501)].forEach((message, index) => {
  test('invalid message case ' + (index + 1), async () => {
    await trustedCreate({ ...validBody, message }, 400); assert.equal(queries.length, 0);
  });
});

for (const message of ['x', 'x'.repeat(500), '\u{1FA78}'.repeat(500)]) {
  test('message length boundary accepted: ' + [...message].length + ' characters, ' + message.length + ' code units', async () => {
    await trustedCreate({ ...validBody, message }); assert.equal(notifications[0].message, message);
  });
}

test('message surrounding whitespace is removed', async () => {
  await trustedCreate({ ...validBody, message: '  Hello  ' }); assert.equal(notifications[0].message, 'Hello');
});

['SMS', 'Email', 'inapp', null, 1, {}, []].forEach((channel, index) => {
  test('unsupported channel case ' + (index + 1), async () => {
    await trustedCreate({ ...validBody, channel }, 400); assert.equal(queries.length, 0);
  });
});

for (const field of ['notification_id', 'is_read', 'sent_at', 'type', 'user_type', 'user_id', 'phone', 'password', 'SMS_API_KEY']) {
  test('unsupported or server-managed field rejected: ' + field, async () => {
    await trustedCreate({ ...validBody, [field]: 'value' }, 400); assert.equal(queries.length, 0);
  });
}

[undefined, null, [], 'text', 123].forEach((body, index) => {
  test('invalid body case ' + (index + 1), async () => {
    await trustedCreate(body, 400); assert.equal(queries.length, 0);
  });
});

for (const type of ['donor', 'recipient']) {
  test('nonexistent ' + type + ' returns 404 without insert', async () => {
    users[type].clear();
    await trustedCreate({ [type + '_id']: 1, message: 'Hello' }, 404);
    assert.equal(notifications.length, 0);
  });
}

test('nonexistent request reference returns 404 without insert', async () => {
  requests.clear(); await trustedCreate({ ...validBody, request_id: 1 }, 404);
  assert.equal(notifications.length, 0);
});

test('duplicate message is allowed because schema has no message uniqueness constraint', async () => {
  const first = await trustedCreate(validBody); const second = await trustedCreate(validBody);
  assert.notEqual(first.notification_id, second.notification_id);
  assert.equal(notifications.length, 2);
});

test('SQL injection text remains a parameter, never part of SQL', async () => {
  const message = "'); DROP TABLE notifications; --";
  await trustedCreate({ ...validBody, message });
  assert.equal(notifications[0].message, message);
  assert.ok(queries.every(query => !query.sql.includes('DROP TABLE')));
});

for (const stage of ['user', 'request', 'insert']) {
  test('creation database error at ' + stage + ' is safely hidden', async () => {
    failAt = stage;
    await trustedCreate({ ...validBody, request_id: 1 }, 500);
    assert.equal(notifications.length, 0);
  });
}

test('foreign-key race returns safe 404', async () => {
  failAt = 'insert'; errorCode = 'ER_NO_REFERENCED_ROW_2'; await trustedCreate(validBody, 404);
});

test('actual primary-key conflict returns safe 409', async () => {
  failAt = 'insert'; errorCode = 'ER_DUP_ENTRY'; await trustedCreate(validBody, 409);
});

test('malformed JSON returns 400 before SQL', async () => {
  await trustedCreate('{', 400, true); assert.equal(queries.length, 0);
});

test('oversized body returns 413 before SQL', async () => {
  await trustedCreate({ ...validBody, message: 'x'.repeat(110000) }, 413); assert.equal(queries.length, 0);
});

test('donor retrieval excludes other donors and recipients', async () => {
  const own = seed(); seed({ donor_id: 2 }); seed({ donor_id: null, recipient_id: 1 });
  const result = await get();
  assert.deepEqual(result, { user_type: 'donor', user_id: 1, notifications: [own] });
});

test('recipient retrieval excludes donors and other recipients', async () => {
  seed(); const own = seed({ donor_id: null, recipient_id: 1 }); seed({ donor_id: null, recipient_id: 2 });
  const result = await get('recipient');
  assert.deepEqual(result.notifications, [own]);
});

test('existing user with no notifications gets an empty list', async () => {
  assert.deepEqual((await get()).notifications, []);
});

test('retrieval is newest first, ID breaks ties, null timestamp last', async () => {
  const old = seed({ sent_at: '2025-01-01T00:00:00.000Z' });
  const recent1 = seed();
  const recent2 = seed();
  const undated = seed({ sent_at: null });
  assert.deepEqual((await get()).notifications.map(row => row.notification_id),
    [recent2.notification_id, recent1.notification_id, old.notification_id, undated.notification_id]);
});

for (const userType of ['Donor', 'donors', 'admin', 'anything', 'donor OR 1=1']) {
  test('invalid user type rejected: ' + userType, async () => {
    await get(userType, '1', 400); assert.equal(queries.length, 0);
  });
}

for (const id of ['0', '-1', '1.5', '2147483648', '1e3', '+1', ' 1 ', 'abc', '1 OR 1=1']) {
  test('invalid GET ID: ' + id, async () => {
    await get('donor', id, 400); assert.equal(queries.length, 0);
  });
  test('invalid PATCH ID: ' + id, async () => {
    await read(id, 400); assert.equal(queries.length, 0);
  });
}

for (const type of ['donor', 'recipient']) {
  test('retrieval for nonexistent ' + type + ' returns 404', async () => {
    users[type].clear(); await get(type, '1', 404);
  });
}

test('GET query-string injection cannot alter SQL order', async () => {
  await api('GET', '/api/notifications/donor/1?order=DROP%20TABLE%20notifications', undefined, 200);
  assert.ok(queries.every(query => !query.sql.includes('DROP TABLE')));
});

for (const stage of ['user', 'list']) {
  test('retrieval database failure at ' + stage + ' returns safe 500', async () => {
    failAt = stage; await get('donor', '1', 500);
  });
}

test('PATCH sets is_read without changing other notification fields', async () => {
  const row = seed(); const before = { ...row };
  const result = await read();
  assert.deepEqual(result, { message: 'Notification marked as read.', notification_id: 1, is_read: 1 });
  assert.deepEqual(row, { ...before, is_read: 1 });
});

test('already-read PATCH is idempotent even when affectedRows is zero', async () => {
  seed({ is_read: 1 }); unchangedReadZero = true;
  await read(); await read(); assert.equal(notifications[0].is_read, 1);
});

test('missing notification PATCH returns 404', async () => { await read('1', 404); });

test('empty PATCH body is accepted', async () => { seed(); await read('1', 200, {}); });

for (const body of [null, [], 'text', 1, { is_read: 0 }, { donor_id: 2 }, { message: 'overwrite' }]) {
  test('PATCH rejects body override case ' + JSON.stringify(body), async () => {
    seed(); await read('1', 400, body); assert.equal(notifications[0].is_read, 0);
    assert.equal(queries.length, 0);
  });
}

for (const stage of ['update', 'read_lookup']) {
  test('PATCH database failure at ' + stage + ' is safe 500', async () => {
    failAt = stage; await read('1', 500);
  });
}

test('reusable donor helper accepts a request reference', async () => {
  const result = await notifyDonor(1, 'Donor alert', 1);
  assert.equal(result.notification_id, 1); assert.equal(notifications[0].donor_id, 1);
  assert.equal(notifications[0].request_id, 1);
});

test('reusable helper also validates input and nonexistent users', async () => {
  await assert.rejects(() => notifyDonor(0, 'Hello'), NotificationError);
  await assert.rejects(() => createNotification({ ...validBody, message: '' }), NotificationError);
  users.donor.clear();
  await assert.rejects(() => notifyDonor(1, 'Hello'), error => error instanceof NotificationError && error.status === 404);
  assert.equal(notifications.length, 0);
});

test('SMS disabled makes no provider calls', async () => {
  let called = false;
  const result = await originalSendSMS('9876543210', 'Hello', async () => { called = true; return true; });
  assert.deepEqual(result, { status: 'disabled', sent: false }); assert.equal(called, false);
});

for (const enabled of [undefined, '', 'false', 'FALSE', 'yes', '1']) {
  test('SMS safely defaults disabled for configuration ' + String(enabled), async () => {
    if (enabled === undefined) delete process.env.SMS_ENABLED; else process.env.SMS_ENABLED = enabled;
    assert.deepEqual(await originalSendSMS('9876543210', 'Hello'), { status: 'disabled', sent: false });
  });
}

for (const missing of ['SMS_PROVIDER', 'SMS_API_KEY', 'SMS_SENDER_ID']) {
  test('missing SMS configuration: ' + missing, async () => {
    let called = false;
    mockProvider(async () => { called = true; return true; });
    delete process.env[missing];
    const result = await trustedCreate(validBody);
    assert.deepEqual(result.sms, { status: 'not_configured', sent: false });
    assert.equal(called, false); assert.equal(notifications.length, 1);
  });
}

test('enabled SMS without installed adapter reports not configured', async () => {
  mockProvider(async () => true); smsService.sendSMS = originalSendSMS;
  assert.deepEqual((await trustedCreate(validBody)).sms, { status: 'not_configured', sent: false });
});

test('explicit SMS test mode never claims real delivery', async () => {
  process.env.SMS_ENABLED = 'true'; process.env.SMS_PROVIDER = 'test';
  let called = false;
  const direct = await originalSendSMS('9876543210', 'Hello', async () => { called = true; return true; });
  assert.deepEqual(direct, { status: 'test_mode', sent: false });
  assert.equal(called, false);
  assert.deepEqual((await trustedCreate(validBody)).sms, { status: 'test_mode', sent: false });
});

test('mocked provider success follows database save and hides configuration', async () => {
  mockProvider(async config => {
    assert.equal(notifications.length, 1);
    assert.equal(config.apiKey, fakeKey);
    assert.equal(config.senderId, 'LifeSaver');
    assert.equal(config.phoneNumber, '9876543210');
    assert.equal(config.message, validBody.message);
    return true;
  });
  const result = await trustedCreate(validBody);
  assert.deepEqual(result.sms, { status: 'sent', sent: true });
  assert.equal(notifications.length, 1);
});

for (const providerResult of [false, null, undefined, { apiKey: fakeKey }, 'accepted']) {
  test('unconfirmed provider result stays failed: ' + typeof providerResult, async () => {
    mockProvider(async () => providerResult);
    assert.deepEqual((await trustedCreate(validBody)).sms, { status: 'failed', sent: false });
    assert.equal(notifications.length, 1);
  });
}

test('provider exception hides secrets and leaves in-app record saved', async () => {
  mockProvider(async () => { throw new Error(fakeKey); });
  assert.deepEqual((await trustedCreate(validBody)).sms, { status: 'failed', sent: false });
  assert.equal(notifications.length, 1);
});

test('unexpected SMS service exception cannot fail notification creation', async () => {
  smsService.sendSMS = async () => { throw new Error(fakeKey); };
  assert.deepEqual((await trustedCreate(validBody)).sms, { status: 'failed', sent: false });
  assert.equal(notifications.length, 1);
});

for (const phone of [undefined, null, 123, '', 'abc', '123456789', '1'.repeat(16), '+123456789012345', '98765 43210', '+1 OR 1=1']) {
  test('SMS invalid phone case ' + String(phone), async () => {
    assert.deepEqual(await originalSendSMS(phone, 'Hello'), { status: 'invalid_input', sent: false });
  });
}

for (const message of [undefined, null, 1, '', '   ', 'x'.repeat(501)]) {
  test('SMS invalid message case ' + String(message).slice(0, 10), async () => {
    assert.deepEqual(await originalSendSMS('9876543210', message), { status: 'invalid_input', sent: false });
  });
}

test('SMS adapter receives normalized phone and message only when enabled', async () => {
  mockProvider(async config => {
    assert.equal(config.phoneNumber, '+919876543210');
    assert.equal(config.message, 'Hello'); return true;
  });
  assert.deepEqual(await smsService.sendSMS(' +919876543210 ', ' Hello '), { status: 'sent', sent: true });
});

test('legacy invalid user phone cannot prevent in-app notification save', async () => {
  users.donor.set(1, 'invalid');
  assert.deepEqual((await trustedCreate(validBody)).sms, { status: 'invalid_input', sent: false });
  assert.equal(notifications.length, 1);
});

for (const role of ['donor', 'recipient']) {
  const other = role === 'donor' ? 'recipient' : 'donor';
  const fixture = (id, overrides = {}) => ({ donor_id: null, recipient_id: null, [role + '_id']: id, ...overrides });
  test(role + ' owner2 notification list and mark-read use JWT identity', async () => {
    const own = seed(fixture(2)); const foreign = seed(fixture(1));
    const token = 'Bearer ' + createToken(2, role);
    assert.deepEqual((await get(role, '2', 200, token)).notifications, [own]);
    await read(String(own.notification_id), 200, undefined, token);
    assert.equal(own.is_read, 1); assert.equal(foreign.is_read, 0);
    assert.deepEqual(queries.at(-1).values, [1, own.notification_id, 2]);
  });
  for (const [targetRole, targetId] of [[role, '2'], [other, '1']]) {
    test(role + ' cannot read notifications for ' + targetRole + '/' + targetId, async () => {
      await get(targetRole, targetId, 403, 'Bearer ' + createToken(1, role));
      assert.equal(queries.length, 0);
    });
  }
  test(role + ' query cannot override notification ownership', async () => {
    const own = seed(fixture(1)); seed(fixture(2));
    const result = await api('GET', '/api/notifications/' + role + '/1?donor_id=2&recipient_id=2&user_type=' + other,
      undefined, 200, false, 'Bearer ' + createToken(1, role));
    assert.deepEqual(result.notifications, [own]);
    assert.ok(queries.every(query => query.values[0] === 1));
  });
  for (const overrides of [fixture(2), { donor_id: null, recipient_id: null, [other + '_id']: 1 }, fixture(2, { is_read: 1 })]) {
    test(role + ' foreign notification stays hidden: ' + JSON.stringify(overrides), async () => {
      const row = seed(overrides);
      await read(String(row.notification_id), 404, undefined, 'Bearer ' + createToken(1, role));
      assert.equal(row.is_read, overrides.is_read || 0);
      assert.equal(queries.length, 2);
      assert.deepEqual(queries[0].values, [1, row.notification_id, 1]);
      assert.deepEqual(queries[1].values, [row.notification_id, 1]);
      assert.ok(queries.every(query => query.sql.includes('AND ' + role + '_id = ?')));
    });
  }
  test(role + ' own already-read lookup is owner-constrained', async () => {
    const row = seed(fixture(2, { is_read: 1 })); unchangedReadZero = true;
    await read(String(row.notification_id), 200, undefined, 'Bearer ' + createToken(2, role));
    assert.equal(queries.length, 2);
    assert.deepEqual(queries[1].values, [row.notification_id, 2]);
  });
}
for (const [method, path] of [['GET', '/api/notifications/donor/1'], ['PATCH', '/api/notifications/1/read']]) {
  const headers = [
    ['missing', () => null], ['scheme', () => 'Basic abc'], ['malformed', () => 'Bearer a b'],
    ['invalid', () => 'Bearer not-a-jwt'],
    ['expired', () => 'Bearer ' + jwt.sign({ user_id: 1, user_type: 'donor' }, jwtSecret, { expiresIn: '-1s' })],
    ['wrong-secret', () => 'Bearer ' + jwt.sign({ user_id: 1, user_type: 'donor' }, otherJwtSecret, { expiresIn: '1h' })],
    ['tampered', () => {
      const [header, payload, signature] = createToken(1, 'donor').split('.');
      const changed = JSON.parse(Buffer.from(payload, 'base64url').toString());
      changed.user_id = 2;
      return 'Bearer ' + header + '.' + Buffer.from(JSON.stringify(changed)).toString('base64url') + '.' + signature;
    }],
  ];
  for (const [label, makeHeader] of headers) {
    test(method + ' notifications reject ' + label + ' auth before SQL', async () => {
      const row = seed();
      await api(method, path, undefined, 401, false, makeHeader());
      assert.equal(queries.length, 0); assert.equal(row.is_read, 0);
    });
  }
  test(method + ' notifications hide JWT configuration failure', async () => {
    const auth = 'Bearer ' + createToken(1, 'donor');
    process.env.JWT_SECRET = 'short';
    await api(method, path, undefined, 500, false, auth);
    assert.equal(queries.length, 0);
  });
}

test('notification HTTP creation rejects unauthenticated clients before SQL', async () => {
  await api('POST', '/api/notifications', validBody, 401);
  assert.equal(queries.length, 0); assert.equal(notifications.length, 0);
});
for (const role of ['donor', 'recipient', 'blood_bank']) {
  test(role + ' client cannot create notifications for arbitrary users', async () => {
    await api('POST', '/api/notifications', validBody, 403, false, 'Bearer ' + createToken(1, role));
    assert.equal(queries.length, 0); assert.equal(notifications.length, 0);
  });
}
for (const [method, path] of [['GET', '/api/notifications/recipient/1'], ['GET', '/api/notifications/donor/1'], ['PATCH', '/api/notifications/1/read']]) {
  test('blood bank cannot use ' + method + ' user-notification role branch', async () => {
    const note = seed({ donor_id: null, recipient_id: 1 });
    await api(method, path, undefined, 403, false, 'Bearer ' + createToken(1, 'blood_bank'));
    assert.equal(queries.length, 0); assert.equal(note.is_read, 0);
  });
}
test('trusted fallback notification uses supplied transaction and never sends SMS', async () => {
  const calls = [];
  const executor = { execute: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT donor_id')) return [[{ donor_id: 1, phone: '9876543210' }]];
    if (sql.startsWith('SELECT request_id')) return [[{ request_id: 1 }]];
    assert.ok(sql.startsWith('INSERT INTO notifications'));
    return [{ insertId: 9 }];
  } };
  smsService.sendSMS = async () => { throw new Error('SMS must not run inside a transaction'); };
  const result = await notifyDonor(1, 'Fallback notification', 1, { executor, sendSMS: false });
  assert.equal(result.notification_id, 9);
  assert.deepEqual(result.sms, { status: 'disabled', sent: false });
  assert.equal(calls.length, 3); assert.equal(queries.length, 0);
  assert.deepEqual(calls[2].values, [1, null, 1, 'InApp', 'Fallback notification']);
});
