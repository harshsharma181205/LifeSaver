import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { API_BASE_URL } from '../src/config/api.js';
import { indiaStates } from '../src/data/indiaStates.js';
import { fetchOrganizationProfile, fetchOrganizationCities, fetchOrganizations,
  updateOrganizationLocation, organizationError } from '../src/services/organizationApi.js';

const originalAdapter = axios.defaults.adapter;
const session = { token: 'fixture-organization-token', user: { user_id: 11, user_type: 'organization' } };
const legacy = { token: 'fixture-bank-token', user: { user_id: 3, user_type: 'blood_bank' } };
const profile = { user_id: 11, user_type: 'organization', organization_id: 11,
  organization_type: 'Hospital', name: 'Registered Hospital', bank_id: 3,
  state: 'Uttar Pradesh', city: 'Ghaziabad', address: 'Registered address',
  phone: '9876543210', email: 'hospital@example.test' };
let data, calls;
beforeEach(() => {
  data = profile; calls = [];
  axios.defaults.adapter = async config => {
    calls.push(config);
    return { data: typeof data === 'function' ? data(config) : data,
      status: 200, statusText: 'OK', headers: {}, config };
  };
});
after(() => { axios.defaults.adapter = originalAdapter; });

test('Indian locations contain 36 distinct states and union territories without organization data', () => {
  assert.equal(indiaStates.length, 36);
  assert.equal(new Set(indiaStates).size, 36);
  for (const state of ['Delhi', 'Ladakh', 'Jammu and Kashmir',
    'Dadra and Nagar Haveli and Daman and Diu', 'Uttar Pradesh']) assert.ok(indiaStates.includes(state));
});
test('organization profile keeps organization and operational bank identities distinct and strips secrets', async () => {
  data = { ...profile, password: 'private-password', password_hash: 'private-hash', admin_id: 8 };
  const result = await fetchOrganizationProfile(session);
  assert.equal(result.user_id, 11);
  assert.equal(result.organization_id, 11);
  assert.equal(result.bank_id, 3);
  assert.equal(calls[0].url, API_BASE_URL + '/api/auth/me');
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + session.token);
  assert.ok(!JSON.stringify(result).includes('private'));
});
test('legacy bank profile preserves bank JWT identity and permits missing location completion', async () => {
  data = { user_id: 3, user_type: 'blood_bank', bank_name: 'Existing Bank',
    organization_id: 11, bank_id: 3, state: null, city: null, address: null, phone: null, email: null };
  const result = await fetchOrganizationProfile(legacy);
  assert.equal(result.user_id, 3);
  assert.equal(result.organization_id, 11);
  assert.equal(result.name, 'Existing Bank');
  assert.equal(result.organization_type, 'Blood Bank');
  assert.equal(result.state, null);
});
test('NGO profile has no provider bank and conflicting or cross-account identity is rejected', async () => {
  data = { ...profile, organization_type: 'NGO', bank_id: null };
  assert.equal((await fetchOrganizationProfile(session)).bank_id, null);
  for (const invalid of [{ ...profile, user_id: 12 }, { ...profile, organization_id: 12 },
    { ...profile, user_type: 'blood_bank' }, { ...profile, organization_type: 'NGO' }, null]) {
    data = invalid;
    await assert.rejects(fetchOrganizationProfile(session), /Unexpected/);
  }
});
test('provider directory uses dependent state and city parameters and drops private account fields', async () => {
  data = { organizations: [{ ...profile, user_id: 11, user_type: 'organization', password_hash: 'private' }] };
  const result = await fetchOrganizations(session, 'Uttar Pradesh', ' Ghaziabad ');
  assert.deepEqual(calls[0].params, { state: 'Uttar Pradesh', city: 'Ghaziabad' });
  assert.equal(calls[0].url, API_BASE_URL + '/api/organizations');
  assert.equal(result[0].organization_id, 11);
  for (const key of ['phone', 'email', 'password_hash', 'user_id', 'user_type']) assert.equal(key in result[0], false);
  data = { organizations: [] };
  assert.deepEqual(await fetchOrganizations(session, 'Uttar Pradesh', 'Ghaziabad'), []);
});
test('directory rejects NGO, another city/state, missing provider links and duplicate identities', async () => {
  for (const row of [{ ...profile, organization_type: 'NGO', bank_id: null },
    { ...profile, city: 'Pune' }, { ...profile, state: 'Maharashtra' }, { ...profile, bank_id: null }]) {
    data = { organizations: [row] };
    await assert.rejects(fetchOrganizations(session, 'Uttar Pradesh', 'Ghaziabad'), /Unexpected/);
  }
  data = { organizations: [profile, profile] };
  await assert.rejects(fetchOrganizations(session, 'Uttar Pradesh', 'Ghaziabad'), /Unexpected/);
});
test('city options come from the state-specific response and invalid inputs make no HTTP calls', async () => {
  data = { cities: ['Ghaziabad', 'Lucknow'] };
  assert.deepEqual(await fetchOrganizationCities(session, 'Uttar Pradesh'), data.cities);
  assert.deepEqual(calls[0].params, { state: 'Uttar Pradesh' });
  data = { cities: [] };
  assert.deepEqual(await fetchOrganizationCities(session, 'Uttar Pradesh'), []);
  data = { cities: [''] };
  await assert.rejects(fetchOrganizationCities(session, 'Uttar Pradesh'), /Unexpected/);
  const before = calls.length;
  await assert.rejects(fetchOrganizationCities(session, 'invalid'));
  await assert.rejects(fetchOrganizations(session, 'Uttar Pradesh', ''));
  await assert.rejects(fetchOrganizationProfile({ ...session, user: { user_id: 11, user_type: 'donor' } }));
  assert.equal(calls.length, before);
});
test('location update sends only canonical location then reloads JWT-facing legacy identity', async () => {
  data = config => config.method === 'put' ? { organization: { ...profile, user_id: undefined } }
    : { ...profile, user_id: 3, user_type: 'blood_bank', bank_name: 'Existing Bank' };
  const result = await updateOrganizationLocation(legacy, { state: 'Uttar Pradesh', city: '  Ghaziabad   City  ', ignored: 'private' });
  assert.equal(calls[0].method, 'put');
  assert.equal(calls[0].url, API_BASE_URL + '/api/organizations/me/location');
  assert.deepEqual(JSON.parse(calls[0].data), { state: 'Uttar Pradesh', city: 'Ghaziabad City' });
  assert.equal(calls[1].url, API_BASE_URL + '/api/auth/me');
  assert.equal(result.user_id, 3);
  assert.equal(result.organization_id, 11);
});
test('nonorganization location changes are rejected before HTTP and cancellation is forwarded', async () => {
  await assert.rejects(updateOrganizationLocation({ ...session, user: { user_type: 'recipient', user_id: 11 } },
    { state: 'Uttar Pradesh', city: 'Ghaziabad' }));
  assert.equal(calls.length, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchOrganizationProfile(session, controller.signal), axios.isCancel);
  assert.equal(calls.length, 0);
});
for (const status of [400, 401, 403, 404, 409, 500]) test('safe organization error for HTTP ' + status, () => {
  const message = organizationError({ response: { status, data: { message: 'Private SQL details' } } });
  assert.ok(message.length > 10);
  assert.ok(!message.includes('Private SQL'));
});
