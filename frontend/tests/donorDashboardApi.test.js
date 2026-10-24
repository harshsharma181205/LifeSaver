import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { API_BASE_URL } from '../src/config/api.js';
import { fetchDonorProfile, fetchDonorMatches, fetchDonorNotifications,
  markDonorNotificationRead, updateDonorAvailability, respondToDonorRequest, donorApiError } from '../src/services/donorDashboardApi.js';

const originalAdapter = axios.defaults.adapter;
const session = { token: 'memory-only-token', user: { user_id: 16, user_type: 'donor' } };
const profile = { user_id: 16, user_type: 'donor', name: ' Gaurav ', blood_group: 'A+',
  location: ' Pune ', is_available: 1, phone: 'private', password_hash: 'private' };
const request = { request_id: 27, blood_group: 'A+', units_required: 1, urgency_level: 'Emergency',
  status: 'Pending', request_date: '2026-10-07T06:30:00.000Z', bank_id: 1, bank_name: 'Selected Bank', bank_address: 'Pune', bank_phone: 'public', bank_email: 'bank@example.org', donor_response: null, recipient_id: 99, phone: 'private' };
const notification = { notification_id: 8, donor_id: 16, recipient_id: null, message: 'Account update',
  is_read: 0, sent_at: null, channel: 'InApp', password_hash: 'private' };
