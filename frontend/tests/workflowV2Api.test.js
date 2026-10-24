import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { fetchWorkflowConfig, workflowV2Fields, collectingBanks, collectionFields, ownsProviderRequest } from '../src/services/workflowV2Api.js';
import { fetchWorkflowNotifications, markWorkflowNotificationRead } from '../src/services/workflowNotificationsApi.js';
import { fetchOrganizations, fetchOrganizationCities, fetchOrganizationProfile } from '../src/services/organizationApi.js';
import { fetchRecipientRequests } from '../src/services/recipientDashboardApi.js';
import { fetchDonorMatches, fetchDonorProfile, respondToDonorRequest, updateDonorLocation } from '../src/services/donorDashboardApi.js';
import { fetchBankRequests, processBankRequest, recordActualDonation } from '../src/services/bloodBankDashboardApi.js';
import { fetchProviderQueue } from '../src/services/providerQueueApi.js';

const original = axios.defaults.adapter;
afterEach(() => { axios.defaults.adapter = original; });
const recipient = { token: 'fixture', user: { user_id: 16, user_type: 'recipient' } };
const donor = { token: 'fixture', user: { user_id: 4, user_type: 'donor' } };
const session = { token: 'fixture', user: { user_id: 9, user_type: 'organization' } };
const bank = { organization_id: 9, organization_type: 'Blood Bank', bank_id: 6, state: 'Maharashtra', city: 'Pune' };
const hospital = { organization_id: 11, organization_type: 'Hospital', bank_id: null, state: 'Maharashtra', city: 'Pune' };
const row = { request_id: 12, workflow_version: 2, bank_id: null, organization_id: null,
  admission_hospital_id: 11, admission_hospital_name: 'Admission Hospital', state: 'Maharashtra', city: 'Pune',
  units_required: 5, blood_group: 'A+', urgency_level: 'Emergency', status: 'Processing', request_date: '2026-10-07T06:30:00.000Z',
  fulfilled_units: 2, remaining_units: 3, inventory_units: 1, donation_units: 1, history_available: true,
  contributions: [{ bank_id: 6, bank_name: 'Contributing Bank', source: 'Inventory', units_allocated: 1, allocated_at: null },
    { bank_id: 7, bank_name: 'Second Bank', source: 'Donation', units_allocated: 1, allocated_at: null }],
  accepted_donors: [], eligible_collecting_banks: [{ bank_id: 6, bank_name: 'Contributing Bank', state: 'Maharashtra', city: 'Pune', address: 'Collection address' }] };
function mock(body, inspect = () => {}) {
  axios.defaults.adapter = async config => { inspect(config); return { status: 200, data: body, statusText: 'OK', headers: {}, config }; };
}
test('public capability returns only validated boolean and optional auth header', async () => {
  mock({ workflow_v2_enabled: false, password: 'private' }, config => { assert.equal(config.url.endsWith('/api/requests/workflow-config'), true); assert.equal(config.headers.Authorization, undefined); });
  assert.deepEqual(await fetchWorkflowConfig(null), { workflow_v2_enabled: false });
});
test('authenticated capability forwards current token', async () => {
  mock({ workflow_v2_enabled: true }, config => assert.equal(config.headers.Authorization, 'Bearer fixture'));
  assert.deepEqual(await fetchWorkflowConfig(session), { workflow_v2_enabled: true });
});
for (const value of [undefined, null, 'true', 1]) test('capability fails closed for malformed boolean ' + String(value), async () => {
  mock({ workflow_v2_enabled: value }); await assert.rejects(fetchWorkflowConfig(session));
});
test('safe V2 projection preserves contributions and excludes secrets', () => {
  const projected = workflowV2Fields({ ...row, password_hash: 'private', recipient_phone: 'private' });
  assert.equal(projected.admission_hospital_name, row.admission_hospital_name);
  assert.equal(projected.contributions.length, 2);
  assert.equal(JSON.stringify(projected).includes('private'), false);
  assert.deepEqual(workflowV2Fields({ workflow_version: 1 }), {});
});
for (const override of [{ workflow_version: 3 }, { admission_hospital_id: null }, { admission_hospital_name: '' },
  { bank_id: 6 }, { organization_id: 9 }, { contributions: 'private' },
  { contributions: [{ bank_id: 6, bank_name: 'Bank', source: 'Fake', units_allocated: 2 }] }]) {
  test('V2 request rejects inconsistent metadata ' + JSON.stringify(override), () => assert.throws(() => workflowV2Fields({ ...row, ...override })));
}

