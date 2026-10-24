const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../db');
const { randomBytes } = require('node:crypto');
const { createToken } = require('../services/jwtService');
const originalSecret = process.env.JWT_SECRET;
const originalExpiry = process.env.JWT_EXPIRES_IN;
const secret = randomBytes(32).toString('hex');

const originalExecute = pool.execute;
const originalGetConnection = pool.getConnection;
const originalListen = express.application.listen;
const originalPort = process.env.PORT;
const validInput = { bank_id: 1, blood_group: 'O+', units_available: 10 };
let server;
let baseUrl;
let banks;
let inventory;
let queries;
let errorStage;
let errorCode;
let organizations, events, tail;

function seed(group = 'O+', units = 10, bankId = 1) {
  const row = { inventory_id: inventory.length + 1, bank_id: bankId, blood_group: group,
    units_available: units, version: 0, updated_at: '2026-01-01T00:00:00.000Z' };
  inventory.push(row);
  return row;
}

function assertSafe(body) {
  for (const [key, value] of Object.entries(body)) {
    assert.ok(!['password', 'password_hash', 'stack', 'sql'].includes(key));
    if (value && typeof value === 'object') assertSafe(value);
  }
}

async function request(method, path, body, status, raw = false, token = createToken(1, 'blood_bank')) {
  const response = await fetch(baseUrl + '/api/inventory' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: raw ? body : JSON.stringify(body),
  });
  assert.equal(response.status, status);
  const result = await response.json();
  assertSafe(result);
  return result;
}