let data, calls, failure;
beforeEach(() => {
  calls = []; data = null; failure = null;
  // Memory adapter se real backend aur database touch nahi honge.
  axios.defaults.adapter = async (config) => {
    calls.push(config);
    if (failure) throw failure;
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});
after(() => { axios.defaults.adapter = originalAdapter; });
function checkCall(endpoint, signal, method = 'get') {
  assert.equal(calls[0].url, API_BASE_URL + endpoint);
  assert.equal(calls[0].method, method);
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + session.token);
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[0].timeout, 15000);
  assert.equal(calls[0].params, undefined);
}
test('profile loads JWT owner from shared URL and retains only safe display fields', async () => {
  data = profile;
  const signal = new AbortController().signal;
  assert.deepEqual(await fetchDonorProfile(session, signal),
    { name: 'Gaurav', blood_group: 'A+', location: 'Pune', state: '', city: '', is_available: 1 });
  checkCall('/api/auth/me', signal);
});
for (const [value, expected] of [[0, 0], [false, 0], [true, 1], [1, 1], [null, null], [2, null], ['1', null]]) {
  test('availability preserves known self-report and unknown state: ' + value, async () => {
    data = { ...profile, is_available: value };
    assert.equal((await fetchDonorProfile(session)).is_available, expected);
  });
}
test('missing display fields stay missing instead of inventing name/location/group', async () => {
  data = { user_id: 16, user_type: 'donor' };
  assert.deepEqual(await fetchDonorProfile(session), { name: '', blood_group: '', location: '', state: '', city: '', is_available: null });
});
for (const value of [null, {}, { ...profile, user_id: 17 }, { ...profile, user_type: 'recipient' }]) {
  test('profile rejects wrong owner or malformed identity: ' + JSON.stringify(value), async () => {
    data = value; await assert.rejects(fetchDonorProfile(session), /Unexpected profile/);
  });
}
test('matching uses secure backend endpoint, no client filters and safe six-field cards', async () => {
  data = { requests: [request, { ...request, request_id: 28, blood_group: 'O-', urgency_level: 'Normal' }] };
  const signal = new AbortController().signal;
  const result = await fetchDonorMatches(session, signal);
  checkCall('/api/donors/me/matching-requests', signal);
  assert.ok(['request_id','blood_group','units_required','status','fulfilled_units','remaining_units','city','state','bank_name','donor_response','recipient'].every(field => field in result[0]));
  assert.deepEqual(result.map(item => item.request_id), [27, 28], 'No independent React blood-group filter');
  assert.ok(!JSON.stringify(result).includes('private'));
});
for (const value of [null, {}, { requests: {} }, { requests: [null] },
  { requests: [{ ...request, request_id: 0 }] }, { requests: [{ ...request, blood_group: 'bad' }] },
  { requests: [{ ...request, units_required: 1.5 }] }, { requests: [{ ...request, units_required: 0 }] },
  { requests: [{ ...request, urgency_level: null }] }, { requests: [{ ...request, status: 'Accepted' }] }]) {
  test('malformed matching response is rejected: ' + JSON.stringify(value), async () => {
    data = value; await assert.rejects(fetchDonorMatches(session), /Unexpected matching/);
  });
}
test('matching successful empty state remains empty', async () => {
  data = { requests: [] }; assert.deepEqual(await fetchDonorMatches(session), []);
});
test('notifications use session owner, JWT and safe display fields', async () => {
  data = { user_id: 16, user_type: 'donor', notifications: [notification] };
  const signal = new AbortController().signal;
  assert.deepEqual(await fetchDonorNotifications(session, signal),
    [{ notification_id: 8, message: 'Account update', is_read: 0, sent_at: null }]);
  checkCall('/api/notifications/donor/16', signal);
});
for (const value of [null, {}, { user_id: 17, user_type: 'donor', notifications: [] },
  { user_id: 16, user_type: 'recipient', notifications: [] },
  ...[{ ...notification, donor_id: 17 }, { ...notification, recipient_id: 4 },
    { ...notification, is_read: 2 }, { ...notification, message: null }, { ...notification, notification_id: -1 }]
    .map(item => ({ user_id: 16, user_type: 'donor', notifications: [item] }))]) {
  test('malformed or foreign notifications are rejected: ' + JSON.stringify(value), async () => {
    data = value; await assert.rejects(fetchDonorNotifications(session), /Unexpected notification/);
  });
}
test('read and successful empty notifications stay distinct', async () => {
  data = { user_id: 16, user_type: 'donor', notifications: [{ ...notification, is_read: 1 }] };
  assert.equal((await fetchDonorNotifications(session))[0].is_read, 1);
  data.notifications = [];
  assert.deepEqual(await fetchDonorNotifications(session), []);
});
test('mark-read uses PATCH, empty body, token and confirmed response', async () => {
  data = { notification_id: 8, is_read: 1 };
  const signal = new AbortController().signal;
  assert.deepEqual(await markDonorNotificationRead(session, 8, signal), data);
  checkCall('/api/notifications/8/read', signal, 'patch');
  assert.deepEqual(JSON.parse(calls[0].data), {});
});
for (const id of [0, -1, 1.5, '8']) {
  test('invalid read ID makes no API call: ' + id, async () => {
    await assert.rejects(markDonorNotificationRead(session, id), /Invalid notification/);
    assert.equal(calls.length, 0);
  });
}
for (const value of [null, {}, { notification_id: 9, is_read: 1 }, { notification_id: 8, is_read: 0 }]) {
  test('read mutation rejects unconfirmed success: ' + JSON.stringify(value), async () => {
    data = value; await assert.rejects(markDonorNotificationRead(session, 8), /Unexpected read/);
  });
}
for (const status of [400, 401, 403, 404, 500]) {
  test('all calls preserve HTTP ' + status + ' while UI messages stay safe', async () => {
    failure = new axios.AxiosError('Private SQL details', 'ERR_BAD_RESPONSE', {}, {}, { status, data: { message: 'Private SQL details' } });
    for (const call of [fetchDonorProfile, fetchDonorMatches, fetchDonorNotifications]) {
      await assert.rejects(call(session), error => error.response.status === status);
    }
    await assert.rejects(markDonorNotificationRead(session, 8), error => error.response.status === status);
    assert.ok(!donorApiError(failure).includes('Private SQL'));
  });
}
test('network failure remains an error with useful safe text', async () => {
  failure = new axios.AxiosError('Private network detail', 'ERR_NETWORK');
  await assert.rejects(fetchDonorMatches(session));
  assert.match(donorApiError(failure), /Unable to reach the backend/);
});
test('aborted account loads and mutations never reach API adapter', async () => {
  const controller = new AbortController(); controller.abort();
  for (const call of [fetchDonorProfile, fetchDonorMatches, fetchDonorNotifications]) {
    await assert.rejects(call(session, controller.signal), axios.isCancel);
  }
  await assert.rejects(markDonorNotificationRead(session, 8, controller.signal), axios.isCancel);
  assert.equal(calls.length, 0);
});

