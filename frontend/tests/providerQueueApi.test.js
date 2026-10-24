import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { API_BASE_URL } from '../src/config/api.js';
import { fetchProviderQueue } from '../src/services/providerQueueApi.js';

const originalAdapter = axios.defaults.adapter;
const session = { token: 'memory-only-provider-token', user: { user_id: 9, user_type: 'organization' } };
const provider = { organization_id: 9, organization_type: 'Blood Bank', bank_id: 6 };
const row = { request_id: 27, bank_id: 6, blood_group: 'A+', units_required: 13, remaining_units: 6,
  urgency_level: 'Emergency', status: 'Processing', request_date: '2026-10-20T10:00:00.000Z',
  priority: 0, position: 1, waiting_seconds: 86400, long_waiting_normal: false, time_warning: null,
  selection_reason: 'Emergency first; oldest request wins within its priority.' };
function response(queue = [{ ...row }]) {
  return { bank_id: 6, organization_id: 9, algorithm: 'Non-preemptive Priority + FCFS',
    generated_at: '2026-10-21T10:00:00.000Z', long_wait_threshold_seconds: 86400, queue };
}
let data, calls;
beforeEach(() => {
  calls = []; data = response();
  // Memory adapter hai; real backend aur MySQL ko call nahi karega.
  axios.defaults.adapter = async config => {
    calls.push(config);
    return { config, data, status: 200, statusText: 'OK', headers: {} };
  };
});
after(() => { axios.defaults.adapter = originalAdapter; });

test('queue sends one read-only authenticated GET with cancellation and timeout', async () => {
  const controller = new AbortController();
  const result = await fetchProviderQueue(session, controller.signal, provider);
  assert.deepEqual(result, data);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'get');
  assert.equal(calls[0].url, API_BASE_URL + '/api/requests/provider-queue');
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + session.token);
  assert.equal(calls[0].timeout, 15000);
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(calls[0].params, undefined);
  assert.equal(calls[0].data, undefined);
});

test('Hospital and Blood Bank organizations can retrieve their own queue', async () => {
  for (const organization_type of ['Hospital', 'Blood Bank']) {
    const result = await fetchProviderQueue(session, undefined, { ...provider, organization_type });
    assert.equal(result.bank_id, 6);
    assert.equal(result.organization_id, 9);
  }
});

test('legacy blood bank uses JWT bank ID and allows null organization identity', async () => {
  const legacy = { token: 'memory-legacy', user: { user_id: 6, user_type: 'blood_bank' } };
  data.organization_id = null;
  assert.deepEqual(await fetchProviderQueue(legacy), data);
  data.organization_id = 9;
  assert.equal((await fetchProviderQueue(legacy, undefined, provider)).organization_id, 9);
});

for (const [name, value, identity] of [
  ['missing session', null, provider],
  ['missing user', { token: 'memory' }, provider],
  ['missing token', { user: session.user }, provider],
  ['blank token', { ...session, token: '  ' }, provider],
  ['invalid ID', { ...session, user: { ...session.user, user_id: 0 } }, provider],
  ['unsafe ID', { ...session, user: { ...session.user, user_id: Number.MAX_SAFE_INTEGER + 1 } }, provider],
  ['donor role', { ...session, user: { ...session.user, user_type: 'donor' } }, provider],
  ['recipient role', { ...session, user: { ...session.user, user_type: 'recipient' } }, provider],
  ['admin role', { ...session, user: { ...session.user, user_type: 'admin' } }, provider],
  ['NGO provider', session, { ...provider, organization_type: 'NGO' }],
  ['missing provider', session, undefined],
  ['another organization', session, { ...provider, organization_id: 10 }],
  ['missing linked bank', session, { ...provider, bank_id: null }],
  ['string bank ID', session, { ...provider, bank_id: '6' }],
  ['legacy conflicting bank', { token: 'memory', user: { user_id: 6, user_type: 'blood_bank' } }, { bank_id: 8 }],
]) {
  test('invalid provider cannot send API call: ' + name, async () => {
    await assert.rejects(fetchProviderQueue(value, undefined, identity));
    assert.equal(calls.length, 0);
  });
}

