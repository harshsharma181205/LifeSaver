const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const pool = require('../db');
const config = require('../services/workflowV2Config');
const { runAction } = require('../services/cityWideClinicalService');

const original = { execute: pool.execute, query: pool.query, getConnection: pool.getConnection,
  enabled: process.env.LIFESAVER_WORKFLOW_V2 };
let state, events, tail, failure, rollbackFails;
const bank = id => ({ user_type: 'organization', user_id: id });
const keyBody = () => ({ operation_key: randomUUID() });
const collectionBody = (overrides = {}) => ({ donor_id: 10, units_donated: 2, operation_key: randomUUID(), ...overrides });
const screenBody = result => ({ donor_id: 10, result });

function fixture() {
  return {
    requests: [{ request_id: 1, recipient_id: 5, bank_id: null, organization_id: null,
      workflow_version: 2, admission_hospital_id: 90, state: 'Maharashtra', city: 'Pune',
      blood_group: 'O+', units_required: 7, urgency_level: 'Emergency', status: 'Pending', donor_matching_started_at: null }],
    providers: [
      { organization_id: 20, bank_id: 2, organization_type: 'Blood Bank', state: 'Maharashtra', city: 'Pune' },
      { organization_id: 30, bank_id: 3, organization_type: 'Blood Bank', state: 'Maharashtra', city: '  PUNE ' },
      { organization_id: 40, bank_id: 4, organization_type: 'Blood Bank', state: 'Maharashtra', city: 'Mumbai' },
      { organization_id: 90, bank_id: 9, organization_type: 'Hospital', state: 'Maharashtra', city: 'Pune' },
      { organization_id: 91, bank_id: null, organization_type: 'NGO', state: 'Maharashtra', city: 'Pune' },
    ],
    stock: [{ inventory_id: 2, bank_id: 2, blood_group: 'O+', units_available: 3, version: 0 },
      { inventory_id: 3, bank_id: 3, blood_group: 'O+', units_available: 5, version: 0 },
      { inventory_id: 4, bank_id: 4, blood_group: 'O+', units_available: 100, version: 0 },
      { inventory_id: 5, bank_id: 2, blood_group: 'A+', units_available: 100, version: 0 }],
    donors: [{ donor_id: 10, name: 'Memory donor', blood_group: 'O+', is_available: 1,
      state: 'Maharashtra', city: 'Pune', phone: 'private-phone', last_donation: null }],
    responses: [{ request_id: 1, donor_id: 10, response: 'Accepted', collecting_bank_id: 2,
      screening_result: 'Passed', screened_by_organization_id: 20 }],
    allocations: [], donations: [], collections: [], notifications: [], nextDonation: 1,
    nextCollection: 1, nextAllocation: 1, nextInventory: 100,
  };
}

