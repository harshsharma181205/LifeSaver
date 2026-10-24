// Explicit isolated MySQL test. Normal node --test glob isse nahi chalayega.
// Never point this script at an existing application database.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash, scryptSync } = require('node:crypto');
const schemaFixture = require('./fixtures/legacySchema.json');
const { migrate, assertIsolated, buildPlan } = require('../migrations/cityWideWorkflow');
const businessTables = ['request_allocations', 'donor_collections', 'workflow_notifications', 'notifications',
  'donor_responses', 'donations', 'blood_requests', 'blood_inventory', 'donors', 'recipients', 'blood_banks', 'organizations', 'admins'];
const createOrder = ['admins', 'organizations', 'blood_banks', 'donors', 'recipients', 'blood_inventory',
  'blood_requests', 'donations', 'donor_responses', 'request_allocations', 'notifications'];
let pool, server, baseUrl, cleanupAllowed = false, currentCheck = 'isolated database guard';
const passed = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function check(name, work) {
  currentCheck = name;
  await work();
  passed.push(name);
  console.log('PASS ' + name);
}
async function api(method, path, body, token, expected = 200) {
  const response = await fetch(baseUrl + path, { method, headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  assert.ok(!/password_hash|"password"\s*:/.test(JSON.stringify(data)), 'API leaked password fields');
  if (expected !== null) assert.equal(response.status, expected, method + ' ' + path);
  return { status: response.status, data };
}
async function insert(sql, values) { const [result] = await pool.execute(sql, values); return result.insertId; }

async function seedLegacy() {
  const salt = randomBytes(16).toString('hex');
  const hash = 'scrypt:' + salt + ':' + scryptSync(randomBytes(20).toString('hex'), salt, 64).toString('hex');
  const organization = await insert("INSERT INTO organizations (organization_type,name,state,city,address,phone,email,password_hash) VALUES ('Blood Bank',?,?,?,? ,?,?,?)",
    ['Isolated legacy sentinel', null, null, 'Isolated-only test address', '9000000000', 'legacy-bank@example.invalid', hash]);
  const bank = await insert('INSERT INTO blood_banks (organization_id,bank_name,address) VALUES (?,?,?)', [organization, 'Legacy sentinel bank', 'Isolated-only test address']);
  const donor = await insert("INSERT INTO donors (name,gender,blood_group,date_of_birth,phone,password_hash) VALUES (?,'Other','O+','2000-01-01',?,?)", ['Legacy sentinel donor', '9000000001', hash]);
  const recipient = await insert("INSERT INTO recipients (name,gender,blood_group,age,phone,password_hash) VALUES (?,'Other','O+',25,?,?)", ['Legacy sentinel recipient', '9000000002', hash]);
  const request = await insert("INSERT INTO blood_requests (recipient_id,bank_id,organization_id,blood_group,units_required,status) VALUES (?,?,?,'O+',1,'Fulfilled')", [recipient, bank, organization]);
  await insert("INSERT INTO blood_requests (recipient_id,bank_id,blood_group,units_required,status) VALUES (?,NULL,'O+',2,'Pending')", [recipient]);
  const donation = await insert("INSERT INTO donations (donor_id,bank_id,blood_group,units_donated) VALUES (?,?,'O+',1)", [donor, bank]);
  await insert('INSERT INTO request_allocations (request_id,donation_id,units_allocated,operation_key) VALUES (?,?,1,?)', [request, donation, randomUUID()]);
  await pool.execute("INSERT INTO donor_responses (request_id,donor_id,response,screening_result,screened_at,screened_by_organization_id) VALUES (?,?,'Accepted','Passed',CURRENT_TIMESTAMP,?)", [request, donor, organization]);
  await insert('INSERT INTO notifications (recipient_id,request_id,message) VALUES (?,?,?)', [recipient, request, 'Legacy sentinel notification']);
}
async function captureLegacy() {
  const snapshot = [];
  for (const entry of schemaFixture) {
    const [rows] = await pool.execute('SELECT * FROM `' + entry.table + '`');
    const primary = entry.sql.match(/PRIMARY KEY \(([^)]+)\)/)[1].replace(/`/g, '').split(',');
    for (const row of rows) snapshot.push({ table: entry.table, primary,
      ids: primary.map(name => row[name]), columns: Object.keys(row), hash: createHash('sha256').update(JSON.stringify(row)).digest('hex') });
  }
  return snapshot;
}
async function assertLegacy(snapshot) {
  for (const entry of snapshot) {
    const [rows] = await pool.execute('SELECT ' + entry.columns.map(name => '`' + name + '`').join(',') + ' FROM `' + entry.table + '` WHERE ' + entry.primary.map(name => '`' + name + '` = ?').join(' AND '), entry.ids);
    assert.equal(rows.length, 1, 'Legacy sentinel disappeared');
    assert.equal(createHash('sha256').update(JSON.stringify(rows[0])).digest('hex'), entry.hash, 'Legacy sentinel changed');
  }
}
async function cleanTestRows() {
  if (!cleanupAllowed || !pool) return;
  await assertIsolated(pool, { confirmIsolated: true });
  const connection = await pool.getConnection();
  try {
    const [existing] = await connection.execute('SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    const tables = new Set(existing.map(row => row.TABLE_NAME));
    await connection.beginTransaction();
    for (const table of businessTables) if (tables.has(table)) await connection.execute('DELETE FROM `' + table + '`');
    await connection.commit();
    for (const table of businessTables) if (tables.has(table)) {
      const [rows] = await connection.execute('SELECT COUNT(*) AS total FROM `' + table + '`');
      assert.equal(Number(rows[0].total), 0, 'Isolated cleanup incomplete');
    }
    console.log('CLEANUP verified: zero synthetic business rows. Isolated schema/version marker retained.');
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function main() {
  process.env.DOTENV_QUIET = 'true';
  require('dotenv').config({ quiet: true });
  if (process.env.LIFESAVER_ISOLATED_TEST_DB !== 'true' || !/^lifesaver_v2_test_[a-z0-9_]+$/i.test(process.env.DB_NAME || '')) {
    throw new Error('Set explicit LIFESAVER_ISOLATED_TEST_DB=true and DB_NAME=lifesaver_v2_test_* for an isolated database with no business rows.');
  }
  // Guard se pehle connection/module import bhi nahi hota.
  pool = require('../db');
  await assertIsolated(pool, { confirmIsolated: true });
  const [existing] = await pool.execute('SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  if (existing.length) {
    // Sirf verified empty V2 test schema reuse hoga; koi table drop nahi hogi.
    assert.deepEqual(existing.map(row => row.TABLE_NAME).sort(), [...businessTables, 'workflow_schema_versions'].sort());
    assert.equal((await buildPlan(pool)).steps.length, 0, 'Existing isolated schema must already be fully migrated.');
    for (const table of businessTables) {
      const [[row]] = await pool.execute('SELECT COUNT(*) AS total FROM `' + table + '`');
      assert.equal(Number(row.total), 0, 'Existing business rows will never be erased to start a test.');
    }
  }
  cleanupAllowed = true;
  if (!existing.length) for (const table of createOrder) await pool.execute(schemaFixture.find(entry => entry.table === table).sql);
  await seedLegacy();
  const legacy = await captureLegacy();
  await check('real additive migration preserves all pre-migration sentinel values', async () => {
    await migrate(pool, { confirmIsolated: true }); await assertLegacy(legacy);
  });
  await check('migration is repeatable and remains inactive until explicit runtime flag', async () => {
    const repeated = await migrate(pool, { confirmIsolated: true });
    assert.equal(repeated.changes.length, 0); assert.equal(repeated.activated, false);
  });
  process.env.LIFESAVER_WORKFLOW_V2 = 'true';
  process.env.JWT_SECRET = randomBytes(48).toString('hex');
  process.env.JWT_EXPIRES_IN = '15m';
  const express = require('express');
  const app = express(); app.use(express.json());
  for (const [prefix, route] of [['auth','auth'], ['organizations','organization'], ['donors','donor'], ['recipients','recipient'],
    ['requests','request'], ['inventory','inventory'], ['allocations','allocation'], ['screenings','screening'], ['donations','donation'], ['notifications','notification']]) {
    app.use('/api/' + prefix, require('../routes/' + route + 'Routes'));
  }
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  const password = randomBytes(20).toString('hex');
  const state = 'Uttarakhand', city = 'Dehradun';
  let phone = 9100000000;
  async function account(role, extra = {}) {
    const input = { name: 'Isolated ' + role + ' ' + phone, phone: String(phone++), password,
      email: 'isolated-' + phone + '@example.invalid', ...extra };
    const path = role === 'organization' ? '/api/organizations' : '/api/' + role + 's';
    const created = (await api('POST', path, input, null, 201)).data;
    const login = (await api('POST', '/api/auth/' + role + '/login', { phone: input.phone, password }, null)).data;
    assert.equal(typeof login.token, 'string');
    return { ...created.organization, ...created, id: created[role + '_id'], token: login.token };
  }
  const organization = (type, extra = {}) => account('organization', { organization_type: type, state, city, address: 'Isolated-only test address', ...extra });
  const hospital = await organization('Hospital');
  const bankA = await organization('Blood Bank', { });
  const bankB = await organization('Blood Bank', { });
  const otherCity = await organization('Blood Bank', { city: 'Haridwar' });
  const ngo = await organization('NGO');
  const recipient = await account('recipient', { gender: 'Other', blood_group: 'A+', age: 25 });
  const donor = await account('donor', { gender: 'Other', blood_group: 'A+', date_of_birth: '2000-01-01', state, city, is_available: true });
  async function create(units = 5, group = 'A+', overrides = {}) {
    return (await api('POST', '/api/requests', { admission_hospital_id: hospital.organization_id, state, city, blood_group: group, units_required: units, urgency_level: 'Emergency', ...overrides }, recipient.token, 201)).data.request_id;
  }
  const requestId = await create();
  await check('new Hospital has no Blood Bank companion and receives admission notifications', async () => {
    assert.equal(hospital.bank_id, null);
    assert.ok((await api('GET', '/api/notifications/me', undefined, hospital.token)).data.notifications.length > 0);
  });
  await check('admission Hospital is not an inventory or collection provider', async () => {
    await api('POST', '/api/allocations/process/' + requestId, { operation_key: randomUUID() }, hospital.token, 403);
    await api('GET', '/api/inventory/' + bankA.bank_id, undefined, hospital.token, 403);
  });
  await check('Bank and NGO cannot be admission Hospitals; arbitrary owner fields rejected', async () => {
    for (const admission_hospital_id of [bankA.organization_id, ngo.organization_id]) await api('POST', '/api/requests', {
      admission_hospital_id, state, city, blood_group: 'A+', units_required: 1 }, recipient.token, 400);
    await api('POST', '/api/requests', { admission_hospital_id: hospital.organization_id, state, city, blood_group: 'A+', units_required: 1, bank_id: bankA.bank_id }, recipient.token, 400);
  });
  await check('same-city banks see city-wide request ; another city and NGO cannot', async () => {
    for (const bank of [bankA, bankB]) assert.ok((await api('GET', '/api/requests', undefined, bank.token)).data.requests.some(row => row.request_id === requestId));
    await api('GET', '/api/requests/' + requestId, undefined, otherCity.token, 404);
    await api('GET', '/api/requests', undefined, ngo.token, 403);
  });
  await check('newly registered bank discovers preexisting open city requests', async () => {
    const laterBank = await organization('Blood Bank');
    assert.ok((await api('GET', '/api/requests', undefined, laterBank.token)).data.requests.some(row => row.request_id === requestId));
  });
  await check('bank queue is city-wide with priority FCFS', async () => {
    const normalId = await create(1, 'A+', { urgency_level: 'Normal' });
    const data = (await api('GET', '/api/requests/provider-queue', undefined, bankB.token)).data;
    assert.ok(data.queue.findIndex(row => row.request_id === requestId) < data.queue.findIndex(row => row.request_id === normalId));
  });
  await pool.execute("INSERT INTO blood_inventory (bank_id,blood_group,units_available) VALUES (?,'A+',2),(?,'A+',1)", [bankA.bank_id, bankB.bank_id]);
  let allocationKey;
  await check('two banks contribute their OWN inventory toward one request', async () => {
    allocationKey = randomUUID();
    const a = await api('POST', '/api/allocations/process/' + requestId, { operation_key: allocationKey }, bankA.token);
    const b = await api('POST', '/api/allocations/process/' + requestId, { operation_key: randomUUID() }, bankB.token);
    assert.equal(a.data.allocated_units, 2); assert.equal(b.data.allocated_units, 1); assert.equal(b.data.remaining_units, 2);
  });
  await check('same-key replay idempotent and another bank cannot replay it as its own', async () => {
    const replay = await api('POST', '/api/allocations/process/' + requestId, { operation_key: allocationKey }, bankA.token);
    assert.equal(replay.data.allocated_units, 2);
    await api('POST', '/api/allocations/process/' + requestId, { operation_key: allocationKey }, bankB.token, 409);
  });
  await check('matching, explicit collector and screening create no fulfillment units', async () => {
    await api('POST', '/api/allocations/match/' + requestId, {}, bankA.token);
    await api('POST', '/api/donors/me/requests/' + requestId + '/response', { response: 'Accepted', collecting_bank_id: bankB.bank_id }, donor.token, 201);
    await api('POST', '/api/screenings/' + requestId, { donor_id: donor.donor_id, result: 'Passed' }, bankA.token, 403);
    await api('POST', '/api/screenings/' + requestId, { donor_id: donor.donor_id, result: 'Passed' }, bankB.token);
    assert.equal((await api('GET', '/api/requests/' + requestId, undefined, recipient.token)).data.request.fulfilled_units, 3);
  });
  await check('real direct collection completes global progress and cannot be duplicated by a fresh key', async () => {
    const key = randomUUID(), body = { donor_id: donor.donor_id, units_donated: 2, operation_key: key, accounting_path: 'DirectRequest' };
    const original = await api('POST', '/api/donations/' + requestId, body, bankB.token);
    assert.equal(original.data.status, 'Fulfilled'); assert.equal(original.data.remaining_units, 0);
    await api('POST', '/api/donations/' + requestId, body, bankB.token);
    await api('POST', '/api/donations/' + requestId, { ...body, operation_key: randomUUID() }, bankB.token, 409);
    const [rows] = await pool.execute('SELECT COUNT(*) AS total FROM donor_collections WHERE request_id = ? AND donor_id = ?', [requestId, donor.donor_id]);
    assert.equal(Number(rows[0].total), 1);
  });
  await check('actual MySQL row lock blocks second connection until holder commits', async () => {
    const holder = await pool.getConnection(), waiter = await pool.getConnection();
    let pending, settled = false;
    try {
      await holder.beginTransaction(); await waiter.beginTransaction();
      await holder.execute('SELECT request_id FROM blood_requests WHERE request_id = ? FOR UPDATE', [requestId]);
      await waiter.execute('SET SESSION innodb_lock_wait_timeout = 5');
      pending = waiter.execute('SELECT request_id FROM blood_requests WHERE request_id = ? FOR UPDATE', [requestId]);
      pending.then(() => { settled = true; }, () => { settled = true; });
      await delay(200); assert.equal(settled, false, 'Contending query did not wait for holder');
      await holder.commit(); await pending; assert.equal(settled, true); await waiter.commit();
    } finally {
      await holder.rollback();
      if (pending) await pending.catch(() => {});
      await waiter.rollback(); holder.release(); waiter.release();
    }
  });
  await check('concurrent banks cannot exceed final one-unit remaining demand', async () => {
    const id = await create(1, 'B+');
    await pool.execute("INSERT INTO blood_inventory (bank_id,blood_group,units_available) VALUES (?,'B+',1),(?,'B+',1)", [bankA.bank_id, bankB.bank_id]);
    const results = await Promise.all([bankA, bankB].map(bank => api('POST', '/api/allocations/process/' + id, { operation_key: randomUUID() }, bank.token, null)));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const progress = (await api('GET', '/api/requests/' + id, undefined, recipient.token)).data.request;
    assert.equal(progress.fulfilled_units, 1); assert.equal(progress.remaining_units, 0);
  });
  await check('two requests competing for same bank stock cannot make inventory negative', async () => {
    await pool.execute("INSERT INTO blood_inventory (bank_id,blood_group,units_available) VALUES (?,'AB+',1)", [bankA.bank_id]);
    const ids = [await create(1, 'AB+'), await create(1, 'AB+')];
    const results = await Promise.all(ids.map(id => api('POST', '/api/allocations/process/' + id, { operation_key: randomUUID() }, bankA.token, null)));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 200]);
    assert.equal(results.reduce((total,result) => total + result.data.allocated_units, 0), 1);
    assert.ok(results.some(result => result.data.allocated_units === 0 && result.data.donor_units_needed === 1));
    const [rows] = await pool.execute("SELECT units_available FROM blood_inventory WHERE bank_id = ? AND blood_group = 'AB+'", [bankA.bank_id]);
    assert.equal(rows[0].units_available, 0);
  });
  await check('inventory collection is not direct credit and cannot be credited through a second collection path', async () => {
    const secondDonor = await account('donor', { gender: 'Other', blood_group: 'A+', date_of_birth: '2000-01-01', state, city, is_available: true });
    const id = await create(2);
    await api('POST', '/api/allocations/match/' + id, {}, bankA.token);
    await api('POST', '/api/donors/me/requests/' + id + '/response', { response: 'Accepted', collecting_bank_id: bankA.bank_id }, secondDonor.token, 201);
    await api('POST', '/api/screenings/' + id, { donor_id: secondDonor.donor_id, result: 'Passed' }, bankA.token);
    const body = { donor_id: secondDonor.donor_id, units_donated: 2, operation_key: randomUUID(), accounting_path: 'Inventory' };
    const result = await api('POST', '/api/donations/' + id, body, bankA.token);
    assert.equal(result.data.allocated_units, 0); assert.equal(result.data.fulfilled_units, 0);
    await api('POST', '/api/donations/' + id, { ...body, operation_key: randomUUID(), accounting_path: 'DirectRequest' }, bankA.token, 409);
    const allocated = await api('POST', '/api/allocations/process/' + id, { operation_key: randomUUID() }, bankA.token);
    assert.equal(allocated.data.allocated_units, 2); assert.equal(allocated.data.fulfilled_units, 2);
  });
  await check('cancellation preserves contribution ledger and denies later new allocation', async () => {
    const id = await create(3, 'O-');
    await pool.execute("INSERT INTO blood_inventory (bank_id,blood_group,units_available) VALUES (?,'O-',1)", [bankA.bank_id]);
    await api('POST', '/api/allocations/process/' + id, { operation_key: randomUUID() }, bankA.token);
    await api('PATCH', '/api/requests/' + id + '/cancel', {}, recipient.token);
    const closed = (await api('GET', '/api/requests/' + id, undefined, recipient.token)).data.request;
    assert.equal(closed.status, 'Cancelled'); assert.equal(closed.fulfilled_units, 1);
    await api('POST', '/api/allocations/process/' + id, { operation_key: randomUUID() }, bankA.token, 409);
  });
  const fallbackDonor = await account('donor', { gender: 'Other', blood_group: 'O+', date_of_birth: '2000-01-01', state, city, is_available: true });
  const wrongCityDonor = await account('donor', { gender: 'Other', blood_group: 'O+', date_of_birth: '2000-01-01', state, city: 'Haridwar', is_available: true });
  const unavailableDonor = await account('donor', { gender: 'Other', blood_group: 'O+', date_of_birth: '2000-01-01', state, city, is_available: false });
  async function stock(bank, units) {
    await pool.execute("INSERT INTO blood_inventory (bank_id,blood_group,units_available) VALUES (?,'O+',?) ON DUPLICATE KEY UPDATE units_available = ?, version = version + 1", [bank.bank_id, units, units]);
  }
  const fallbackNotes = async id => (await pool.execute("SELECT notification_id,audience_id FROM workflow_notifications WHERE request_id = ? AND audience_type = 'donor' AND event_key LIKE ?", [id, 'request:' + id + ':match-donor:%']))[0];
  const opportunity = async id => (await api('GET','/api/donors/me/matching-requests',undefined,fallbackDonor.token)).data.requests.find(row=>row.request_id===id);
  let zeroRequest, partialRequest, coveredRequest;
  await check('zero-stock creation automatically opens donor fallback without manual matching', async () => {
    zeroRequest = await create(2,'O+');
    const row = await opportunity(zeroRequest); assert.equal(row.donor_units_needed,2); assert.equal(row.remaining_units,2);
    assert.deepEqual((await fallbackNotes(zeroRequest)).map(row=>row.audience_id),[fallbackDonor.donor_id]);
    assert.ok((await api('GET','/api/notifications/me',undefined,fallbackDonor.token)).data.notifications.some(row=>row.request_id===zeroRequest));
  });
  await check('automatic fallback excludes unavailable, incompatible and other-city donors', async () => {
    for(const person of [wrongCityDonor,unavailableDonor,donor]) {
      const notes=(await api('GET','/api/notifications/me',undefined,person.token)).data.notifications;
      assert.ok(!notes.some(row=>row.request_id===zeroRequest));
    }
  });
  await check('partial combined city stock invites only for uncovered demand; other-city stock excluded', async () => {
    await stock(bankA,1); await stock(bankB,2); await stock(otherCity,100);
    partialRequest = await create(5,'O+');
    const row=await opportunity(partialRequest);assert.equal(row.donor_units_needed,2);assert.equal(row.fulfilled_units,0);assert.equal(row.remaining_units,5);
    const [[count]]=await pool.execute('SELECT COUNT(*) AS total FROM request_allocations WHERE request_id=?',[partialRequest]);assert.equal(Number(count.total),0);
  });
  await check('partial allocations recompute uncovered demand from the global ledger', async () => {
    const first=(await api('POST','/api/allocations/process/'+partialRequest,{operation_key:randomUUID()},bankA.token)).data;
    assert.equal(first.allocated_units,1);assert.equal(first.remaining_units,4);assert.equal(first.donor_units_needed,2);
    const second=(await api('POST','/api/allocations/process/'+partialRequest,{operation_key:randomUUID()},bankB.token)).data;
    assert.equal(second.allocated_units,2);assert.equal(second.remaining_units,2);assert.equal(second.donor_units_needed,2);
  });
  await check('concurrent zero-stock processing commits fallback once without consuming inventory', async () => {
    const replies=await Promise.all([bankA,bankB].map(bank=>api('POST','/api/allocations/process/'+partialRequest,{operation_key:randomUUID()},bank.token)));
    assert.ok(replies.every(r=>r.data.allocated_units===0&&r.data.donor_units_needed===2));
    assert.equal((await fallbackNotes(partialRequest)).length,1);
  });
  await check('fallback still requires explicit collecting bank and designated screening', async () => {
    await api('POST','/api/donors/me/requests/'+partialRequest+'/response',{response:'Accepted'},fallbackDonor.token,400);
    await api('POST','/api/donors/me/requests/'+partialRequest+'/response',{response:'Accepted',collecting_bank_id:bankA.bank_id},fallbackDonor.token,201);
    await api('POST','/api/screenings/'+partialRequest,{donor_id:fallbackDonor.donor_id,result:'Passed'},bankB.token,403);
    await api('POST','/api/screenings/'+partialRequest,{donor_id:fallbackDonor.donor_id,result:'Passed'},bankA.token);
    assert.equal((await opportunity(partialRequest)).remaining_units,2);
  });
  await check('real donor contribution reduces fallback units without inventing stock', async () => {
    const data=(await api('POST','/api/donations/'+partialRequest,{donor_id:fallbackDonor.donor_id,units_donated:1,operation_key:randomUUID(),accounting_path:'DirectRequest'},bankA.token)).data;
    assert.equal(data.fulfilled_units,4);assert.equal(data.remaining_units,1);assert.equal(data.donor_units_needed,1);
  });
  await check('full fulfillment stops fallback but retains accepted donor history', async () => {
    await stock(bankB,1);
    const data=(await api('POST','/api/allocations/process/'+partialRequest,{operation_key:randomUUID()},bankB.token)).data;
    assert.equal(data.status,'Fulfilled');assert.equal(data.donor_units_needed,0);
    const history=await opportunity(partialRequest);assert.equal(history.donor_response,'Accepted');assert.equal(history.remaining_units,0);assert.equal(history.donor_units_needed,0);
  });
  await check('another bank with sufficient stock prevents unnecessary fallback', async () => {
    await stock(bankA,0);await stock(bankB,4);coveredRequest=await create(3,'O+');
    const data=(await api('POST','/api/allocations/process/'+coveredRequest,{operation_key:randomUUID()},bankA.token)).data;
    assert.equal(data.allocated_units,0);assert.equal(data.donor_units_needed,0);assert.equal((await fallbackNotes(coveredRequest)).length,0);assert.equal(await opportunity(coveredRequest),undefined);
  });
  await check('restock suppresses old opportunities and rejects stale new acceptance', async () => {
    assert.equal(await opportunity(zeroRequest),undefined);
    await api('POST','/api/donors/me/requests/'+zeroRequest+'/response',{response:'Accepted',collecting_bank_id:bankA.bank_id},fallbackDonor.token,409);
  });
  await check('reconciliation recovers existing V2 requests without manual matching or V1 changes', async () => {
    await stock(bankB,0);
    const {reconcileOpenRequests}=require('../services/cityWideFallbackReconciler');
    const outcomes=await Promise.all([reconcileOpenRequests(pool),reconcileOpenRequests(pool)]);
    assert.ok(outcomes.every(result=>result.failed===0));
    assert.equal((await opportunity(coveredRequest)).donor_units_needed,3);
    assert.equal((await fallbackNotes(coveredRequest)).length,1);await assertLegacy(legacy);
  });
  await check('cancelled fallback is hidden from new donors', async () => {
    await api('PATCH','/api/requests/'+coveredRequest+'/cancel',{},recipient.token);
    assert.equal(await opportunity(coveredRequest),undefined);
    await api('POST','/api/donors/me/requests/'+coveredRequest+'/response',{response:'Accepted',collecting_bank_id:bankA.bank_id},fallbackDonor.token,409);
  });
  const collectorDonor=await account('donor',{gender:'Other',blood_group:'A-',date_of_birth:'2000-01-01',state,city,is_available:true});
  const collectorRequest=await create(2,'A-');
  let collectorBody;
  await check('accepted collecting-bank assignment survives provider relocation without granting city inventory supply',async()=>{
    await api('POST','/api/donors/me/requests/'+collectorRequest+'/response',{response:'Accepted',collecting_bank_id:bankB.bank_id},collectorDonor.token,201);
    await pool.execute('UPDATE organizations SET city=? WHERE organization_id=?',['Haridwar',bankB.organization_id]);
    const detail=(await api('GET','/api/requests/'+collectorRequest,undefined,bankB.token)).data.request;
    assert.equal(detail.can_supply,false);assert.equal(detail.accepted_donors[0].donor_id,collectorDonor.donor_id);
    await api('POST','/api/allocations/process/'+collectorRequest,{operation_key:randomUUID()},bankB.token,403);
    await api('POST','/api/allocations/match/'+collectorRequest,{},bankB.token,403);
  });
  await check('only designated collecting bank can screen accepted donor after relocation',async()=>{
    await api('POST','/api/screenings/'+collectorRequest,{donor_id:collectorDonor.donor_id,result:'Passed'},bankA.token,403);
    await api('POST','/api/screenings/'+collectorRequest,{donor_id:collectorDonor.donor_id,result:'Passed'},otherCity.token,403);
    await api('POST','/api/screenings/'+collectorRequest,{donor_id:collectorDonor.donor_id,result:'Passed'},bankB.token);
    assert.equal((await api('GET','/api/requests/'+collectorRequest,undefined,recipient.token)).data.request.fulfilled_units,0);
  });
  await check('designated collector confirms actual donation with remaining-unit and replay protection after relocation',async()=>{
    collectorBody={donor_id:collectorDonor.donor_id,units_donated:1,operation_key:randomUUID(),accounting_path:'DirectRequest'};
    await api('POST','/api/donations/'+collectorRequest,collectorBody,bankA.token,403);
    const recorded=(await api('POST','/api/donations/'+collectorRequest,collectorBody,bankB.token)).data;
    assert.equal(recorded.fulfilled_units,1);assert.equal(recorded.remaining_units,1);
    await api('POST','/api/donations/'+collectorRequest,collectorBody,bankB.token);
    await api('POST','/api/donations/'+collectorRequest,{...collectorBody,operation_key:randomUUID()},bankB.token,409);
  });
  await check('cancellation still blocks new clinical actions for designated collecting bank',async()=>{
    await api('PATCH','/api/requests/'+collectorRequest+'/cancel',{},recipient.token);
    await api('POST','/api/screenings/'+collectorRequest,{donor_id:collectorDonor.donor_id,result:'Passed'},bankB.token,409);
    await api('POST','/api/donations/'+collectorRequest,{...collectorBody,operation_key:randomUUID()},bankB.token,409);
    assert.equal((await api('GET','/api/requests/'+collectorRequest,undefined,recipient.token)).data.request.fulfilled_units,1);
  });
  await check('old records, hashes, statuses and operation keys remain unchanged after V2 activity', () => assertLegacy(legacy));
  await check('final global allocation and inventory invariants', async () => {
    const [over] = await pool.execute('SELECT r.request_id FROM blood_requests r JOIN request_allocations a ON a.request_id = r.request_id GROUP BY r.request_id,r.units_required HAVING SUM(a.units_allocated) > r.units_required');
    const [negative] = await pool.execute('SELECT inventory_id FROM blood_inventory WHERE units_available < 0');
    assert.equal(over.length, 0); assert.equal(negative.length, 0);
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error('FAIL ' + currentCheck + ' (' + (error.code || error.name || 'Error') + '). No credentials are printed.');
    process.exitCode = 1;
  }).finally(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    try { await cleanTestRows(); }
    catch (error) { console.error('Isolated cleanup needs attention (' + (error.code || error.name || 'Error') + ').'); process.exitCode = 1; }
    if (pool) await pool.end();
    console.log('Executed live checks: ' + passed.length + ' passed. This count applies only to an actual invocation.');
  });
}

module.exports = { main };