test('provider scope distinguishes admission Hospital from same-city Blood Bank', () => {
  assert.equal(ownsProviderRequest(row, session, bank), true);
  assert.equal(ownsProviderRequest(row, session, { ...bank, city: 'Mumbai' }), false);
  assert.equal(ownsProviderRequest(row, { ...session, user: { ...session.user, user_id: 11 } }, hospital), true);
  assert.equal(ownsProviderRequest(row, session, { ...hospital, organization_id: 9 }), false);
});
test('recipient history projects admission Hospital and multi-Bank sources without assignment', async () => {
  mock({ requests: [row] }); const [result] = await fetchRecipientRequests(recipient);
  assert.equal(result.bank_id, null); assert.equal(result.organization_id, null);
  assert.equal(result.admission_hospital_name, 'Admission Hospital'); assert.equal(result.contributions.length, 2);
});
test('Blood Bank list accepts same-city unassigned V2 request', async () => {
  mock({ requests: [row] }); const [result] = await fetchBankRequests(session, undefined, bank);
  assert.equal(result.workflow_version, 2); assert.equal(result.remaining_units, 3);
});
test('Blood Bank list fails closed on another city', async () => {
  mock({ requests: [{ ...row, city: 'Mumbai' }] }); await assert.rejects(fetchBankRequests(session, undefined, bank));
});
test('Hospital with no companion bank can read its admission request', async () => {
  mock({ requests: [row] }); const [result] = await fetchBankRequests({ ...session, user: { user_id: 11, user_type: 'organization' } }, undefined, hospital);
  assert.equal(result.admission_hospital_id, 11);
});
test('Hospital-only directory includes filter and accepts no companion bank', async () => {
  mock({ organizations: [{ organization_id: 11, organization_type: 'Hospital', name: 'Admission Hospital', state: 'Maharashtra', city: 'Pune', bank_id: null, address: null }] }, config => assert.equal(config.params.organization_type, 'Hospital'));
  assert.equal((await fetchOrganizations(recipient, 'Maharashtra', 'Pune', undefined, 'Hospital'))[0].bank_id, null);
});
test('Hospital cities pass the same filter', async () => {
  mock({ cities: ['Pune'] }, config => assert.equal(config.params.organization_type, 'Hospital'));
  assert.deepEqual(await fetchOrganizationCities(recipient, 'Maharashtra', undefined, 'Hospital'), ['Pune']);
});
test('donor receives only safe eligible collecting Blood Banks', async () => {
  mock({ requests: [{ ...row, donor_response: null, password_hash: 'private' }] });
  const [result] = await fetchDonorMatches(donor);
  assert.equal(result.eligible_collecting_banks[0].bank_id, 6); assert.equal(JSON.stringify(result).includes('private'), false);
});
test('cross-city collecting Bank is rejected', () => {
  assert.throws(() => collectingBanks({ ...row, eligible_collecting_banks: [{ ...row.eligible_collecting_banks[0], city: 'Mumbai' }] }));
});
test('V2 accept sends explicit collecting Bank without provider/recipient fields', async () => {
  mock({ request_id: 12, response: 'Accepted', status: 'Processing' }, config => assert.deepEqual(JSON.parse(config.data), { response: 'Accepted', collecting_bank_id: 6 }));
  await respondToDonorRequest(donor, 12, 'Accepted', undefined, 6);
});
test('decline preserves original body even if collecting choice exists', async () => {
  mock({ request_id: 12, response: 'Declined' }, config => assert.deepEqual(JSON.parse(config.data), { response: 'Declined' }));
  await respondToDonorRequest(donor, 12, 'Declined', undefined, 6);
});
test('invalid collecting Bank prevents HTTP call', async () => {
  let called = false; mock({}, () => { called = true; }); await assert.rejects(respondToDonorRequest(donor, 12, 'Accepted', undefined, 0)); assert.equal(called, false);
});