async function execute(data, sql, values = []) {
  events.push({ sql, values });
  if (failure && sql.startsWith(failure)) { const error = new Error('Private SQL failure'); error.code = 'ER_TEST'; throw error; }
  if (sql.startsWith('SELECT b.bank_id, o.organization_id, o.organization_type')) return [data.providers.filter(row => row.organization_type === 'Blood Bank').map(row => ({
    ...row, ...(data.stock.find(stock => stock.bank_id === row.bank_id && stock.blood_group === values[0]) || { inventory_id: null, units_available: null }),
  }))];
  if (sql.startsWith('SELECT TABLE_NAME, COLUMN_NAME')) return [Object.entries(config.requiredColumns)
    .flatMap(([table, columns]) => columns.map(column => ({ TABLE_NAME: table, COLUMN_NAME: column })))];
  if (sql.startsWith('SELECT version FROM workflow_schema_versions')) return [[{ version: 2 }]];
  if (sql.startsWith('SELECT * FROM blood_requests')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [data.requests.filter(row => row.request_id === values[0]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT o.organization_id') || sql.startsWith('SELECT b.bank_id, b.organization_id')) {
    assert.ok(sql.endsWith('FOR SHARE'), 'Current provider eligibility must be a locking read');
    const column = sql.includes('WHERE o.organization_id') ? 'organization_id' : 'bank_id';
    return [data.providers.filter(row => row[column] === values[0]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT allocation_id, donation_id, inventory_id')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [data.allocations.filter(row => row.request_id === values[0]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('SELECT allocation_id, inventory_id')) return [data.allocations.filter(row => row.request_id === values[0] && row.operation_key === values[1])];
  if (sql.startsWith('SELECT collection_id, request_id')) return [data.collections.filter(row => row.request_id === values[0] && row.operation_key === values[1])];
  if (sql.startsWith('SELECT collection_id FROM donor_collections')) return [data.collections.filter(row => row.request_id === values[0] && row.donor_id === values[1])];
  if (sql.startsWith('SELECT donor_id, blood_group')) return [data.donors.filter(row => row.donor_id === values[0]).map(row => ({ ...row }))];
  if (sql.startsWith('SELECT donor_id, collecting_bank_id FROM donor_responses')) {
    return [data.responses.filter(row => row.request_id === values[0] && row.response === values[1]).map(row => ({
      donor_id: row.donor_id, collecting_bank_id: row.collecting_bank_id,
    }))];
  }
  if (sql.startsWith('SELECT response, collecting_bank_id')) return [data.responses.filter(row => row.request_id === values[0] && row.donor_id === values[1]).map(row => ({ ...row }))];
  if (sql.startsWith('SELECT inventory_id, bank_id')) {
    assert.ok(sql.endsWith('FOR UPDATE'));
    return [data.stock.filter(row => row.bank_id === values[0] && row.blood_group === values[1]).map(row => ({ ...row }))];
  }
  if (sql.startsWith('UPDATE blood_inventory SET units_available = units_available -')) {
    const row = data.stock.find(row => row.inventory_id === values[1] && row.bank_id === values[2]);
    if (!row || row.units_available < values[3]) return [{ affectedRows: 0 }];
    row.units_available -= values[0]; row.version++; return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('UPDATE blood_inventory SET units_available = units_available +')) {
    const row = data.stock.find(row => row.inventory_id === values[1] && row.bank_id === values[2]);
    if (!row) return [{ affectedRows: 0 }];
    row.units_available += values[0]; row.version++; return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('INSERT INTO blood_inventory')) {
    const id = data.nextInventory++;
    data.stock.push({ inventory_id: id, bank_id: values[0], blood_group: values[1], units_available: values[2], version: 0 });
    return [{ insertId: id }];
  }
  if (sql.startsWith('INSERT INTO request_allocations')) {
    const inventory = sql.includes('VALUES (?, NULL, ?, ?, ?, ?)');
    const row = { allocation_id: data.nextAllocation++, request_id: values[0],
      donation_id: inventory ? null : values[1], inventory_id: inventory ? values[1] : null,
      units_allocated: values[2], operation_key: values[3], actor_bank_id: values[4], collection_id: inventory ? null : values[5] };
    assert.ok(!data.allocations.some(item => item.request_id === row.request_id && item.operation_key === row.operation_key));
    data.allocations.push(row); return [{ insertId: row.allocation_id }];
  }
  if (sql.startsWith('INSERT INTO donations')) {
    const id = data.nextDonation++;
    data.donations.push({ donation_id: id, donor_id: values[0], bank_id: values[1], blood_group: values[2], units_donated: values[3] });
    return [{ insertId: id }];
  }
  if (sql.startsWith('INSERT INTO donor_collections')) {
    assert.ok(!data.collections.some(row => row.request_id === values[0] && (row.donor_id === values[1] || row.operation_key === values[7])));
    const row = { collection_id: data.nextCollection++, request_id: values[0], donor_id: values[1], bank_id: values[2],
      donation_id: values[3], accounting_path: values[4], inventory_id: values[5], units_collected: values[6], operation_key: values[7] };
    data.collections.push(row); return [{ insertId: row.collection_id }];
  }
  if (sql.startsWith('UPDATE donors SET last_donation')) {
    data.donors.find(row => row.donor_id === values[0]).last_donation = 'recorded-current-date';
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('UPDATE donor_responses SET screening_result')) {
    const row = data.responses.find(item => item.request_id === values[2] && item.donor_id === values[3] && item.collecting_bank_id === values[4]);
    assert.ok(row); Object.assign(row, { screening_result: values[0], screened_by_organization_id: values[1] });
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('UPDATE blood_requests SET status')) {
    data.requests.find(row => row.request_id === values[1]).status = values[0]; return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('UPDATE blood_requests SET donor_matching')) {
    data.requests.find(row => row.request_id === values[0]).donor_matching_started_at ||= 'recorded-current-timestamp';
    return [{ affectedRows: 1 }];
  }
  if (sql.startsWith('SELECT d.donor_id, d.name')) {
    const rows = data.donors.filter(row => row.blood_group === values[1] && row.is_available === 1).map(row => {
      const response = data.responses.find(item => item.request_id === values[0] && item.donor_id === row.donor_id);
      return { ...row, response: response?.response || null, screening_result: response?.screening_result || null };
    }).filter(row => (!row.response || row.response === 'Accepted') && row.screening_result !== 'Failed');
    return [rows];
  }
  if (sql.startsWith('SELECT b.bank_id, o.organization_id, o.state')) return [data.providers.filter(row => row.organization_type === 'Blood Bank')];
  if (sql.startsWith('INSERT INTO workflow_notifications')) {
    let row = data.notifications.find(item => item.type === values[0] && item.id === values[1] && item.event === values[3]);
    if (!row) { row = { notification_id: data.notifications.length + 1, type: values[0], id: values[1], request: values[2], event: values[3], message: values[4] }; data.notifications.push(row); }
    return [{ insertId: row.notification_id }];
  }
  throw new Error('Unexpected mocked clinical SQL: ' + sql);
}

before(() => {
  process.env.LIFESAVER_WORKFLOW_V2 = 'true';
  pool.execute = pool.query = async () => { throw new Error('Real database access is prohibited.'); };
  pool.getConnection = async () => {
    let working, unlock;
    return {
      // Mock serialization tests invariants; it is not a real InnoDB lock test.
      beginTransaction: async () => {
        const previous = tail; tail = new Promise(resolve => { unlock = resolve; }); await previous;
        working = structuredClone(state); events.push({ kind: 'begin' });
      },
      execute: async (sql, values) => { if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') { events.push({ sql }); return [{}]; } assert.ok(working); return execute(working, sql, values); },
      query: async () => { throw new Error('Raw queries are disabled.'); },
      commit: async () => { state = working; working = null; events.push({ kind: 'commit' }); unlock(); unlock = null; },
      rollback: async () => { working = null; events.push({ kind: 'rollback' }); if (unlock) unlock(); unlock = null;
        if (rollbackFails) throw new Error('Private rollback failure'); },
      release: () => events.push({ kind: 'release' }),
      destroy: () => { working = null; if (unlock) unlock(); unlock = null; events.push({ kind: 'destroy' }); },
    };
  };
});
beforeEach(() => { state = fixture(); events = []; tail = Promise.resolve(); failure = null; rollbackFails = false;
  process.env.LIFESAVER_WORKFLOW_V2 = 'true'; });
after(async () => {
  pool.execute = original.execute; pool.query = original.query; pool.getConnection = original.getConnection;
  if (original.enabled === undefined) delete process.env.LIFESAVER_WORKFLOW_V2; else process.env.LIFESAVER_WORKFLOW_V2 = original.enabled;
  await pool.end();
});
const run = (action, body = {}, user = bank(20), id = 1) => runAction(user, id, action, body);
const reject = (action, body, status, user, id) => assert.rejects(run(action, body, user, id), error => error.status === status);

async function cancelFixture() {
  // Cancellation lock ordering is simulated here; no live database is used.
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[request]] = await connection.execute('SELECT * FROM blood_requests WHERE request_id = ? FOR UPDATE', [1]);
    assert.ok(['Pending', 'Processing'].includes(request.status));
    await connection.execute('UPDATE blood_requests SET status = ? WHERE request_id = ?', ['Cancelled', 1]);
    await connection.commit();
  } finally { connection.release(); }
}

test('city banks contribute own inventory against one global remaining count', async () => {
  const first = await run('allocate', keyBody());
  assert.equal(first.allocated_units, 3); assert.equal(first.remaining_units, 4);
  const second = await run('allocate', keyBody(), bank(30));
  assert.equal(second.allocated_units, 4); assert.equal(second.status, 'Fulfilled');
  assert.deepEqual(state.stock.map(row => row.units_available), [0, 1, 100, 100]);
  assert.deepEqual(state.allocations.map(row => row.actor_bank_id), [2, 3]); assert.equal(state.donations.length, 0);
});
test('provider resolution occurs inside the locked request transaction', async () => {
  await run('allocate', keyBody());
  const lock = events.findIndex(event => event.sql?.startsWith('SELECT * FROM blood_requests'));
  const provider = events.findIndex(event => event.sql?.startsWith('SELECT o.organization_id'));
  assert.ok(events.findIndex(event => event.kind === 'begin') < lock && lock < provider);
  assert.ok(events[provider].sql.endsWith('FOR SHARE'));
});
test('legacy bank JWT uses its resolved own bank, not the account numeric ID as organization ID', async () => {
  const result = await run('allocate', keyBody(), { user_type: 'blood_bank', user_id: 3 });
  assert.equal(result.bank_id, 3); assert.equal(result.organization_id, 30);
});
test('simulated concurrent different banks cannot overallocate one request', async () => {
  const results = await Promise.all([run('allocate', keyBody()), run('allocate', keyBody(), bank(30))]);
  assert.equal(results.reduce((sum, row) => sum + row.allocated_units, 0), 7);
  assert.ok(state.stock.every(row => row.units_available >= 0));
});
test('simulated inventory allocation racing collection preserves combined cap', async () => {
  state.requests[0].units_required = 4;
  const results = await Promise.allSettled([run('collect', collectionBody()), run('allocate', keyBody())]);
  assert.ok(results.every(result => result.status === 'fulfilled'));
  assert.equal(state.allocations.reduce((sum, row) => sum + row.units_allocated, 0), 4);
  assert.equal(state.stock[0].units_available, 1); assert.equal(state.donations.length, 1);
});
for (const action of ['allocate', 'collect']) {
  test('simulated cancellation winning lock blocks new ' + action, async () => {
    const body = action === 'allocate' ? keyBody() : collectionBody();
    const results = await Promise.allSettled([cancelFixture(), run(action, body)]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.status, 409); assert.equal(state.requests[0].status, 'Cancelled');
    assert.equal(state.allocations.length, 0); assert.equal(state.donations.length, 0); assert.equal(state.stock[0].units_available, 3);
  });
  test('simulated ' + action + ' winning lock keeps genuine history when cancellation follows', async () => {
    const body = action === 'allocate' ? keyBody() : collectionBody();
    const first = run(action, body);
    // Setup query ke baad actual request lock ka wait karo, sirf invocation order ka nahi.
    for (let tries = 0; tries < 20 && !events.some(event => event.sql?.startsWith('SELECT * FROM blood_requests')); tries++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(events.some(event => event.sql?.startsWith('SELECT * FROM blood_requests')));
    const results = await Promise.allSettled([first, cancelFixture()]);
    assert.ok(results.every(result => result.status === 'fulfilled')); assert.equal(state.requests[0].status, 'Cancelled');
    assert.equal(state.allocations.length, 1); assert.equal(state.stock[0].units_available, action === 'allocate' ? 0 : 3);
    const beforeRetry = structuredClone(state); await run(action, body); assert.deepEqual(state, beforeRetry);
  });
}
test('inventory retry after fulfillment returns recorded result without another deduction', async () => {
  state.requests[0].units_required = 3; const body = keyBody();
  const first = await run('allocate', body); const beforeRetry = structuredClone(state);
  const second = await run('allocate', body);
  assert.equal(first.allocation_id, second.allocation_id); assert.equal(second.remaining_units, 0); assert.deepEqual(state, beforeRetry);
});
test('another bank cannot replay the first bank operation key', async () => {
  const body = keyBody(); await run('allocate', body); const beforeAttempt = structuredClone(state);
  await reject('allocate', body, 409, bank(30)); assert.deepEqual(state, beforeAttempt);
});
for (const [id, title] of [[40, 'other city'], [90, 'admission Hospital'], [91, 'NGO'], [999, 'missing provider']]) {
  for (const action of ['allocate', 'match', 'screen', 'collect']) test(title + ' cannot perform ' + action, async () => {
    const beforeAttempt = structuredClone(state);
    const body = action === 'allocate' ? keyBody() : action === 'screen' ? screenBody('Passed') : action === 'collect' ? collectionBody() : {};
    await reject(action, body, 403, bank(id)); assert.deepEqual(state, beforeAttempt);
  });
}
for (const type of ['recipient', 'donor', 'admin']) test(type + ' cannot reach clinical execution', async () => {
  await reject('match', {}, 403, { user_type: type, user_id: 20 }); assert.equal(events.length, 0);
});
test('disabled feature fails before connecting', async () => {
  process.env.LIFESAVER_WORKFLOW_V2 = 'false'; await reject('match', {}, 503); assert.equal(events.length, 0);
});
test('legacy requests are not converted or processed', async () => {
  state.requests[0].workflow_version = 1; const initial = structuredClone(state);
  await reject('allocate', keyBody(), 409); assert.deepEqual(state, initial);
});
test('missing request returns safe404', async () => { await reject('match', {}, 404, bank(20), 999); });
for (const status of ['Fulfilled', 'Cancelled']) test(status + ' prevents new collection, screening, matching and stock use', async () => {
  state.requests[0].status = status; const initial = structuredClone(state);
  for (const [action, body] of [['allocate', keyBody()], ['collect', collectionBody()], ['screen', screenBody('Passed')], ['match', {}]]) await reject(action, body, 409);
  assert.deepEqual(state, initial);
});
test('zero own stock automatically starts fallback for uncovered city demand without consuming a key', async () => {
  state.stock[0].units_available = 0; state.responses = [];
  const result = await run('allocate', keyBody());
  assert.equal(result.allocated_units, 0); assert.equal(result.donor_units_needed, 2);
  assert.ok(state.requests[0].donor_matching_started_at); assert.equal(state.allocations.length, 0);
  assert.equal(state.notifications.filter(row => row.type === 'donor').length, 1);
});
test('wrong blood-group stock is never used as a substitute', async () => {
  state.stock = state.stock.filter(row => row.bank_id !== 2 || row.blood_group !== 'O+');
  const stock = structuredClone(state.stock); const result = await run('allocate', keyBody());
  assert.equal(result.allocated_units, 0); assert.equal(result.donor_units_needed, 2); assert.deepEqual(state.stock, stock);
});
for (const units of [-1, 1.5, '3']) test('corrupt own inventory quantity is rejected: ' + units, async () => {
  state.stock[0].units_available = units; await reject('allocate', keyBody(), 409);
});
test('a fresh key cannot record the same physical donor collection twice', async () => {
  await run('collect', collectionBody()); const initial = structuredClone(state);
  await reject('collect', collectionBody(), 409); assert.deepEqual(state, initial);
});
test('DirectRequest collection creates actual donation and allocation but never adds stock', async () => {
  const oldStock = structuredClone(state.stock); const result = await run('collect', collectionBody());
  assert.equal(result.fulfilled_units, 2); assert.equal(result.accounting_path, 'DirectRequest');
  assert.deepEqual(state.stock, oldStock); assert.equal(state.donations.length, 1); assert.equal(state.collections.length, 1);
  assert.equal(state.allocations[0].collection_id, state.collections[0].collection_id);
});
test('Inventory collection increases only own stock and does not fulfill request', async () => {
  const result = await run('collect', collectionBody({ accounting_path: 'Inventory' }));
  assert.equal(result.fulfilled_units, 0); assert.equal(result.allocated_units, 0); assert.equal(result.status, 'Pending');
  assert.equal(state.stock[0].units_available, 5); assert.equal(state.stock[0].version, 1);
  assert.equal(state.stock[1].units_available, 5); assert.equal(state.allocations.length, 0);
  assert.equal(state.collections[0].accounting_path, 'Inventory'); assert.equal(state.donations.length, 1);
});
test('Inventory path can create missing own stock without creating an allocation', async () => {
  state.stock = state.stock.filter(row => row.bank_id !== 2 || row.blood_group !== 'O+');
  await run('collect', collectionBody({ accounting_path: 'Inventory' }));
  assert.equal(state.stock.find(row => row.bank_id === 2 && row.blood_group === 'O+').units_available, 2);
  assert.equal(state.allocations.length, 0);
});
test('Inventory collection quantity does not create direct credit above request remaining', async () => {
  state.requests[0].units_required = 1;
  const result = await run('collect', collectionBody({ accounting_path: 'Inventory', units_donated: 2 }));
  assert.equal(result.fulfilled_units, 0); assert.equal(result.remaining_units, 1);
  assert.equal(state.collections[0].units_collected, 2); assert.equal(state.allocations.length, 0);
});
test('inventory collection then multi-bank inventory fulfillment counts the donated blood once', async () => {
  await run('collect', collectionBody({ accounting_path: 'Inventory' }));
  await run('allocate', keyBody()); const final = await run('allocate', keyBody(), bank(30));
  assert.equal(final.fulfilled_units, 7); assert.equal(final.inventory_units, 7); assert.equal(final.donation_units, 0);
  assert.equal(state.donations.length, 1); assert.equal(state.collections.length, 1);
  assert.ok(state.allocations.every(row => row.donation_id === null));
  assert.deepEqual(state.stock.map(row => row.units_available), [0, 3, 100, 100]);
});
test('fresh key cannot convert an Inventory collection into a second DirectRequest collection', async () => {
  await run('collect', collectionBody({ accounting_path: 'Inventory' })); const beforeAttempt = structuredClone(state);
  await reject('collect', collectionBody(), 409); assert.deepEqual(state, beforeAttempt);
});
for (const path of ['DirectRequest', 'Inventory']) test(path + ' collection retry is durable and single-accounted', async () => {
  const body = collectionBody({ accounting_path: path }); await run('collect', body); const beforeRetry = structuredClone(state);
  const repeated = await run('collect', body); assert.equal(repeated.collection_id, 1); assert.deepEqual(state, beforeRetry);
});
test('collection key cannot be changed from direct accounting to inventory', async () => {
  const body = collectionBody(); await run('collect', body); const initial = structuredClone(state);
  await reject('collect', { ...body, accounting_path: 'Inventory' }, 409); assert.deepEqual(state, initial);
});
test('collection key cannot be reused by another bank or allocation action', async () => {
  const body = collectionBody(); await run('collect', body); const initial = structuredClone(state);
  await reject('collect', body, 409, bank(30)); await reject('allocate', { operation_key: body.operation_key }, 409);
  assert.deepEqual(state, initial);
});
test('same collection key with different donor or units is rejected without extra records', async () => {
  const body = collectionBody(); await run('collect', body); const beforeAttempt = structuredClone(state);
  await reject('collect', { ...body, donor_id: 11 }, 409);
  await reject('collect', { ...body, units_donated: 1 }, 409); assert.deepEqual(state, beforeAttempt);
});
test('allocation key cannot be reused for collection', async () => {
  const body = keyBody(); await run('allocate', body); await reject('collect', collectionBody(body), 409);
});
test('collection cannot exceed global remaining even when stock is ample', async () => {
  await run('allocate', keyBody()); await reject('collect', collectionBody({ units_donated: 5 }), 409);
  assert.equal(state.donations.length, 0);
});
test('only designated collecting bank can screen or collect', async () => {
  await reject('screen', screenBody('Passed'), 403, bank(30)); await reject('collect', collectionBody(), 403, bank(30));
  assert.equal(state.donations.length, 0);
});

test('relocated designated bank can screen but cannot allocate inventory or start city matching', async () => {
  state.providers[0].city = 'Mumbai'; state.responses[0].screening_result = null;
  state.responses[0].screened_by_organization_id = null;
  await reject('allocate', keyBody(), 403); await reject('match', {}, 403);
  await run('screen', screenBody('Passed'));
  assert.equal(state.responses[0].screening_result, 'Passed');
  assert.equal(state.responses[0].screened_by_organization_id, 20);
  assert.equal(state.donations.length, 0); assert.equal(state.allocations.length, 0);
});
for (const path of ['DirectRequest', 'Inventory']) test('relocated designated bank records only genuine ' + path + ' collection and safe replay', async () => {
  state.providers[0].city = 'Mumbai'; const body = collectionBody({ accounting_path: path });
  const result = await run('collect', body);
  assert.equal(result.allocated_units, path === 'DirectRequest' ? 2 : 0);
  assert.equal(state.collections[0].bank_id, 2); assert.equal(state.donations[0].bank_id, 2);
  const recorded = structuredClone(state); await run('collect', body); assert.deepEqual(state, recorded);
  await reject('collect', collectionBody({ accounting_path: path }), 409);
});
test('relocation does not authorize a different city bank to screen or collect assigned donors', async () => {
  state.providers[0].city = 'Mumbai';
  for (const user of [bank(30), bank(40), bank(90), bank(91)]) {
    await reject('screen', screenBody('Passed'), 403, user);
    await reject('collect', collectionBody(), 403, user);
  }
  assert.equal(state.donations.length, 0);
});
for (const status of ['Cancelled', 'Fulfilled']) test('relocated collector cannot start screening or a new donation after ' + status, async () => {
  state.providers[0].city = 'Mumbai'; state.requests[0].status = status;
  await reject('screen', screenBody('Passed'), 409); await reject('collect', collectionBody(), 409);
  assert.equal(state.collections.length, 0);
});
for (const value of [null, 'Failed']) test('collection requires Passed screening: ' + value, async () => {
  state.responses[0].screening_result = value; await reject('collect', collectionBody(), 409);
});
test('another organization screening cannot authorize collection', async () => {
  state.responses[0].screened_by_organization_id = 30; await reject('collect', collectionBody(), 409);
});
test('different donor group and unaccepted response cannot collect', async () => {
  state.donors[0].blood_group = 'A+'; await reject('collect', collectionBody(), 409);
  state.donors[0].blood_group = 'O+'; state.responses[0].response = 'Declined'; await reject('collect', collectionBody(), 409);
});
test('screening is immutable, replay-safe and creates no donation or allocation', async () => {
  state.responses[0].screening_result = null; state.responses[0].screened_by_organization_id = null;
  await run('screen', screenBody('Passed')); const initial = structuredClone(state);
  await run('screen', screenBody('Passed')); assert.deepEqual(state, initial);
  await reject('screen', screenBody('Failed'), 409);
  assert.equal(state.donations.length, 0); assert.equal(state.allocations.length, 0);
});
test('Failed screening records no donated blood and cannot be changed to Passed', async () => {
  state.responses[0].screening_result = null; state.responses[0].screened_by_organization_id = null;
  await run('screen', screenBody('Failed')); await reject('screen', screenBody('Passed'), 409);
  await reject('collect', collectionBody(), 409); assert.equal(state.collections.length, 0);
});
test('donor matching uses same city, exact group and availability for uncovered city demand', async () => {
  state.responses = [];
  state.donors.push({ ...state.donors[0], donor_id: 11, city: '  PUNE ' },
    { ...state.donors[0], donor_id: 12, city: 'Mumbai' }, { ...state.donors[0], donor_id: 13, blood_group: 'A+' },
    { ...state.donors[0], donor_id: 14, is_available: 0 });
  state.stock[0].units_available = 0;
  const result = await run('match'); assert.deepEqual(result.donors.map(row => row.donor_id), [10, 11]);
  assert.ok(state.requests[0].donor_matching_started_at); assert.equal(result.allocated_units, 0);
  assert.equal(state.stock[0].units_available, 0); assert.equal(result.donor_units_needed, 2); assert.ok(!JSON.stringify(result).includes('private-phone'));
});
test('concurrent/repeated matching does not duplicate invitation event rows', async () => {
  state.responses = []; state.stock[0].units_available = 0; const results = await Promise.all([run('match'), run('match', {}, bank(30))]);
  const donorNotes = state.notifications.filter(row => row.type === 'donor');
  assert.equal(donorNotes.length, 1);
  for (const result of results) {
    assert.equal(result.matched_count, 1); assert.equal(result.notified_count, 1);
    assert.ok(Number.isInteger(result.notified_count));
  }
});
test('matching counts accepted candidates without claiming a new invitation', async () => {
  state.stock[0].units_available = 0;
  const result = await run('match'); assert.equal(result.matched_count, 1); assert.equal(result.notified_count, 0);
  assert.equal(state.notifications.filter(row => row.type === 'donor').length, 0);
});
test('screening outcome is private to recipient, Hospital, designated bank and donor', async () => {
  state.responses[0].screening_result = null; state.responses[0].screened_by_organization_id = null;
  await run('screen', screenBody('Failed'));
  assert.deepEqual(state.notifications.map(row => row.type + ':' + row.id),
    ['recipient:5', 'organization:90', 'blood_bank:2', 'donor:10']);
  assert.ok(!state.notifications.some(row => row.type === 'blood_bank' && row.id === 3));
});
test('inventory fulfillment closes every accepted donor coordination with deduplicated notifications', async () => {
  state.requests[0].units_required = 3;
  state.responses.push({ request_id: 1, donor_id: 11, response: 'Accepted', collecting_bank_id: 3,
    screening_result: null, screened_by_organization_id: null });
  const body = keyBody(); await run('allocate', body);
  const closure = state.notifications.filter(row => row.event === 'request:1:fulfilled');
  assert.deepEqual(closure.filter(row => row.type === 'donor').map(row => row.id), [10, 11]);
  assert.deepEqual(closure.filter(row => row.type === 'blood_bank').map(row => row.id), [2, 3]);
  assert.equal(closure.filter(row => row.type === 'recipient').length, 1);
  assert.equal(closure.filter(row => row.type === 'organization').length, 1);
  const beforeRetry = structuredClone(state); await run('allocate', body); assert.deepEqual(state, beforeRetry);
});
test('direct collection fulfillment closes all accepted donors, not only collected donor', async () => {
  state.requests[0].units_required = 2;
  state.responses.push({ request_id: 1, donor_id: 11, response: 'Accepted', collecting_bank_id: 3,
    screening_result: null, screened_by_organization_id: null });
  const body = collectionBody(); await run('collect', body);
  assert.deepEqual(state.notifications.filter(row => row.event === 'request:1:fulfilled' && row.type === 'donor').map(row => row.id), [10, 11]);
  const original = structuredClone(state); await run('collect', body); assert.deepEqual(state, original);
});
test('supply notifications target recipient, admission hospital and eligible banks only', async () => {
  await run('allocate', keyBody());
  assert.deepEqual(state.notifications.map(row => row.type + ':' + row.id), ['recipient:5', 'organization:90', 'blood_bank:2', 'blood_bank:3']);
  assert.ok(!JSON.stringify(state.notifications).includes('private-phone'));
});
for (const stage of ['UPDATE blood_inventory', 'INSERT INTO request_allocations', 'INSERT INTO donations', 'INSERT INTO donor_collections', 'UPDATE donors', 'INSERT INTO workflow_notifications']) {
  test('failure at ' + stage + ' rolls back complete clinical changes', async () => {
    const initial = structuredClone(state); failure = stage;
    const action = ['UPDATE blood_inventory', 'INSERT INTO request_allocations'].includes(stage) ? 'allocate' : 'collect';
    await assert.rejects(run(action, action === 'allocate' ? keyBody() : collectionBody()));
    assert.deepEqual(state, initial); assert.ok(events.some(event => event.kind === 'rollback')); assert.equal(events.at(-1).kind, 'release');
  });
}
test('failed rollback destroys the connection instead of returning it to pool', async () => {
  rollbackFails = true; failure = 'INSERT INTO request_allocations'; await assert.rejects(run('allocate', keyBody()));
  assert.equal(events.at(-1).kind, 'destroy'); assert.ok(!events.some(event => event.kind === 'release'));
});
for (const [action, body] of [['allocate', {}], ['allocate', { operation_key: 'bad' }], ['allocate', { ...keyBody(), bank_id: 3 }],
  ['collect', collectionBody({ accounting_path: 'Both' })], ['collect', collectionBody({ units_donated: 0 })],
  ['collect', collectionBody({ units_donated: 1.5 })], ['collect', collectionBody({ donor_id: '10' })],
  ['screen', screenBody('Unknown')], ['screen', { ...screenBody('Passed'), bank_id: 3 }], ['match', { status: 'Fulfilled' }],
  ['unknown', {}], ['toString', {}], ['constructor', {}], ['__proto__', {}]]) {
  test('unsupported clinical body rejected before connection: ' + action + ':' + JSON.stringify(body), async () => {
    await reject(action, body, 400); assert.equal(events.length, 0);
  });
}
