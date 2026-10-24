const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomBytes } = require('node:crypto');
const pool = require('../db');
const config = require('../services/workflowV2Config');
const notices = require('../services/workflowV2Notifications');
const original = { execute: pool.execute, getConnection: pool.getConnection, query: pool.query, ready: config.assertReady, notify: notices.notifyRequestAudience };
const oldEnv = { LIFESAVER_WORKFLOW_V2: process.env.LIFESAVER_WORKFLOW_V2, JWT_SECRET: process.env.JWT_SECRET, JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN };
const { createToken } = require('../services/jwtService');
let server, base, rows, organizations, donors, responses, allocations, events, notifications, queries, failAt, cityStock = 0;
const hospital = { organization_id: 11, organization_type: 'Hospital', name: 'Admission Hospital', state: 'Uttarakhand', city: 'Dehradun', bank_id: null };
const bank = { organization_id: 1, bank_id: 7, organization_type: 'Blood Bank', name: 'City Bank', state: 'Uttarakhand', city: 'Dehradun', address: 'Bank collection desk' };
const request = (overrides = {}) => ({ request_id: 100, workflow_version: 2, admission_hospital_id: 11, admission_hospital_name: 'Admission Hospital', recipient_id: 4, bank_id: null, organization_id: null,
  state: 'Uttarakhand', city: 'Dehradun', blood_group: 'A+', units_required: 5, urgency_level: 'Normal', status: 'Pending', request_date: '2025-01-01T00:00:00.000Z', donor_matching_started_at: '2025-01-02T00:00:00.000Z', ...overrides });
const input = () => ({ admission_hospital_id: 11, state: 'Uttarakhand', city: 'Dehradun', blood_group: 'A+', units_required: 5, urgency_level: 'Emergency' });