before(async () => {
  process.env.JWT_SECRET = secret;
  process.env.JWT_EXPIRES_IN = '1h';
  // All SQL uses in-memory fixtures. Transaction locks model serialized writers without connecting to MySQL.
  async function execute(sql, values) {
    const providerQuery = sql.includes('FROM blood_banks b LEFT JOIN organizations')
      || sql.includes('FROM organizations o LEFT JOIN blood_banks');
    queries.push({ sql, values, provider: providerQuery });
    let stage;
    if (providerQuery) stage = 'bank';
    else if (sql.startsWith('INSERT INTO blood_inventory')) stage = 'insert';
    else if (sql.startsWith('UPDATE blood_inventory')) stage = 'update';
    else if (sql.startsWith('SELECT inventory_id, units_available, version')) stage = 'lock';
    else if (sql.startsWith('SELECT inventory_id,')) stage = 'list';
    else if (sql.startsWith('SELECT units_available')) stage = 'check';
    else throw new Error('Unexpected SQL statement: ' + sql);
    if (errorStage === stage) {
      const error = new Error('Private SQL/server details'); error.code = errorCode; throw error;
    }
    if (providerQuery) {
      assert.equal(values.length, 1);
      if (sql.includes('FROM organizations o LEFT JOIN blood_banks')) return [[...organizations.values()].filter(row => row.organization_id === values[0])];
      return [banks.has(values[0]) ? [{ bank_id: values[0], organization_id: null, organization_type: 'Blood Bank' }] : []];
    }
    if (stage === 'insert') {
      assert.equal(sql, 'INSERT INTO blood_inventory (bank_id, blood_group, units_available) VALUES (?, ?, ?)');
      assert.equal(values.length, 3);
      if (inventory.some(row => row.bank_id === values[0] && row.blood_group === values[1])) {
        const error = new Error('Duplicate pair'); error.code = 'ER_DUP_ENTRY'; throw error;
      }
      const row = seed(values[1], values[2], values[0]);
      return [{ insertId: row.inventory_id, affectedRows: 1 }];
    }
    if (stage === 'list') {
      assert.equal(sql, 'SELECT inventory_id, bank_id, blood_group, units_available, updated_at, version FROM blood_inventory WHERE bank_id = ? ORDER BY blood_group');
      return [inventory.filter(row => row.bank_id === values[0])];
    }
    if (stage === 'check') {
      assert.equal(sql, 'SELECT units_available FROM blood_inventory WHERE bank_id = ? AND blood_group = ? LIMIT 1');
      const row = inventory.find(item => item.bank_id === values[0] && item.blood_group === values[1]);
      return [row ? [{ units_available: row.units_available }] : []];
    }
    if (stage === 'lock') {
      assert.ok(sql.endsWith('FOR UPDATE'));
      const row = inventory.find(item => item.bank_id === values[0] && item.blood_group === values[1]);
      return [row ? [{ ...row }] : []];
    }
    assert.equal(sql, 'UPDATE blood_inventory SET units_available = ?, version = version + 1 WHERE inventory_id = ?');
    const row = inventory.find(item => item.inventory_id === values[1]);
    assert.ok(row); row.units_available = values[0]; row.version++; row.updated_at = new Date().toISOString();
    return [{ affectedRows: 1 }];
  }
  pool.execute = execute;
  pool.getConnection = async () => {
    let unlock, snapshot, active = false;
    function finish(restore = false) {
      if (restore && snapshot) inventory = snapshot;
      snapshot = null; active = false; unlock?.(); unlock = null;
    }
    return {
      async beginTransaction() {
        events.push('begin');
        const previous = tail; tail = new Promise(resolve => { unlock = resolve; });
        await previous; snapshot = structuredClone(inventory); active = true;
      },
      async execute(sql, values) { assert.equal(active, true); return execute(sql, values); },
      async commit() { events.push('commit'); if (errorStage === 'commit') { const error = new Error('Private commit failure'); error.code = errorCode; throw error; } finish(); },
      async rollback() { events.push('rollback'); finish(true); },
      release() { assert.equal(active, false); events.push('release'); },
      destroy() { finish(true); events.push('destroy'); },
    };
  };
  // Actual index.js use karenge, taaki routing aur shared JSON middleware bhi test ho.
  express.application.listen = function (...args) { server = originalListen.apply(this, args); return server; };
  process.env.PORT = '0';
  try { require('../index'); } finally {
    express.application.listen = originalListen;
    if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  }
  if (!server.listening) await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

beforeEach(() => {
  banks = new Set([1]); inventory = []; queries = []; errorStage = null; errorCode = null;
  organizations = new Map([[11, { organization_id: 11, bank_id: 1, organization_type: 'Blood Bank' }], [12, { organization_id: 12, bank_id: 2, organization_type: 'Hospital' }], [13, { organization_id: 13, bank_id: null, organization_type: 'NGO' }]]);
  events = []; tail = Promise.resolve();
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  pool.execute = originalExecute;
  pool.getConnection = originalGetConnection;
  express.application.listen = originalListen;
  if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
  if (originalExpiry === undefined) delete process.env.JWT_EXPIRES_IN; else process.env.JWT_EXPIRES_IN = originalExpiry;
  await pool.end();
});

test('POST valid inventory creates a row with 201', async () => {
  const result = await request('POST', '', validInput, 201);
  assert.deepEqual(result, { message: 'Inventory created successfully.', inventory_id: 1, version: 0 });
  assert.deepEqual(queries[1].values, [1, 'O+', 10]);
});

test('POST zero units is valid', async () => {
  await request('POST', '', { ...validInput, units_available: 0 }, 201);
  assert.equal(inventory[0].units_available, 0);
});

test('POST accepts the positive INT bank ID boundary', async () => {
  banks.add(2147483647);
  await request('POST', '', { ...validInput, bank_id: 2147483647 }, 201, false, createToken(2147483647, 'blood_bank'));
});

test('POST accepts the INT unit boundary', async () => {
  await request('POST', '', { ...validInput, units_available: 2147483647 }, 201);
});

for (const field of ['bank_id', 'blood_group', 'units_available']) {
  test('POST missing ' + field + ' returns 400 before inventory SQL', async () => {
    const body = { ...validInput }; delete body[field];
    await request('POST', '', body, 400);
    assert.equal(queries.filter(query => !query.provider).length, 0);
  });
}

[null, '', '   ', '1', 0, -1, 1.5, 2147483648, true, [], {}, '1 OR 1=1'].forEach((value, index) => {
  test('POST invalid bank ID case ' + (index + 1), async () => {
    await request('POST', '', { ...validInput, bank_id: value }, 400);
    assert.equal(queries.filter(query => !query.provider).length, 0);
  });
});

for (const group of ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']) {
  test('POST accepts supported blood group ' + group, async () => {
    await request('POST', '', { ...validInput, blood_group: group }, 201);
  });
}

['', '   ', null, 123, 'Unknown', 'o+', [], {}, "O+' OR 1=1"].forEach((value, index) => {
  test('POST invalid blood group case ' + (index + 1), async () => {
    await request('POST', '', { ...validInput, blood_group: value }, 400);
    assert.equal(queries.filter(query => !query.provider).length, 0);
  });
});

[undefined, null, '', '   ', '10', -1, 1.5, 2147483648, true, [], {}].forEach((value, index) => {
  test('POST invalid units case ' + (index + 1), async () => {
    await request('POST', '', { ...validInput, units_available: value }, 400);
    assert.equal(queries.filter(query => !query.provider).length, 0);
  });
  test('PUT invalid units case ' + (index + 1), async () => {
    seed();
    await request('PUT', '/1/O%2B', { units_available: value }, 400);
    assert.equal(queries.filter(query => !query.provider).length, 0);
  });
});

for (const field of ['inventory_id', 'updated_at', 'extra']) {
  test('POST rejects forbidden field ' + field, async () => {
    await request('POST', '', { ...validInput, [field]: 1 }, 400);
    assert.equal(queries.filter(query => !query.provider).length, 0);
  });
}

for (const field of ['inventory_id', 'bank_id', 'blood_group', 'updated_at', 'extra']) {
  test('PUT rejects forbidden field ' + field, async () => {
    await request('PUT', '/1/O%2B', { units_available: 15, [field]: 1 }, 400);
    assert.equal(queries.filter(query => !query.provider).length, 0);
  });
}

for (const [method, path] of [['POST', ''], ['PUT', '/1/O%2B']]) {
  [undefined, null, [], 'text', 123].forEach((value, index) => test(method + ': invalid body case ' + (index + 1), async () => {
    await request(method, path, value, 400);
    assert.equal(queries.filter(query => !query.provider).length, 0);
  }));
  test(method + ': malformed JSON returns 400', async () => {
    await request(method, path, '{', 400, true);
    assert.equal(queries.filter(query => !query.provider).length, 0);
  });
  test(method + ': oversized JSON returns 413', async () => {
    await request(method, path, { units_available: 'x'.repeat(110000) }, 413);
    assert.equal(queries.filter(query => !query.provider).length, 0);
  });
}

const invalidPathIds = ['0', '-1', '1.5', '2147483648', '1e3', 'abc', 'null', '+1', ' 1 ', "1 OR 1=1"];
for (const [method, pattern, body] of [
  ['GET', id => '/' + id, undefined],
  ['GET', id => '/check/' + id + '/O%2B', undefined],
  ['PUT', id => '/' + id + '/O%2B', { units_available: 15, expected_version: 0 }],
]) {
  invalidPathIds.forEach((value, index) => test(method + ' ' + pattern('ID') + ': invalid ID case ' + (index + 1), async () => {
    await request(method, pattern(encodeURIComponent(value)), body, 400);
    assert.equal(queries.filter(query => !query.provider).length, 0);
  }));
}

for (const method of ['GET', 'PUT']) {
  for (const value of ['Unknown', 'o+', ' ', "O+' OR 1=1"]) {
    test(method + ': invalid path blood group ' + value, async () => {
      const path = method === 'GET' ? '/check/1/' + encodeURIComponent(value) : '/1/' + encodeURIComponent(value);
      await request(method, path, method === 'PUT' ? { units_available: 15, expected_version: 0 } : undefined, 400);
      assert.equal(queries.filter(query => !query.provider).length, 0);
    });
  }
}

for (const [method, path, body] of [
  ['POST', '', validInput], ['GET', '/1', undefined],
  ['PUT', '/1/O%2B', { units_available: 15, expected_version: 0 }], ['GET', '/check/1/O%2B', undefined],
]) {
  test(method + ' ' + (path || '/') + ': nonexistent bank cannot access inventory', async () => {
    banks.clear();
    assert.deepEqual(await request(method, path, body, 403), { message: 'Only Blood Bank organizations can manage inventory.' });
    assert.equal(queries.length, 1);
  });
}

test('POST duplicate bank/group returns 409', async () => {
  seed();
  const result = await request('POST', '', validInput, 409);
  assert.deepEqual(result, { message: 'Another operation changed this request. Refresh before retrying.' });
});

test('POST same group at different banks is allowed', async () => {
  seed(); banks.add(2);
  await request('POST', '', { ...validInput, bank_id: 2 }, 201, false, createToken(2, 'blood_bank'));
});

test('POST bank deleted after lookup returns a safe failure', async () => {
  errorStage = 'insert'; errorCode = 'ER_NO_REFERENCED_ROW_2';
  await request('POST', '', validInput, 500);
});

test('GET inventory returns only the requested bank', async () => {
  const expected = seed(); banks.add(2); seed('A+', 5, 2);
  assert.deepEqual(await request('GET', '/1', undefined, 200), { bank_id: 1, inventory: [expected] });
  assert.deepEqual(queries[1].values, [1]);
});

test('GET existing bank with no stock returns an empty list', async () => {
  assert.deepEqual(await request('GET', '/1', undefined, 200), { bank_id: 1, inventory: [] });
});

test('GET accepts a leading-zero integer URL', async () => {
  await request('GET', '/01', undefined, 200);
  assert.deepEqual(queries[0].values, [1]);
});

test('GET query-string injection is not interpolated', async () => {
  await request('GET', '/1?order=DROP%20TABLE%20blood_inventory', undefined, 200);
  assert.ok(queries.every(query => !query.sql.includes('DROP TABLE')));
});

for (const group of ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']) {
  test('GET availability accepts group ' + group, async () => {
    seed(group, 10);
    assert.deepEqual(await request('GET', '/check/1/' + encodeURIComponent(group), undefined, 200), {
      bank_id: 1, blood_group: group, units_available: 10, available: true,
    });
  });
}

test('GET availability handles literal plus signs in the URL', async () => {
  seed();
  assert.equal((await request('GET', '/check/1/O+', undefined, 200)).available, true);
});

test('GET zero inventory is unavailable', async () => {
  seed('O+', 0);
  assert.deepEqual(await request('GET', '/check/1/O%2B', undefined, 200), {
    bank_id: 1, blood_group: 'O+', units_available: 0, available: false,
  });
});

test('GET missing inventory is unavailable with 200', async () => {
  assert.deepEqual(await request('GET', '/check/1/O%2B', undefined, 200), {
    bank_id: 1, blood_group: 'O+', units_available: 0, available: false,
  });
});

test('PUT changes only units and keeps identifiers', async () => {
  const row = seed();
  const result = await request('PUT', '/1/O%2B', { units_available: 15, expected_version: 0 }, 200);
  assert.deepEqual(result, { message: 'Inventory updated successfully.', bank_id: 1, blood_group: 'O+', units_available: 15, version: 1 });
  assert.equal(row.inventory_id, 1);
  assert.equal(row.bank_id, 1);
  assert.equal(row.blood_group, 'O+');
  assert.equal(row.units_available, 15);
  assert.deepEqual(queries.at(-1).values, [15, 1]);
  assert.equal(row.version, 1); assert.deepEqual(events, ['begin', 'commit', 'release']);
});

test('PUT zero stock makes availability false', async () => {
  seed();
  await request('PUT', '/1/O%2B', { units_available: 0, expected_version: 0 }, 200);
  assert.equal((await request('GET', '/check/1/O%2B', undefined, 200)).available, false);
});

test('PUT unchanged units advances the revision in a locked transaction', async () => {
  seed();
  await request('PUT', '/1/O%2B', { units_available: 10, expected_version: 0 }, 200);
  assert.equal(queries.length, 3);
});

test('PUT explicitly creates a missing blood group row', async () => {
  await request('PUT', '/1/O%2B', { units_available: 15, expected_version: 0 }, 200);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].units_available, 15);
});

