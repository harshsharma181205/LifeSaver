import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  fetchRecipientRequest, isValidRequestId, requestDetailsError,
} from '../src/services/recipientDashboardApi.js';

const originalAdapter = axios.defaults.adapter;
const session = { token: 'memory-test-token', user: { user_id: 16, user_type: 'recipient' } };
const row = { request_id: 27, blood_group: 'O+', units_required: 1,
  urgency_level: 'Normal', status: 'Pending', request_date: '2026-10-06T06:30:00.000Z', bank_id: 3, donor_matching_started_at: null, bank_name: 'Central Blood Bank', bank_address: 'Pune Main Road', bank_phone: '02012345678', bank_email: 'central@example.test' };
let calls, data, failure;
beforeEach(() => {
  calls = []; data = { request: { ...row } }; failure = null;
  // API responses memory mein hain; real backend/database call nahi hogi.
  axios.defaults.adapter = async (config) => {
    calls.push(config);
    if (failure) throw failure;
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});
after(() => { axios.defaults.adapter = originalAdapter; });

test('detail GET sends Bearer token to exact URL and returns only twelve safe request and bank fields', async () => {
  data.request.password_hash = 'ignored-fixture';
  data.request.approved_by = 99;
  const signal = new AbortController().signal;
  const result = await fetchRecipientRequest(session, '27', signal);
  for (const [field, value] of Object.entries(row)) assert.deepEqual(result[field], value);
  assert.equal(result.fulfilled_units, 0); assert.equal(result.remaining_units, row.units_required);
  assert.equal(calls[0].url, 'http://localhost:5000/api/requests/27');
  assert.equal(calls[0].method, 'get');
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + session.token);
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[0].timeout, 15000);
  assert.equal(calls[0].params, undefined);
});
for (const value of ['1', '00027', '2147483647']) {
  test('positive signed INT link is accepted: ' + value, async () => {
    assert.equal(isValidRequestId(value), true);
    data.request.request_id = Number(value);
    assert.equal((await fetchRecipientRequest(session, value)).request_id, Number(value));
  });
}
for (const value of ['', '0', '-1', '+1', '1.5', '1e3', '2147483648', 'abc', ' 27 ', '27 OR 1=1', undefined, null, 27]) {
  test('invalid link never sends an API call: ' + String(value), async () => {
    assert.equal(isValidRequestId(value), false);
    await assert.rejects(fetchRecipientRequest(session, value), /Invalid request link/);
    assert.equal(calls.length, 0);
  });
}
for (const status of ['Pending', 'Processing', 'Fulfilled', 'Cancelled']) {
  test('stored ' + status + ' is preserved without inventing stages', async () => {
    data.request.status = status;
    assert.equal((await fetchRecipientRequest(session, '27')).status, status);
  });
}
test('nullable legacy fields are preserved for a truthful unavailable display', async () => {
  data.request.status = null; data.request.request_date = null;
  const result = await fetchRecipientRequest(session, '27');
  assert.equal(result.status, null);
  assert.equal(result.request_date, null);
});
for (const response of [{}, { request: null }, { request: { ...row, request_id: 28 } },
  { request: { ...row, recipient_id: 99 } }, { request: { ...row, status: 'Approved' } },
  { request: { ...row, units_required: 0 } }, { request: { ...row, blood_group: 'Unknown' } },
  { request: { ...row, urgency_level: 'Urgent' } }]) {
  test('malformed/mismatched detail is rejected: ' + JSON.stringify(response), async () => {
    data = response;
    await assert.rejects(fetchRecipientRequest(session, '27'), /Unexpected request details/);
  });
}
for (const status of [400, 401, 403, 404, 500]) {
  test('HTTP ' + status + ' remains available for safe page handling', async () => {
    failure = new axios.AxiosError('Private SQL details', 'ERR_BAD_RESPONSE', {}, {}, { status });
    await assert.rejects(fetchRecipientRequest(session, '27'), error => error.response.status === status);
    assert.ok(!requestDetailsError(failure).includes('Private SQL'));
  });
}
test('network failure yields a readable message without internal details', async () => {
  failure = new axios.AxiosError('Private network details', 'ERR_NETWORK');
  await assert.rejects(fetchRecipientRequest(session, '27'));
  assert.match(requestDetailsError(failure), /Unable to reach the backend/);
});
test('aborted detail load never becomes a successful request', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchRecipientRequest(session, '27', controller.signal), axios.isCancel);
  assert.equal(calls.length, 0);
});

test('detail preserves the bank contact and donor matching fields with no private data', async () => {
  data.request = { ...row, donor_matching_started_at: row.request_date,
    bank_password_hash: 'private-fixture', donor_id: 8, donor_phone: 'private-phone',
    bank: { password_hash: 'nested-private-fixture' } };
  const result = await fetchRecipientRequest(session, '27');
  for (const key of ['bank_id', 'bank_name', 'bank_address', 'bank_phone', 'bank_email']) assert.equal(result[key], row[key]);
  assert.equal(result.donor_matching_started_at, row.request_date);
  assert.ok(!('password_hash' in result)); assert.ok('fulfilled_units' in result);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});
test('legacy bank assignment and contacts stay null', async () => {
  data.request = { ...row, bank_id: null, donor_matching_started_at: null,
    bank_name: null, bank_address: null, bank_phone: null, bank_email: null };
  const result = await fetchRecipientRequest(session, '27');
  for (const key of ['bank_id', 'donor_matching_started_at', 'bank_name', 'bank_address', 'bank_phone', 'bank_email']) assert.equal(result[key], null);
});