test('V2 queue accepts null bank on same-city request and preserves explicit algorithm order', async () => {
  const queueRow = { ...row, position: 1, priority: 0, waiting_seconds: 100, long_waiting_normal: false, time_warning: null, selection_reason: 'Emergency priority 0. FCFS uses creation time.' };
  mock({ bank_id: 6, organization_id: 9, algorithm: 'Non-preemptive Priority + FCFS', generated_at: '2026-10-08T00:00:00.000Z', long_wait_threshold_seconds: 86400, queue: [queueRow] });
  assert.equal((await fetchProviderQueue(session, undefined, bank)).queue[0].bank_id, null);
});
test('clinical success projects progress and accepts nullable V2 request assignment', async () => {
  mock({ ...row, actor_bank_id: 6, allocated_units: 1 });
  const result = await processBankRequest(session, 12, undefined, '12345678-1234-1234-1234-123456789abc', bank);
  assert.equal(result.remaining_units, 3); assert.equal(result.fulfilled_units, 2);
});
test('record actual donation explicitly chooses inventory path without changing request quantities', async () => {
  mock({ ...row, actor_bank_id: 6, units_donated: 1 }, config => assert.equal(JSON.parse(config.data).accounting_path, 'Inventory'));
  const result = await recordActualDonation(session, 12, 4, 1, '12345678-1234-1234-1234-123456789abc', undefined, bank, 'Inventory');
  assert.equal(result.remaining_units, 3);
});
test('workflow notifications use current-account endpoint and safe projection', async () => {
  mock({ notifications: [{ notification_id: 1, request_id: 12, source: 'workflow', message: 'Request updated', is_read: 0, sent_at: null, password_hash: 'private' }] }, config => assert.equal(config.url.endsWith('/api/notifications/me'), true));
  const result = await fetchWorkflowNotifications(recipient); assert.equal(result.length, 1); assert.equal(JSON.stringify(result).includes('private'), false);
});
test('notification source disambiguates IDs when marking read', async () => {
  mock({ notification_id: 1, is_read: 1 }, config => { assert.equal(config.url.endsWith('/api/notifications/me/1/read'), true); assert.deepEqual(JSON.parse(config.data), { source: 'workflow' }); });
  await markWorkflowNotificationRead(session, 1);
});
test('legacy source is rejected by separate workflow inbox', async () => {
  mock({ notifications: [{ notification_id: 1, source: 'legacy', message: 'Legacy', is_read: 0 }] }); await assert.rejects(fetchWorkflowNotifications(donor));
});


test('moved Bank retains its own contribution history without current supplying eligibility', async () => {
  const oldRequest = { ...row, can_supply: false };
  assert.equal(ownsProviderRequest(oldRequest, session, { ...bank, city: 'Mumbai' }), true);
  assert.equal(ownsProviderRequest({ ...oldRequest, contributions: [] }, session, { ...bank, city: 'Mumbai' }), false);
  mock({ requests: [oldRequest] });
  const [projected] = await fetchBankRequests(session, undefined, { ...bank, city: 'Mumbai' });
  assert.equal(projected.can_supply, false);
});
test('equivalent NFC city forms pass the same location policy', () => {
  assert.equal(ownsProviderRequest({ ...row, city: 'Caf\u00e9' }, session, { ...bank, city: 'Cafe\u0301' }), true);
});
test('moved designated Bank retains a collection response without allocation history', async () => {
  const record = { ...row, can_supply: false, contributions: [], accepted_donors: [{ donor_id: 4, name: 'Donor',
    collecting_bank_id: 6, screening_result: 'Passed', collection_id: 90, units_collected: 1, accounting_path: 'Inventory' }] };
  mock({ requests: [record] });
  const [result] = await fetchBankRequests(session, undefined, { ...bank, city: 'Mumbai' });
  assert.equal(result.can_supply, false); assert.equal(result.accepted_donors[0].collection_id, 90);
});
test('Bank API rejects donor contact rows designated to another bank', async () => {
  mock({ requests: [{ ...row, accepted_donors: [{ donor_id: 4, name: 'Other assigned donor', collecting_bank_id: 7, screening_result: null, phone: 'private' }] }] });
  await assert.rejects(fetchBankRequests(session, undefined, bank), /designated donor scope/);
});
test('recorded collection projection distinguishes inventory from direct request credit', () => {
  assert.deepEqual(collectionFields({ collection_id: 90, units_collected: 2, accounting_path: 'Inventory', screening_result: 'Passed', password_hash: 'private' }),
    { collection_id: 90, units_collected: 2, accounting_path: 'Inventory' });
  assert.deepEqual(collectionFields({}), { collection_id: null, units_collected: null, accounting_path: null });
});
for (const override of [{ collection_id: 0 }, { units_collected: 0 }, { accounting_path: 'Both' }, { screening_result: 'Failed' }, { collection_id: null }]) {
  test('malformed collection metadata is rejected ' + JSON.stringify(override), () => {
    assert.throws(() => collectionFields({ collection_id: 90, units_collected: 2, accounting_path: 'DirectRequest', screening_result: 'Passed', ...override }));
  });
}
test('direct request collection sends its accounting path explicitly', async () => {
  mock({ ...row, actor_bank_id: 6, units_donated: 1 }, config => assert.equal(JSON.parse(config.data).accounting_path, 'DirectRequest'));
  await recordActualDonation(session, 12, 4, 1, '12345678-1234-1234-1234-123456789abc', undefined, bank, 'DirectRequest');
});