test('PUT allows maximum INT units', async () => {
  seed();
  await request('PUT', '/1/O%2B', { units_available: 2147483647, expected_version: 0 }, 200);
});

for (const [stage, method, path, body] of [
  ['bank', 'POST', '', validInput], ['insert', 'POST', '', validInput],
  ['bank', 'GET', '/1', undefined], ['list', 'GET', '/1', undefined],
  ['bank', 'PUT', '/1/O%2B', { units_available: 15, expected_version: 0 }], ['update', 'PUT', '/1/O%2B', { units_available: 15, expected_version: 0 }],
  ['bank', 'GET', '/check/1/O%2B', undefined], ['check', 'GET', '/check/1/O%2B', undefined],
]) {
  test(method + ' ' + (path || '/') + ': safe 500 at ' + stage, async () => {
    seed();
    if (stage === 'insert') inventory = [];
    errorStage = stage; errorCode = 'ER_ACCESS_DENIED_ERROR';
    const result = await request(method, path, body, 500);
    assert.deepEqual(Object.keys(result), ['message']);
    assert.ok(!result.message.includes('ER_ACCESS_DENIED_ERROR'));
  });
}

for (const [method, path, body] of [
  ['POST', '', validInput], ['GET', '/1', undefined],
  ['PUT', '/1/O%2B', { units_available: 15, expected_version: 0 }], ['GET', '/check/1/O%2B', undefined],
]) {
  test(method + ' ' + (path || '/') + ': missing JWT is rejected before inventory SQL', async () => {
    await request(method, path, body, 401, false, null);
    assert.equal(queries.length, 0);
  });
  for (const role of ['donor', 'recipient']) {
    test(method + ' ' + (path || '/') + ': ' + role + ' cannot access bank inventory', async () => {
      await request(method, path, body, 403, false, createToken(1, role));
      assert.equal(queries.length, 0);
    });
  }
}