async function execute(sql, args = []) {
  queries.push({ sql, args });
  if (failAt && sql.includes(failAt)) throw new Error('Private SQL details');
  if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') return [{}];
  if (sql.startsWith('SELECT b.bank_id, o.organization_id, o.organization_type') && sql.includes('LEFT JOIN blood_inventory')) return [organizations.filter(row => row.organization_type === 'Blood Bank').map(row => ({ ...row, inventory_id: row.bank_id, blood_group: args[0], units_available: cityStock }))];
  if (sql.startsWith('SELECT d.donor_id, d.name')) return [donors.map(row => ({ ...row, response: responses.find(r => r.request_id === args[0] && r.donor_id === row.donor_id)?.response ?? null }))];
  if (sql.startsWith('UPDATE blood_requests SET donor_matching')) { rows.find(row => row.request_id === args[0]).donor_matching_started_at ||= 'recorded-current-timestamp'; return [{ affectedRows: 1 }]; }
  if (sql.startsWith('INSERT INTO workflow_notifications')) return [{ insertId: 1 }];
  if (sql === 'SELECT workflow_version FROM blood_requests WHERE request_id = ? LIMIT 1') return [rows.filter(row => row.request_id === args[0]).map(row => ({ workflow_version: row.workflow_version }))];
  if (sql.startsWith('SELECT recipient_id FROM recipients')) return [[{ recipient_id: args[0] }]];
  if (sql.startsWith('SELECT organization_id, organization_type, state, city, name')) return [organizations.filter(row => row.organization_id === args[0])];
  if (sql.startsWith('SELECT o.organization_id, o.organization_type, o.name, o.state, o.city, b.bank_id')) {
    return [organizations.filter(row => sql.includes('WHERE o.organization_id') ? row.organization_id === args[0] : row.bank_id === args[0])];
  }
  if (sql.startsWith('SELECT b.bank_id, b.organization_id, COALESCE')) return [organizations.filter(row => row.bank_id === args[0])];
  if (sql.startsWith('SELECT b.bank_id, o.organization_id')) return [organizations.filter(row => row.organization_type === 'Blood Bank' && (!sql.includes('WHERE b.bank_id') || row.bank_id === args[0])).map(row => ({ ...row, bank_name: row.name }))];
  if (sql.startsWith('SELECT o.organization_id') && sql.includes('WHERE o.organization_type')) return [organizations.filter(row => row.organization_type === args[0])];
  if (sql.startsWith('INSERT INTO blood_requests')) {
    const created = request({ request_id: 101, recipient_id: args[0], admission_hospital_id: args[1], state: args[2], city: args[3], blood_group: args[4], units_required: args[5], urgency_level: args[6], status: args[7], donor_matching_started_at: null });
    rows.push(created); return [{ insertId: 101 }];
  }
  if (sql.startsWith('SELECT r.*')) {
    let result = [...rows];
    if (sql.includes('r.workflow_version = 2 AND')) result = result.filter(row => row.workflow_version === 2);
    if (sql.includes('WHERE r.request_id = ?')) result = result.filter(row => row.request_id === args[0]);
    if (sql.includes('r.recipient_id = ?')) result = result.filter(row => row.recipient_id === args.at(-1));
    return [result];
  }
  if (sql.startsWith('SELECT * FROM blood_requests')) return [rows.filter(row => row.request_id === args[0] && (!sql.includes('recipient_id = ?') || row.recipient_id === args[1]))];
  if (sql.startsWith('SELECT allocation_id, donation_id, inventory_id')) return [allocations.filter(row => row.request_id === args[0])];
  if (sql.startsWith('SELECT a.allocation_id')) return [allocations.filter(row => row.request_id === args[0])];
  if (sql.startsWith('SELECT dr.donor_id')) return [responses.filter(row => row.request_id === args[0] && row.response === 'Accepted').map(row => ({ ...donors.find(d => d.donor_id === row.donor_id), ...row }))];
  if ((sql.startsWith('SELECT response,') || sql.startsWith('SELECT dr.response,')) && sql.includes('donor_responses')) return [responses.filter(row => row.request_id === args[0] && row.donor_id === args[1])];
  if (sql.startsWith('SELECT collecting_bank_id FROM donor_responses')) return [responses.filter(row => row.request_id === args[0] && row.collecting_bank_id === args[1] && row.response === args[2])];
  if (sql.startsWith('SELECT donor_id, blood_group')) return [donors.filter(row => row.donor_id === args[0])];
  if (/^SELECT donor_id(?:, collecting_bank_id)? FROM donor_responses/.test(sql)) return [responses.filter(row => row.request_id === args[0] && row.response === args[1])];
  if (sql.startsWith('INSERT INTO donor_responses')) { responses.push({ request_id: args[0], donor_id: args[1], response: args[2], collecting_bank_id: args[3] }); return [{ affectedRows: 1 }]; }
  if (sql.startsWith('UPDATE blood_requests SET status')) { rows.find(row => row.request_id === args[1]).status = args[0]; return [{ affectedRows: 1 }]; }
  if (sql.includes('FROM donors d JOIN blood_requests')) return [[]];
  if (sql.startsWith('SELECT bank_id, bank_name')) return [organizations.filter(row => row.bank_id === args[0]).map(row => ({ ...row, bank_name: row.name }))];
  throw new Error('Unexpected mocked SQL: ' + sql);
}
before(async () => {
  process.env.JWT_SECRET = randomBytes(32).toString('hex'); process.env.JWT_EXPIRES_IN = '1h';
  pool.query = async () => { throw new Error('Real database access forbidden.'); };
  pool.execute = execute;
  config.assertReady = async () => { if (failAt === 'schema') { const error = new Error('The new request workflow is not available yet.'); error.status = 503; throw error; } };
  notices.notifyRequestAudience = async (...args) => { notifications.push(args.slice(1)); events.push('notice'); };
  pool.getConnection = async () => ({ execute, beginTransaction: async () => events.push('begin'), commit: async () => events.push('commit'), rollback: async () => events.push('rollback'), release: () => events.push('release'), destroy: () => events.push('destroy') });
  const app = express(); app.use(express.json()); app.use('/api/requests', require('../routes/requestRoutes')); app.use('/api/donors', require('../routes/donorRoutes')); app.use('/api/organizations', require('../routes/organizationRoutes'));
  app.use((error, req, res, next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ message: 'Invalid request body.' }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(() => {
  process.env.LIFESAVER_WORKFLOW_V2 = 'true'; rows = [request()]; organizations = [{ ...hospital }, { ...bank }, { ...bank, bank_id: 8, organization_id: 2, name: 'Fallback Bank' }];
  donors = [{ donor_id: 3, name: 'Donor', blood_group: 'A+', state: 'Uttarakhand', city: 'Dehradun', is_available: 1, phone: 'PRIVATE_PHONE', email: 'PRIVATE_EMAIL' }];
  responses = []; allocations = []; events = []; queries = []; notifications = []; failAt = null;
});
after(async () => { await new Promise(resolve => server.close(resolve)); Object.assign(pool, { execute: original.execute, query: original.query, getConnection: original.getConnection }); config.assertReady = original.ready; notices.notifyRequestAudience = original.notify;
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
async function api(path, { role = 'recipient', userId = 4, method = 'GET', body, token = true } = {}) {
  const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = 'Bearer ' + createToken(userId, role);
  const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await response.json();
  assert.doesNotMatch(JSON.stringify(data), /password_hash|Private SQL|\"stack\"/); return { status: response.status, data };
}
const bankOptions = (overrides = {}) => ({ role: 'organization', userId: 1, ...overrides });
test('V2 admission request derives recipient JWT and leaves exclusive provider empty', async () => {
  const result = await api('/api/requests', { method: 'POST', body: input() }); assert.equal(result.status, 201); assert.equal(rows[1].recipient_id, 4); assert.equal(rows[1].bank_id, null); assert.equal(rows[1].organization_id, null); assert.equal(rows[1].workflow_version, 2); assert.ok(rows[1].donor_matching_started_at); assert.equal(notifications.length, 2); assert.ok(events.indexOf('notice') < events.indexOf('commit'));
});
for (const [label, change] of [
  ['Blood Bank admission', { admission_hospital_id: 1 }], ['NGO admission', { admission_hospital_id: 12 }], ['wrong state', { state: 'Maharashtra' }], ['wrong city', { city: 'Rishikesh' }],
  ['exclusive bank', { bank_id: 7 }], ['exclusive organization', { organization_id: 11 }], ['manual recipient', { recipient_id: 4 }], ['manual status', { status: 'Fulfilled' }], ['manual approval', { approved_by: 1 }], ['manual date', { request_date: '2020-01-01' }],
  ['zero units', { units_required: 0 }], ['fraction units', { units_required: 1.5 }], ['invalid group', { blood_group: 'X' }], ['invalid urgency', { urgency_level: 'Urgent' }],
]) test('create rejects ' + label, async () => { organizations.push({ ...hospital, organization_id: 12, organization_type: 'NGO' }); const result = await api('/api/requests', { method: 'POST', body: { ...input(), ...change } }); assert.equal(result.status, 400); assert.equal(rows.length, 1); assert.equal(notifications.length, 0); });

test('normalized city is shared between validation and visibility', async () => { organizations[0].city = ' DehraDun '; assert.equal((await api('/api/requests', { method: 'POST', body: { ...input(), city: 'dehradun' } })).status, 201); });
for (const role of ['donor', 'organization', 'blood_bank']) test(role + ' cannot create recipient request', async () => assert.equal((await api('/api/requests', { method: 'POST', role, userId: 1, body: input() })).status, 403));
test('request API requires JWT', async () => assert.equal((await api('/api/requests', { token: false })).status, 401));
test('public capability contains activation boolean only', async () => { const result = await api('/api/requests/workflow-config', { token: false }); assert.deepEqual(result.data, { workflow_v2_enabled: true }); });
test('unready migration fails closed without request query', async () => { failAt = 'schema'; assert.equal((await api('/api/requests')).status, 503); assert.equal(queries.length, 0); assert.ok(events.includes('rollback')); });
test('disabled V2 admission payload cannot fall back to V1', async () => { delete process.env.LIFESAVER_WORKFLOW_V2; assert.equal((await api('/api/requests', { method: 'POST', body: input() })).status, 503); assert.equal(queries.length, 0); });
test('disabled capability reports false', async () => { delete process.env.LIFESAVER_WORKFLOW_V2; assert.deepEqual((await api('/api/requests/workflow-config')).data, { workflow_v2_enabled: false }); });
test('same-city bank sees city demand without selected ownership', async () => { const result = await api('/api/requests', bankOptions()); assert.equal(result.status, 200); assert.equal(result.data.requests.length, 1); assert.equal(result.data.requests[0].bank_id, null); assert.equal(result.data.requests[0].can_supply, true); });
test('another same-city bank can see the same request', async () => assert.equal((await api('/api/requests', bankOptions({ userId: 2 }))).data.requests.length, 1));
test('newly registered bank discovers earlier city request', async () => { organizations.push({ ...bank, organization_id: 99, bank_id: 99 }); assert.equal((await api('/api/requests', bankOptions({ userId: 99 }))).data.requests.length, 1); });
for (const [label, change] of [['wrong city', { city: 'Rishikesh' }], ['wrong state', { state: 'Maharashtra' }], ['missing geography', { city: null }]]) test('bank ' + label + ' cannot see demand', async () => { Object.assign(organizations[1], change); assert.equal((await api('/api/requests', bankOptions())).data.requests.length, 0); assert.equal((await api('/api/requests/100', bankOptions())).status, 404); });
test('legacy bank login resolves current registered city bank', async () => assert.equal((await api('/api/requests', { role: 'blood_bank', userId: 7 })).data.requests.length, 1));
test('unlinked legacy bank retains V1 requests but cannot discover V2 city demand', async () => {
  organizations[1].organization_id = null; organizations[1].state = null; organizations[1].city = null;
  rows.push(request({ request_id: 101, workflow_version: 1, bank_id: 7, admission_hospital_id: null }));
  const result = await api('/api/requests', { role: 'blood_bank', userId: 7 });
  assert.equal(result.status, 200); assert.deepEqual(result.data.requests.map(row => row.request_id), [101]);
});
test('Hospital without bank companion sees only own admissions', async () => { rows.push(request({ request_id: 101, admission_hospital_id: 999 })); const result = await api('/api/requests', bankOptions({ userId: 11 })); assert.equal(result.status, 200); assert.equal(result.data.requests.length, 1); assert.equal(result.data.requests[0].can_supply, false); });
test('unrelated Hospital is denied detail', async () => { organizations.push({ ...hospital, organization_id: 12 }); assert.equal((await api('/api/requests/100', bankOptions({ userId: 12 }))).status, 404); });
test('NGO cannot read city requests', async () => { organizations.push({ ...hospital, organization_id: 12, organization_type: 'NGO' }); assert.equal((await api('/api/requests', bankOptions({ userId: 12 }))).status, 403); });
test('recipient sees only own data', async () => { rows.push(request({ request_id: 101, recipient_id: 9 })); assert.equal((await api('/api/requests')).data.requests.length, 1); assert.equal((await api('/api/requests/101')).status, 404); });
test('city Bank does not receive unrelated donor contacts', async () => { responses.push({ request_id: 100, donor_id: 3, response: 'Accepted', collecting_bank_id: 8 }); const result = await api('/api/requests', bankOptions()); assert.deepEqual(result.data.requests[0].accepted_donors, []); assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE_/); });
test('designated bank receives coordination contacts only for own donor', async () => { responses.push({ request_id: 100, donor_id: 3, response: 'Accepted', collecting_bank_id: 7 }); const result = await api('/api/requests', bankOptions()); assert.equal(result.data.requests[0].accepted_donors[0].phone, 'PRIVATE_PHONE'); });
for (const audience of ['recipient', 'hospital']) test(audience + ' sees progress without private donor contacts', async () => { responses.push({ request_id: 100, donor_id: 3, response: 'Accepted', collecting_bank_id: 7 }); const result = await api('/api/requests', audience === 'recipient' ? {} : bankOptions({ userId: 11 })); assert.equal(result.status, 200); assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE_/); });
test('failed screening removes contact even from designated bank', async () => { responses.push({ request_id: 100, donor_id: 3, response: 'Accepted', collecting_bank_id: 7, screening_result: 'Failed' }); assert.doesNotMatch(JSON.stringify((await api('/api/requests', bankOptions())).data), /PRIVATE_/); });
test('bank receives own contribution history without other banks ledger rows', async () => { rows[0].status = 'Fulfilled'; allocations = [{ allocation_id: 1, request_id: 100, inventory_id: 1, donation_id: null, units_allocated: 2, bank_id: 7 }, { allocation_id: 2, request_id: 100, inventory_id: 2, donation_id: null, units_allocated: 3, bank_id: 8 }]; const result = await api('/api/requests', bankOptions()); assert.equal(result.data.requests[0].fulfilled_units, 5); assert.equal(result.data.requests[0].contributions.length, 1); });
test('closed unrelated request is not broadcast', async () => { rows[0].status = 'Cancelled'; assert.equal((await api('/api/requests', bankOptions())).data.requests.length, 0); });
test('provider queue preserves Emergency FCFS across city-wide requests', async () => { rows.push(request({ request_id: 102, urgency_level: 'Emergency' })); const result = await api('/api/requests/provider-queue', bankOptions()); assert.equal(result.status, 200); assert.deepEqual(result.data.queue.map(row => row.request_id), [102, 100]); assert.equal(result.data.queue[0].bank_id, null); });
test('Hospital V2 queue has no clinical review dispatch', async () => assert.deepEqual((await api('/api/requests/provider-queue', bankOptions({ userId: 11 }))).data.queue, []));
test('provider queue is read-only', async () => { await api('/api/requests/provider-queue', bankOptions()); assert.ok(queries.every(q => q.sql.startsWith('SELECT '))); assert.ok(queries.every(q => !q.sql.includes('FOR UPDATE'))); });
test('provider queue rejects arbitrary scope override', async () => assert.equal((await api('/api/requests/provider-queue?bank_id=8', bankOptions())).status, 400));
test('recipient cannot access provider queue', async () => assert.equal((await api('/api/requests/provider-queue')).status, 403));
test('Hospital directory includes no companion-bank admission', async () => { const result = await api('/api/organizations?state=Uttarakhand&city=dehradun&organization_type=Hospital', { token: false }); assert.equal(result.status, 200); assert.equal(result.data.organizations.length, 1); assert.equal(result.data.organizations[0].bank_id, null); });
test('city directory exposes only Hospital cities when requested', async () => { const result = await api('/api/organizations/cities?state=Uttarakhand&organization_type=Hospital', { token: false }); assert.deepEqual(result.data.cities, ['Dehradun']); });

test('available same-city donor sees eligible collecting banks in their city', async () => { const result = await api('/api/donors/me/matching-requests', { role: 'donor', userId: 3 }); assert.equal(result.status, 200); assert.equal(result.data.requests.length, 1); assert.deepEqual(result.data.requests[0].eligible_collecting_banks.map(row => row.bank_id), [7, 8]); assert.doesNotMatch(JSON.stringify(result.data), /PRIVATE_/); });
for (const [label, change] of [['unavailable', { is_available: 0 }], ['wrong group', { blood_group: 'B+' }], ['wrong city', { city: 'Rishikesh' }]]) test(label + ' donor has no new opportunity', async () => { Object.assign(donors[0], change); assert.equal((await api('/api/donors/me/matching-requests', { role: 'donor', userId: 3 })).data.requests.length, 0); });
const respond = body => api('/api/donors/me/requests/100/response', { method: 'POST', role: 'donor', userId: 3, body });
test('acceptance requires explicit collecting bank', async () => assert.equal((await respond({ response: 'Accepted' })).status, 400));
test('donor can select any same-city bank as collecting provider', async () => { const result = await respond({ response: 'Accepted', collecting_bank_id: 8 }); assert.equal(result.status, 201); assert.equal(responses[0].collecting_bank_id, 8); assert.equal(allocations.length, 0); assert.equal(rows[0].status, 'Processing'); });
test('wrong-city collection assignment is rejected', async () => { organizations[2].city = 'Rishikesh'; assert.equal((await respond({ response: 'Accepted', collecting_bank_id: 8 })).status, 409); assert.equal(responses.length, 0); });
test('Hospital cannot be selected for collection', async () => assert.equal((await respond({ response: 'Accepted', collecting_bank_id: 15 })).status, 409));
test('same response replay retains collecting bank', async () => { await respond({ response: 'Accepted', collecting_bank_id: 7 }); assert.equal((await respond({ response: 'Accepted', collecting_bank_id: 7 })).status, 201); assert.equal(responses.length, 1); });
test('donor cannot switch bank after accepting', async () => { await respond({ response: 'Accepted', collecting_bank_id: 7 }); assert.equal((await respond({ response: 'Accepted', collecting_bank_id: 8 })).status, 409); assert.equal(responses[0].collecting_bank_id, 7); });
test('decline needs no collection bank and creates no fulfillment', async () => { assert.equal((await respond({ response: 'Declined' })).status, 201); assert.equal(allocations.length, 0); });
test('accepted history remains visible after donor location changes', async () => { await respond({ response: 'Accepted', collecting_bank_id: 7 }); donors[0].city = 'Rishikesh'; donors[0].is_available = 0; assert.equal((await api('/api/donors/me/matching-requests', { role: 'donor', userId: 3 })).data.requests.length, 1); });
test('designated bank and donor can see genuine Inventory collection without fulfillment credit', async () => {
  responses.push({ request_id: 100, donor_id: 3, response: 'Accepted', collecting_bank_id: 7, screening_result: 'Passed', collection_id: 12, units_collected: 2, accounting_path: 'Inventory' });
  const bankResult = (await api('/api/requests', bankOptions())).data.requests[0];
  assert.equal(bankResult.accepted_donors[0].collection_id, 12); assert.equal(bankResult.accepted_donors[0].accounting_path, 'Inventory'); assert.equal(bankResult.fulfilled_units, 0);
  const donorResult = (await api('/api/donors/me/matching-requests', { role: 'donor', userId: 3 })).data.requests[0];
  assert.equal(donorResult.collection_id, 12); assert.equal(donorResult.units_collected, 2); assert.equal(donorResult.fulfilled_units, 0);
});
test('collecting bank retains read-only coordination history after closure or relocation', async () => {
  responses.push({ request_id: 100, donor_id: 3, response: 'Accepted', collecting_bank_id: 7, screening_result: 'Passed', collection_id: 12, units_collected: 2, accounting_path: 'Inventory' });
  rows[0].status = 'Cancelled'; organizations[1].city = 'Rishikesh';
  const result = await api('/api/requests/100', bankOptions());
  assert.equal(result.status, 200); assert.equal(result.data.request.can_supply, false); assert.equal(result.data.request.accepted_donors[0].collection_id, 12);
});
test('closed request rejects a new acceptance', async () => { rows[0].status = 'Cancelled'; assert.equal((await respond({ response: 'Accepted', collecting_bank_id: 7 })).status, 409); });
test('own cancellation preserves contribution rows and notifies transactionally', async () => { allocations.push({ allocation_id: 1, request_id: 100, inventory_id: 1, donation_id: null, units_allocated: 2, bank_id: 7 }); const before = JSON.stringify(allocations); const result = await api('/api/requests/100/cancel', { method: 'PATCH', body: {} }); assert.equal(result.status, 200); assert.equal(rows[0].status, 'Cancelled'); assert.equal(JSON.stringify(allocations), before); assert.equal(notifications.length, 1); });
test('another recipient cannot cancel', async () => assert.equal((await api('/api/requests/100/cancel', { userId: 9, method: 'PATCH', body: {} })).status, 404));
test('Bank cannot cancel', async () => assert.equal((await api('/api/requests/100/cancel', bankOptions({ method: 'PATCH', body: {} }))).status, 403));
test('unexpected query error is safe and rolls back', async () => { failAt = 'SELECT r.*'; const result = await api('/api/requests'); assert.equal(result.status, 500); assert.ok(events.includes('rollback')); assert.equal(events.at(-1), 'release'); });