test('queue keeps server order without sorting and returns fresh whitelisted objects', async () => {
  data.queue = [{ ...row, request_id: 55, password_hash: 'PRIVATE', recipient_id: 3 },
    { ...row, request_id: 2, position: 2, password: 'PRIVATE' }];
  data.password = 'PRIVATE';
  const result = await fetchProviderQueue(session, undefined, provider);
  assert.deepEqual(result.queue.map(item => item.request_id), [55, 2]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(!('recipient_id' in result.queue[0]));
  assert.notEqual(result, data);
  assert.notEqual(result.queue[0], data.queue[0]);
});

test('empty provider queue is a valid successful response', async () => {
  data.queue = [];
  assert.deepEqual((await fetchProviderQueue(session, undefined, provider)).queue, []);
});

test('unknown creation date preserves null waiting age and explanatory warning', async () => {
  data.queue = [{ ...row, request_date: null, waiting_seconds: null, time_warning: 'Creation time unavailable.' }];
  const result = await fetchProviderQueue(session, undefined, provider);
  assert.equal(result.queue[0].waiting_seconds, null);
  assert.equal(result.queue[0].request_date, null);
  assert.equal(result.queue[0].time_warning, 'Creation time unavailable.');
});

test('Normal long-wait flag follows server threshold without changing priority', async () => {
  data.long_wait_threshold_seconds = 300;
  data.queue = [{ ...row, urgency_level: 'Normal', priority: 1, waiting_seconds: 300, long_waiting_normal: true }];
  const result = await fetchProviderQueue(session, undefined, provider);
  assert.equal(result.queue[0].priority, 1);
  assert.equal(result.queue[0].long_waiting_normal, true);
  data.queue[0].waiting_seconds = 299;
  data.queue[0].long_waiting_normal = false;
  assert.equal((await fetchProviderQueue(session, undefined, provider)).queue[0].long_waiting_normal, false);
});

for (const [name, patch] of [
  ['cross-bank response', { bank_id: 8 }],
  ['cross-organization response', { organization_id: 10 }],
  ['organization omitted', { organization_id: undefined }],
  ['null organization for organization login', { organization_id: null }],
  ['algorithm mismatch', { algorithm: 'SQL ORDER BY' }],
  ['invalid generation date', { generated_at: 'not a date' }],
  ['timezone omitted', { generated_at: '2026-10-21T10:00:00' }],
  ['threshold zero', { long_wait_threshold_seconds: 0 }],
  ['threshold fraction', { long_wait_threshold_seconds: 1.5 }],
  ['queue omitted', { queue: undefined }],
  ['queue not array', { queue: {} }],
]) {
  test('queue rejects invalid response metadata: ' + name, async () => {
    data = { ...data, ...patch };
    await assert.rejects(fetchProviderQueue(session, undefined, provider), /Unexpected provider queue/);
  });
}

for (const [name, patch] of [
  ['invalid request ID', { request_id: 0 }],
  ['string request ID', { request_id: '27' }],
  ['unsafe request ID', { request_id: Number.MAX_SAFE_INTEGER + 1 }],
  ['cross-bank row', { bank_id: 8 }],
  ['unknown blood group', { blood_group: 'unknown' }],
  ['zero required units', { units_required: 0 }],
  ['fractional required units', { units_required: 1.5 }],
  ['zero remaining units', { remaining_units: 0 }],
  ['negative remaining units', { remaining_units: -1 }],
  ['excess remaining units', { remaining_units: 14 }],
  ['fractional remaining units', { remaining_units: 1.5 }],
  ['closed Fulfilled request', { status: 'Fulfilled' }],
  ['closed Cancelled request', { status: 'Cancelled' }],
  ['unknown urgency', { urgency_level: 'Urgent' }],
  ['wrong numeric priority', { priority: 1 }],
  ['string priority', { priority: '0' }],
  ['wrong queue position', { position: 2 }],
  ['date omitted', { request_date: undefined }],
  ['invalid date', { request_date: 'not a date' }],
  ['negative waiting age', { waiting_seconds: -1 }],
  ['fractional waiting age', { waiting_seconds: 1.5 }],
  ['unsafe waiting age', { waiting_seconds: Number.MAX_SAFE_INTEGER + 1 }],
  ['waiting age omitted', { waiting_seconds: undefined }],
  ['nonboolean wait flag', { long_waiting_normal: 'false' }],
  ['Emergency aged into Normal alert', { long_waiting_normal: true }],
  ['Normal missing long-wait alert', { urgency_level: 'Normal', priority: 1 }],
  ['warning omitted', { time_warning: undefined }],
  ['nontext warning', { time_warning: {} }],
  ['blank warning', { time_warning: ' ' }],
  ['missing reason', { selection_reason: undefined }],
  ['blank reason', { selection_reason: ' ' }],
]) {
  test('queue rejects unsafe or inconsistent row: ' + name, async () => {
    data.queue = [{ ...row, ...patch }];
    await assert.rejects(fetchProviderQueue(session, undefined, provider), /Unexpected provider queue/);
  });
}

test('duplicate request IDs are rejected even when positions differ', async () => {
  data.queue = [{ ...row }, { ...row, position: 2 }];
  await assert.rejects(fetchProviderQueue(session, undefined, provider), /Unexpected provider queue/);
});

test('HTTP and network errors propagate for dashboard safe error handling', async () => {
  for (const status of [401, 403, 500, undefined]) {
    const error = new Error('memory-only API failure');
    if (status) error.response = { status };
    axios.defaults.adapter = async () => { throw error; };
    await assert.rejects(fetchProviderQueue(session, undefined, provider), value => value === error);
  }
});

test('cancelled request never reaches Axios adapter', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchProviderQueue(session, controller.signal, provider), error => axios.isCancel(error));
  assert.equal(calls.length, 0);
});