for (const [method, path, body] of [
  ['POST', '', { ...validInput, bank_id: 2 }], ['GET', '/2', undefined],
  ['PUT', '/2/O%2B', { units_available: 15, expected_version: 0 }], ['GET', '/check/2/O%2B', undefined],
]) {
  test(method + ' ' + (path || '/') + ': cross-bank access rejected before inventory SQL', async () => {
    banks.add(2); seed('O+', 5, 2);
    await request(method, path, body, 403);
    assert.equal(queries.filter(query => !query.provider).length, 0);
    assert.equal(inventory[0].units_available, 5);
  });
}

test('concurrent explicit edits use one unique bank/group row', async () => {
  await Promise.all([
    request('PUT', '/1/A%2B', { units_available: 10, expected_version: 0 }, 200),
    request('PUT', '/1/A%2B', { units_available: 15, expected_version: 0 }, 200),
  ]);
  assert.equal(inventory.length, 1);
  assert.ok([10, 15].includes(inventory[0].units_available));
  assert.equal(queries.filter(query => query.sql.startsWith('INSERT')).length, 1);
  assert.equal(inventory[0].version, 1);
});

test('existing inventory requires the current expected_version before changing stock', async () => {
  seed();
  await request('PUT', '/1/O%2B', { units_available: 15 }, 400);
  assert.equal(inventory[0].units_available, 10);
  assert.ok(events.includes('rollback')); assert.ok(!events.includes('commit'));
});
test('stale revision cannot restore inventory after another edit or deduction', async () => {
  const row = seed(); row.version = 4; row.units_available = 2;
  await request('PUT', '/1/O%2B', { units_available: 10, expected_version: 3 }, 409);
  assert.equal(inventory[0].units_available, 2); assert.equal(inventory[0].version, 4);
});
test('two edits of one existing revision allow one writer and return a safe conflict to the other', async () => {
  seed('A+', 5);
  const responses = await Promise.all([
    fetch(baseUrl + '/api/inventory/1/A%2B', { method: 'PUT', headers: { Authorization: 'Bearer ' + createToken(1, 'blood_bank'), 'Content-Type': 'application/json' }, body: JSON.stringify({ units_available: 10, expected_version: 0 }) }),
    fetch(baseUrl + '/api/inventory/1/A%2B', { method: 'PUT', headers: { Authorization: 'Bearer ' + createToken(1, 'blood_bank'), 'Content-Type': 'application/json' }, body: JSON.stringify({ units_available: 15, expected_version: 0 }) }),
  ]);
  assert.deepEqual(responses.map(row => row.status).sort(), [200, 409]);
  assert.equal(inventory.length, 1); assert.equal(inventory[0].version, 1);
  assert.ok([10, 15].includes(inventory[0].units_available));
  for (const response of responses) assertSafe(await response.json());
});
test('Blood Bank organization uses its linked bank rather than its organization JWT ID', async () => {
  seed(); const result = await request('GET', '/1', undefined, 200, false, createToken(11, 'organization'));
  assert.equal(result.bank_id, 1); assert.equal(queries[0].values[0], 11);
});
for (const organizationId of [12, 13]) test('Hospital and NGO accounts cannot view or change bank inventory: ' + organizationId, async () => {
  seed();
  await request('GET', '/1', undefined, 403, false, createToken(organizationId, 'organization'));
  await request('PUT', '/1/O%2B', { units_available: 99, expected_version: 0 }, 403, false, createToken(organizationId, 'organization'));
  assert.equal(inventory[0].units_available, 10); assert.equal(events.length, 0);
});

test('inventory commit failure rolls back the changed units and revision', async () => {
  seed(); const before = structuredClone(inventory); errorStage = 'commit'; errorCode = 'ER_ACCESS_DENIED_ERROR';
  await request('PUT', '/1/O%2B', { units_available: 99, expected_version: 0 }, 500);
  assert.deepEqual(inventory, before); assert.deepEqual(events, ['begin', 'commit', 'rollback', 'release']);
});
