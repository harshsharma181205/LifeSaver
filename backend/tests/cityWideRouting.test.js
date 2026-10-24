const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const pool = require('../db');
const config = require('../services/workflowV2Config');
const clinical = require('../services/cityWideClinicalService');
const { createToken } = require('../services/jwtService');
const original = { execute: pool.execute, query: pool.query, getConnection: pool.getConnection, ready: config.assertReady, action: clinical.runAction };
const environment = Object.fromEntries(['JWT_SECRET', 'JWT_EXPIRES_IN', 'LIFESAVER_WORKFLOW_V2'].map(key => [key, process.env[key]]));
let server, base, calls, ready, statusError;
const paths = [['allocate', '/api/allocations/process/123'], ['match', '/api/allocations/match/123'], ['screen', '/api/screenings/123'], ['collect', '/api/donations/123']];
before(async () => {
  process.env.JWT_SECRET = require('node:crypto').randomBytes(32).toString('hex'); process.env.JWT_EXPIRES_IN = '1h';
  pool.query = pool.getConnection = async () => { throw new Error('Real database forbidden.'); };
  pool.execute = async (sql, args) => { assert.equal(sql, 'SELECT workflow_version FROM blood_requests WHERE request_id = ? LIMIT 1'); assert.deepEqual(args, [123]); return [[{ workflow_version: 2 }]]; };
  config.assertReady = async () => { if (!ready) { const error = new Error('Workflow unavailable.'); error.status = 503; throw error; } };
  clinical.runAction = async (...args) => { calls.push(args); if (statusError) { const error = new Error('Safe clinical conflict.'); error.status = statusError; throw error; } return { request_id: 123, remaining_units: 1, status: 'Processing' }; };
  const app = express(); app.use(express.json()); app.use('/api/allocations', require('../routes/allocationRoutes')); app.use('/api/screenings', require('../routes/screeningRoutes')); app.use('/api/donations', require('../routes/donationRoutes'));
  app.use((error, req, res, next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ message: 'Invalid JSON body.' }));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(() => { process.env.LIFESAVER_WORKFLOW_V2 = 'true'; calls = []; ready = true; statusError = null; });
after(async () => { await new Promise(resolve => server.close(resolve)); Object.assign(pool, { execute: original.execute, query: original.query, getConnection: original.getConnection }); config.assertReady = original.ready; clinical.runAction = original.action;
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
async function post(path, role = 'organization', body = {}, raw) {
  const headers = { 'Content-Type': 'application/json', ...(role ? { Authorization: 'Bearer ' + createToken(7, role) } : {}) };
  const response = await fetch(base + path, { method: 'POST', headers, body: raw ?? JSON.stringify(body) }); return { status: response.status, body: await response.json() };
}
for (const [action, path] of paths) {
  test(action + ' endpoint dispatches authenticated actor, request ID and body to V2 service', async () => { const result = await post(path, 'organization', { marker: 'wire-only fixture' }); assert.equal(result.status, 200); assert.deepEqual(calls[0], [{ user_id: 7, user_type: 'organization' }, 123, action, { marker: 'wire-only fixture' }]); });
  test(action + ' endpoint rejects missing JWT', async () => { assert.equal((await post(path, null)).status, 401); assert.equal(calls.length, 0); });
  for (const role of ['donor', 'recipient']) test(action + ' rejects ' + role + ' before clinical dispatch', async () => { assert.equal((await post(path, role)).status, 403); assert.equal(calls.length, 0); });
}
test('bank login token is preserved through dispatch', async () => { assert.equal((await post(paths[0][1], 'blood_bank')).status, 200); assert.equal(calls[0][0].user_type, 'blood_bank'); });
test('unready migration rejects clinical dispatch', async () => { ready = false; assert.equal((await post(paths[0][1])).status, 503); assert.equal(calls.length, 0); });
for (const status of [400, 403, 404, 409]) test('safe service error ' + status + ' stays structured', async () => { statusError = status; const result = await post(paths[0][1]); assert.equal(result.status, status); assert.deepEqual(result.body, { message: 'Safe clinical conflict.' }); });
test('malformed JSON never reaches clinical service', async () => { assert.equal((await post(paths[0][1], 'organization', {}, '{')).status, 400); assert.equal(calls.length, 0); });
test('large body never reaches clinical service', async () => { assert.equal((await post(paths[0][1], 'organization', { value: 'x'.repeat(120000) })).status, 413); assert.equal(calls.length, 0); });
