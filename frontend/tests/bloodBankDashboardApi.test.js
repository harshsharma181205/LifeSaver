import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  fetchBloodBanks, fetchBankProfile, fetchBankInventory, fetchBankRequests,
  processBankRequest, updateBankInventory, bankError,
} from '../src/services/bloodBankDashboardApi.js';
import { API_BASE_URL } from '../src/config/api.js';

const adapter = axios.defaults.adapter;
const session = { token: 'memory-only-bank-token', user: { user_id: 3, user_type: 'blood_bank' } };
const profile = { user_id: 3, user_type: 'blood_bank', bank_name: 'Central Blood Bank',
  email: 'central@example.test', phone: '02012345678', address: 'Pune', password_hash: 'private' };
const stock = { inventory_id: 4, bank_id: 3, blood_group: 'A+', units_available: 5, updated_at: null, password_hash: 'private' };
const request = { request_id: 27, bank_id: 3, blood_group: 'A+', units_required: 3, status: 'Pending',
  urgency_level: 'Emergency', request_date: '2026-10-07T06:30:00.000Z', donor_matching_started_at: null,
  recipient_id: 16, password_hash: 'private' };
let data, calls;
beforeEach(() => {
  data = null; calls = [];
  // Memory adapter only: MySQL aur real backend ko touch nahi karenge.
  axios.defaults.adapter = async config => {
    calls.push(config);
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
});
after(() => { axios.defaults.adapter = adapter; });
function called(endpoint, method = 'get') {
  assert.equal(calls[0].url, API_BASE_URL + endpoint);
  assert.equal(calls[0].method, method);
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + session.token);
  assert.equal(calls[0].timeout, 15000);
  assert.equal(calls[0].params, undefined);
}
test('directory uses real catalog with JWT and safe public bank fields', async () => {
  data = { blood_banks: [{ ...profile, bank_id: 3 }] };
  const result = await fetchBloodBanks(session);
  called('/api/blood-banks');
  assert.deepEqual(result, [{ bank_id: 3, bank_name: profile.bank_name, email: profile.email,
    phone: profile.phone, address: profile.address }]);
  data = { blood_banks: [] };
  assert.deepEqual(await fetchBloodBanks(session), []);
});
test('profile verifies own bank identity and removes secrets', async () => {
  data = profile;
  const result = await fetchBankProfile(session);
  called('/api/auth/me');
  assert.equal(result.bank_name, profile.bank_name);
  assert.ok(!JSON.stringify(result).includes('private'));
  for (const value of [{ ...profile, user_id: 7 }, { ...profile, user_type: 'donor' }, null]) {
    data = value; await assert.rejects(fetchBankProfile(session), /Unexpected/);
  }
});
test('inventory remains real rows and missing groups are not inserted', async () => {
  data = { bank_id: 3, inventory: [stock] };
  assert.deepEqual(await fetchBankInventory(session),
    [{ blood_group: 'A+', units_available: 5, updated_at: null, version: 0 }]);
  called('/api/inventory/3');
  assert.equal(calls.length, 1);
  data = { bank_id: 3, inventory: [] };
  assert.deepEqual(await fetchBankInventory(session), []);
  assert.ok(calls.every(call => call.method === 'get'));
});
for (const bad of [{ ...stock, bank_id: 7 }, { ...stock, units_available: -1 },
  { ...stock, units_available: 1.5 }, { ...stock, blood_group: 'unknown' }]) {
  test('inventory rejects invalid or cross-bank row: ' + JSON.stringify(bad), async () => {
    data = { bank_id: 3, inventory: [bad] };
    await assert.rejects(fetchBankInventory(session), /Unexpected/);
  });
}
test('stock update uses JWT bank URL, encoded group and exact validated body', async () => {
  data = { message: 'Updated', bank_id: 3, blood_group: 'A+', units_available: 15 };
  assert.deepEqual(await updateBankInventory(session, 'A+', 15), { blood_group: 'A+', units_available: 15, version: 0 });
  called('/api/inventory/3/A%2B', 'put');
  assert.deepEqual(JSON.parse(calls[0].data), { units_available: 15, expected_version: 0 });
});
for (const [group, units] of [['unknown', 5], ['A+', -1], ['A+', 1.5], ['A+', '5'], ['A+', 2147483648]]) {
  test('invalid stock updates never send API call: ' + group + '/' + units, async () => {
    await assert.rejects(updateBankInventory(session, group, units));
    assert.equal(calls.length, 0);
  });
}
test('bank requests retain safe fields and prioritize emergency then oldest with null date last', async () => {
  data = { requests: [{ ...request, request_id: 29, urgency_level: 'Normal' },
    { ...request, request_id: 28, request_date: null }, request,
    { ...request, request_id: 26, request_date: '2026-10-06T06:30:00.000Z' }] };
  const rows = await fetchBankRequests(session);
  called('/api/requests');
  assert.deepEqual(rows.map(row => row.request_id), [26, 27, 28, 29]);
  assert.ok(!JSON.stringify(rows).includes('private'));
  assert.ok(!('recipient_id' in rows[0]));
  data = { requests: [{ ...request, bank_id: 7 }] };
  await assert.rejects(fetchBankRequests(session), /Unexpected/);
});
for (const result of [
  { request_id: 27, bank_id: 3, source: 'blood_bank', status: 'Fulfilled', allocated_units: 3 },
  { request_id: 27, bank_id: 3, source: 'individual_donors', status: 'Pending', notified_count: 2 },
]) {
  test('processing validates actual bank result: ' + result.source, async () => {
    data = { ...result, private_details: 'private' };
    const answer = await processBankRequest(session, 27);
    called('/api/allocations/process/27', 'post');
    assert.match(JSON.parse(calls[0].data).operation_key, /^[a-f0-9-]{36}$/i);
    assert.equal(answer.source, result.source);
    assert.ok(!JSON.stringify(answer).includes('private'));
    for (const mismatch of [{ ...result, bank_id: 7 }, { ...result, request_id: 28 }]) {
      data = mismatch; await assert.rejects(processBankRequest(session, 27), /Unexpected/);
    }
  });
}
for (const role of ['recipient', 'donor']) {
  test('wrong role cannot call bank APIs: ' + role, async () => {
    const other = { ...session, user: { user_id: 3, user_type: role } };
    await assert.rejects(fetchBankProfile(other));
    await assert.rejects(fetchBankInventory(other));
    await assert.rejects(fetchBankRequests(other));
    await assert.rejects(updateBankInventory(other, 'A+', 5));
    await assert.rejects(processBankRequest(other, 27));
    assert.equal(calls.length, 0);
  });
}
test('safe errors do not expose API SQL or secrets', () => {
  for (const status of [400, 403, 404, 409, 500]) {
    const message = bankError({ response: { status, data: { message: 'Private SQL secrets' } } });
    assert.ok(!message.includes('Private'));
    assert.ok(message.length > 10);
  }
});