for (const value of [true, false]) test('availability PATCH uses only boolean value and JWT owner: ' + value, async () => {
  data = { is_available: Number(value) };
  const signal = new AbortController().signal;
  assert.equal(await updateDonorAvailability(session, value, signal), Number(value));
  checkCall('/api/donors/me/availability', signal, 'patch');
  assert.deepEqual(JSON.parse(calls[0].data), { is_available: value });
});
for (const value of [null, 0, 1, 'true', {}]) test('invalid availability cannot be sent: ' + JSON.stringify(value), async () => {
  await assert.rejects(updateDonorAvailability(session, value)); assert.equal(calls.length, 0);
});
test('availability success is checked against supplied value', async () => {
  data = { is_available: 0 }; await assert.rejects(updateDonorAvailability(session, true), /Unexpected/);
});
for (const response of ['Accepted', 'Declined']) test('donor response posts only confirmed response with JWT: ' + response, async () => {
  data = { request_id: 27, response, password_hash: 'private' };
  const signal = new AbortController().signal;
  assert.deepEqual(await respondToDonorRequest(session, 27, response, signal), { request_id: 27, response, status: response === 'Accepted' ? 'Processing' : undefined });
  checkCall('/api/donors/me/requests/27/response', signal, 'post');
  assert.deepEqual(JSON.parse(calls[0].data), { response });
});
for (const [id, response] of [[0, 'Accepted'], [2147483648, 'Accepted'], ['27', 'Accepted'], [27, 'Accept'], [27, 'Donated']]) test('invalid donor action cannot be sent: ' + id + '/' + response, async () => {
  await assert.rejects(respondToDonorRequest(session, id, response)); assert.equal(calls.length, 0);
});
for (const value of [null, { request_id: 28, response: 'Accepted' }, { request_id: 27, response: 'Declined' }]) test('donor response success requires exact confirmation ' + JSON.stringify(value), async () => {
  data = value; await assert.rejects(respondToDonorRequest(session, 27, 'Accepted'), /Unexpected/);
});
test('matching profile retains accepted state and public selected bank fields', async () => {
  data = { requests: [{ ...request, donor_response: 'Accepted' }] };
  const result = await fetchDonorMatches(session);
  assert.equal(result[0].donor_response, 'Accepted'); assert.equal(result[0].bank_name, 'Selected Bank');
  assert.ok(!JSON.stringify(result).includes('recipient_id')); assert.ok(!JSON.stringify(result).includes('private'));
});
for (const value of [{ bank_id: null }, { bank_name: null }, { donor_response: 'Declined' }]) test('matching rejects invalid bank or declined opportunity ' + JSON.stringify(value), async () => {
  data = { requests: [{ ...request, ...value }] }; await assert.rejects(fetchDonorMatches(session), /Unexpected/);
});
for (const status of [400, 401, 403, 404, 409, 500]) test('donor actions preserve safe HTTP error ' + status, async () => {
  failure = new axios.AxiosError('Private SQL', 'ERR_BAD_RESPONSE', {}, {}, { status, data: { message: 'Private SQL' } });
  await assert.rejects(updateDonorAvailability(session, true), error => error.response.status === status);
  await assert.rejects(respondToDonorRequest(session, 27, 'Accepted'), error => error.response.status === status);
  assert.ok(!donorApiError(failure).includes('Private'));
});
test('stale donor action cancellation prevents API calls', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(updateDonorAvailability(session, true, controller.signal), axios.isCancel);
  await assert.rejects(respondToDonorRequest(session, 27, 'Accepted', controller.signal), axios.isCancel); assert.equal(calls.length, 0);
});

const recipientDetails = { name: 'Recipient account', age: 28, gender: 'Other', phone: '9876543201',
  email: 'recipient@example.invalid', password: 'discarded', password_hash: 'discarded' };
for (const [label, progress] of [
  ['partially fulfilled', { units_required: 10, status: 'Processing', fulfilled_units: 5, remaining_units: 5, inventory_units: 3, donation_units: 2, history_available: true }],
  ['completed', { units_required: 7, status: 'Fulfilled', fulfilled_units: 7, remaining_units: 0, inventory_units: 4, donation_units: 3, history_available: true }],
  ['historical without allocation records', { units_required: 12, status: 'Fulfilled', fulfilled_units: 12, remaining_units: 0, inventory_units: 0, donation_units: 0, history_available: false }],
]) {
  test('reopened accepted ' + label + ' request preserves numeric fulfillment and source history', async () => {
    data = { requests: [{ ...request, ...progress, donor_response: 'Accepted', screening_result: 'Passed',
      recipient: recipientDetails, allocation_count: 2, password_hash: 'discarded' }] };
    for (let reopen = 0; reopen < 2; reopen++) {
      const [result] = await fetchDonorMatches(session);
      for (const field of ['units_required', 'status', 'fulfilled_units', 'remaining_units', 'inventory_units', 'donation_units', 'history_available']) {
        assert.equal(result[field], progress[field], field + ' must survive a dashboard reload');
      }
      for (const field of ['fulfilled_units', 'remaining_units', 'inventory_units', 'donation_units']) assert.equal(Number.isInteger(result[field]), true);
      assert.deepEqual(result.recipient, { name: recipientDetails.name, age: 28, gender: 'Other', phone: recipientDetails.phone, email: recipientDetails.email });
      assert.equal(Object.hasOwn(result, 'allocation_count'), false);
      assert.equal(Object.hasOwn(result, 'password_hash'), false);
      assert.equal(Object.hasOwn(result.recipient, 'password_hash'), false);
      assert.equal(Object.hasOwn(result.recipient, 'password'), false);
    }
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.url === API_BASE_URL + '/api/donors/me/matching-requests'));
  });
}

