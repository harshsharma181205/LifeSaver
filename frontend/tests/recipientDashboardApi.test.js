import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  fetchRecipientRequests, fetchRecipientName, requestHistoryError, formatRequestDate,
} from '../src/services/recipientDashboardApi.js';

const originalAdapter = axios.defaults.adapter;
const session = { token: 'test-only-token', user: { user_id: 16, user_type: 'recipient' } };
let calls;
let responseData;
let failure;
const row = {
  request_id: 27, recipient_id: 16, blood_group: 'O+', units_required: 1,
  urgency_level: 'Normal', status: 'Pending', request_date: '2026-10-06T06:30:00.000Z', bank_id: 3, donor_matching_started_at: null, bank_name: 'Central Blood Bank', bank_address: 'Pune Main Road', bank_phone: '02012345678', bank_email: 'central@example.test',
  approved_by: null,
};
beforeEach(() => {
  calls = [];
  responseData = { requests: [row] };
  failure = null;
  // Axios adapter memory mein response dega; backend/database call nahi hogi.
  axios.defaults.adapter = async (config) => {
    calls.push(config);
    if (failure) throw failure;
    return { data: responseData, status: 200, statusText: 'OK', headers: {}, config };
  };
});
after(() => { axios.defaults.adapter = originalAdapter; });

test('history uses shared API URL and JWT without a client ownership query', async () => {
  const signal = new AbortController().signal;
  const result = await fetchRecipientRequests(session, signal);
  assert.equal(calls[0].url, 'http://localhost:5000/api/requests');
  assert.equal(calls[0].method, 'get');
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + session.token);
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[0].timeout, 15000);
  assert.ok(['request_id','blood_group','units_required','urgency_level','status','bank_id','organization_name','city','state','fulfilled_units','remaining_units','accepted_donors'].every(field => field in result[0]));
});
test('successful empty history stays empty', async () => {
  responseData = { requests: [] };
  assert.deepEqual(await fetchRecipientRequests(session), []);
});
test('populated history preserves backend priority order and all display fields', async () => {
  responseData.requests = [{ ...row, request_id: 29, urgency_level: 'Emergency' }, row];
  const result = await fetchRecipientRequests(session);
  assert.deepEqual(result.map((request) => request.request_id), [29, 27]);
  assert.equal(result[1].blood_group, 'O+');
  assert.equal(result[1].units_required, 1);
  assert.equal(result[1].status, 'Pending');
});
test('history is fetched again and returns the newest backend data', async () => {
  responseData = { requests: [] };
  assert.deepEqual(await fetchRecipientRequests(session), []);
  responseData = { requests: [row] };
  assert.equal((await fetchRecipientRequests(session))[0].request_id, 27);
  assert.equal(calls.length, 2);
});
for (const data of [{}, { requests: null }, { requests: {} }, { requests: [null] },
  { requests: [{ ...row, request_id: 0 }] }, { requests: [{ ...row, units_required: 0 }] },
  { requests: [{ ...row, recipient_id: 99 }] }]) {
  test('malformed or mismatched history is rejected: ' + JSON.stringify(data), async () => {
    responseData = data;
    await assert.rejects(fetchRecipientRequests(session), /Unexpected request history/);
  });
}
test('name comes from authenticated profile and is trimmed', async () => {
  responseData = { user_id: 16, user_type: 'recipient', name: '  Gaurav  ', password_hash: 'ignore' };
  assert.equal(await fetchRecipientName(session), 'Gaurav');
  assert.equal(calls[0].url, 'http://localhost:5000/api/auth/me');
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + session.token);
});
for (const profile of [null, {}, { user_id: 99, user_type: 'recipient', name: 'Other' },
  { user_id: 16, user_type: 'donor', name: 'Other' }, { user_id: 16, user_type: 'recipient', name: '   ' }]) {
  test('invalid profile permits generic greeting: ' + JSON.stringify(profile), async () => {
    responseData = profile;
    assert.equal(await fetchRecipientName(session), '');
  });
}
for (const status of [401, 403, 404, 500]) {
  test('history and profile retain HTTP ' + status + ' for caller handling', async () => {
    failure = new axios.AxiosError('Private SQL details', 'ERR_BAD_RESPONSE', {}, {}, { status });
    await assert.rejects(fetchRecipientRequests(session), (error) => error.response.status === status);
    await assert.rejects(fetchRecipientName(session), (error) => error.response.status === status);
    assert.ok(!requestHistoryError(failure).includes('Private SQL'));
  });
}
test('network error uses a safe readable message', async () => {
  failure = new axios.AxiosError('Network Error', 'ERR_NETWORK');
  await assert.rejects(fetchRecipientRequests(session));
  assert.match(requestHistoryError(failure), /Unable to reach the backend/);
});
test('cancelled requests do not become successful empty history', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchRecipientRequests(session, controller.signal), axios.isCancel);
  assert.equal(calls.length, 0);
});
test('date is formatted for India and handles missing/invalid dates', () => {
  assert.match(formatRequestDate(row.request_date), /6 Oct 2026/);
  assert.match(formatRequestDate(row.request_date), /12:00/);
  assert.equal(formatRequestDate(null), 'Date unavailable');
  assert.equal(formatRequestDate('invalid'), 'Date unavailable');
});

test('nullable stored status keeps request history and its detail link available', async () => {
  responseData = { requests: [{ ...row, status: null, request_date: null }] };
  const result = await fetchRecipientRequests(session);
  assert.equal(result[0].request_id, 27);
  assert.equal(result[0].status, null);
  assert.equal(result[0].request_date, null);
});

test('history keeps safe bank contacts and matching marker while dropping private fields', async () => {
  responseData = { requests: [{ ...row, donor_matching_started_at: row.request_date,
    bank_password_hash: 'private-fixture', donor_id: 8, donor_phone: 'private-phone',
    bank: { password_hash: 'nested-private-fixture' } }] };
  const result = (await fetchRecipientRequests(session))[0];
  for (const key of ['bank_id', 'bank_name', 'bank_address', 'bank_phone', 'bank_email']) assert.equal(result[key], row[key]);
  assert.equal(result.donor_matching_started_at, row.request_date);
  assert.ok(!('password_hash' in result)); assert.ok('fulfilled_units' in result);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});
test('legacy unassigned history stays unassigned without invented contacts', async () => {
  responseData = { requests: [{ ...row, bank_id: null, donor_matching_started_at: null,
    bank_name: null, bank_address: null, bank_phone: null, bank_email: null }] };
  const result = (await fetchRecipientRequests(session))[0];
  for (const key of ['bank_id', 'donor_matching_started_at', 'bank_name', 'bank_address', 'bank_phone', 'bank_email']) assert.equal(result[key], null);
});
test('modern public twelve-field history needs no legacy recipient owner field', async () => {
  const { recipient_id, approved_by, ...safe } = row;
  responseData = { requests: [safe] };
  const result = (await fetchRecipientRequests(session))[0];
  assert.ok('fulfilled_units' in result); assert.ok(!('recipient_id' in result));
  assert.equal(Object.hasOwn(result, 'recipient_id'), false);
  assert.equal(result.bank_id, 3);
});