test('fulfillment source details never expose private recipient fields before acceptance', async () => {
  data = { requests: [{ ...request, units_required: 7, status: 'Processing', fulfilled_units: 3, remaining_units: 4,
    inventory_units: 2, donation_units: 1, history_available: true, donor_response: null,
    recipient: recipientDetails, recipient_phone: recipientDetails.phone, recipient_email: recipientDetails.email }] };
  const [result] = await fetchDonorMatches(session);
  assert.deepEqual([result.fulfilled_units, result.remaining_units, result.inventory_units, result.donation_units], [3, 4, 2, 1]);
  assert.equal(result.recipient, null);
  assert.equal(Object.hasOwn(result, 'recipient_phone'), false);
  assert.equal(Object.hasOwn(result, 'recipient_email'), false);
  assert.ok(!JSON.stringify(result).includes(recipientDetails.phone));
  assert.ok(!JSON.stringify(result).includes(recipientDetails.email));
});

test('Failed-screening response retains fulfillment history without restoring absent recipient contacts', async () => {
  data = { requests: [{ ...request, units_required: 6, status: 'Processing', fulfilled_units: 2, remaining_units: 4,
    inventory_units: 2, donation_units: 0, history_available: true, donor_response: 'Accepted', screening_result: 'Failed' }] };
  const [result] = await fetchDonorMatches(session);
  assert.equal(result.screening_result, 'Failed');
  assert.equal(result.recipient, null);
  assert.deepEqual([result.fulfilled_units, result.remaining_units, result.inventory_units, result.donation_units], [2, 4, 2, 0]);
});

for (const invalid of [
  { inventory_units: '2', donation_units: 1 },
  { inventory_units: 2, donation_units: '1' },
  { inventory_units: -1, donation_units: 4 },
  { inventory_units: 2, donation_units: 2 },
  { remaining_units: 8 },
]) {
  test('reopened fulfillment rejects inconsistent source quantities: ' + JSON.stringify(invalid), async () => {
    data = { requests: [{ ...request, units_required: 7, status: 'Processing', donor_response: 'Accepted',
      fulfilled_units: 3, remaining_units: 4, inventory_units: 2, donation_units: 1, history_available: true, ...invalid }] };
    await assert.rejects(fetchDonorMatches(session), /Unexpected fulfillment quantities/);
  });
}

const v2Request = { ...request, workflow_version: 2, admission_hospital_id: 12,
  admission_hospital_name: 'Admission Hospital', bank_id: null, organization_id: null,
  state: 'Maharashtra', city: 'Pune', units_required: 5, fulfilled_units: 2,
  remaining_units: 3, inventory_units: 2, donation_units: 0, history_available: true,
  eligible_collecting_banks: [{ bank_id: 7, bank_name: 'Collecting Bank', state: 'Maharashtra', city: 'Pune' }] };
for (const units of [0, 2, 3]) test('V2 uncovered donor units stay separate from total remaining: ' + units, async () => {
  data = { requests: [{ ...v2Request, donor_units_needed: units }] };
  const [result] = await fetchDonorMatches(session);
  assert.equal(result.donor_units_needed, units);
  assert.equal(result.remaining_units, 3);
  assert.equal(result.fulfilled_units, 2);
  assert.equal(result.eligible_collecting_banks[0].bank_id, 7);
});
for (const units of [-1, 1.5, '2', 4, null]) test('V2 rejects invalid uncovered donor units: ' + JSON.stringify(units), async () => {
  data = { requests: [{ ...v2Request, donor_units_needed: units }] };
  await assert.rejects(fetchDonorMatches(session), /Unexpected uncovered donor units/);
});
test('older V2 responses without uncovered units stay compatible', async () => {
  data = { requests: [v2Request] };
  const [result] = await fetchDonorMatches(session);
  assert.equal(Object.hasOwn(result, 'donor_units_needed'), false);
  assert.equal(result.remaining_units, 3);
});
test('V1 responses do not acquire a donor-shortage field', async () => {
  data = { requests: [{ ...request, donor_units_needed: 1 }] };
  const [result] = await fetchDonorMatches(session);
  assert.equal(Object.hasOwn(result, 'donor_units_needed'), false);
});
