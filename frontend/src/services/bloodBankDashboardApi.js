import { ownsProviderRequest } from './workflowV2Api.js';
import axios from 'axios';
import { API_BASE_URL } from '../config/api.js';
import { formatRequestDate } from './recipientDashboardApi.js';
import { lifecycleRequestFields, newOperationKey, validOperationKey } from './lifecycleFields.js';

export const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
export { formatRequestDate };
export const maximumUnits = 2147483647;
const statuses = ['Pending', 'Processing', 'Fulfilled', 'Cancelled'];
function options(session, signal) {
  return { headers: { Authorization: 'Bearer ' + session.token }, timeout: 15000, signal };
}
function clinicalAccount(session, provider) {
  const id = session?.user?.user_id;
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid organization session.');
  if (session.user.user_type === 'blood_bank') return;
  if (session.user.user_type !== 'organization' || provider?.organization_id !== id
    || !['Hospital', 'Blood Bank'].includes(provider.organization_type)) throw new Error('Invalid organization session.');
}
function bankId(session, provider) {
  clinicalAccount(session, provider);
  const id = session.user.user_type === 'blood_bank' ? session.user.user_id : provider.bank_id;
  if (session.user.user_type === 'organization' && provider.organization_type !== 'Blood Bank') throw new Error('Only blood banks manage inventory.');
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid blood bank identity.');
  return id;
}
function requestTime(value) {
  const time = value == null ? NaN : Date.parse(value);
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}
function contactFields(row) {
  if (typeof row?.bank_name !== 'string' || !row.bank_name.trim()
    || ['email', 'phone', 'address'].some(field => row[field] !== null && typeof row[field] !== 'string')) {
    throw new Error('Unexpected blood bank response.');
  }
  return { bank_name: row.bank_name, email: row.email, phone: row.phone, address: row.address };
}
export async function fetchBloodBanks(session, signal) {
  const response = await axios.get(API_BASE_URL + '/api/blood-banks', options(session, signal));
  if (!Array.isArray(response.data?.blood_banks)) throw new Error('Unexpected blood bank directory.');
  return response.data.blood_banks.map(row => {
    if (!Number.isSafeInteger(row?.bank_id) || row.bank_id < 1) throw new Error('Unexpected blood bank directory.');
    return { bank_id: row.bank_id, ...contactFields(row) };
  });
}
export async function fetchBankProfile(session, signal) {
  const id = bankId(session);
  const response = await axios.get(API_BASE_URL + '/api/auth/me', options(session, signal));
  if (response.data?.user_id !== id || response.data?.user_type !== 'blood_bank') throw new Error('Unexpected blood bank profile.');
  const row=response.data;
  return { user_id: id, user_type: 'blood_bank', ...contactFields(row), organization_id: row.organization_id ?? null,
    organization_type: 'Blood Bank', state: row.state ?? '', city: row.city ?? '' };
}
function validVersion(value) {
  return (Number.isSafeInteger(value) && value >= 0) || (typeof value === 'string' && /^\d{1,20}$/.test(value));
}
export async function fetchBankInventory(session, signal, provider) {
  const id = bankId(session, provider);
  const response = await axios.get(API_BASE_URL + '/api/inventory/' + id, options(session, signal));
  if (response.data?.bank_id !== id || !Array.isArray(response.data.inventory)) throw new Error('Unexpected inventory response.');
  const seen = new Set();
  return response.data.inventory.map(row => {
    if (row?.bank_id !== id || !bloodGroups.includes(row.blood_group) || seen.has(row.blood_group)
      || !Number.isInteger(row.units_available) || row.units_available < 0 || row.units_available > maximumUnits
      || (row.updated_at !== null && typeof row.updated_at !== 'string') || !validVersion(row.version ?? 0)) {
      throw new Error('Unexpected inventory response.');
    }
    seen.add(row.blood_group);
    return { blood_group: row.blood_group, units_available: row.units_available, updated_at: row.updated_at, version: row.version ?? 0 };
  });
}
export async function updateBankInventory(session, group, units, signal, expectedVersion = 0, provider) {
  const id = bankId(session, provider);
  if (!bloodGroups.includes(group) || !Number.isInteger(units) || units < 0 || units > maximumUnits || !validVersion(expectedVersion)) {
    throw new Error('Enter a non-negative whole number of units.');
  }
  const response = await axios.put(API_BASE_URL + '/api/inventory/' + id + '/' + encodeURIComponent(group),
    { units_available: units, expected_version: expectedVersion }, options(session, signal));
  if (response.data?.bank_id !== id || response.data?.blood_group !== group || response.data?.units_available !== units) throw new Error('Unexpected inventory update response.');
  return { blood_group: group, units_available: units, version: response.data.version ?? expectedVersion };
}
export async function fetchBankRequests(session, signal, provider) {
  clinicalAccount(session, provider);
  const response = await axios.get(API_BASE_URL + '/api/requests', options(session, signal));
  if (!Array.isArray(response.data?.requests)) throw new Error('Unexpected bank requests response.');
  const resolvedProvider = provider ?? (session.user.user_type === 'blood_bank' && response.data.requests.some(row => row.workflow_version === 2) ? await fetchBankProfile(session, signal) : undefined);
  const rows = response.data.requests.map(row => {
    const owned = ownsProviderRequest(row, session, resolvedProvider);
    const actorBankId = session.user.user_type === 'blood_bank' ? session.user.user_id : resolvedProvider?.bank_id;
    if (row.workflow_version === 2 && (session.user.user_type === 'blood_bank' || resolvedProvider?.organization_type === 'Blood Bank')
      && Array.isArray(row.accepted_donors) && row.accepted_donors.some(donor => donor.collecting_bank_id !== actorBankId)) throw new Error('Unexpected designated donor scope.');
    if (!owned || !Number.isSafeInteger(row?.request_id) || row.request_id < 1
      || !bloodGroups.includes(row.blood_group) || !Number.isInteger(row.units_required) || row.units_required < 1
      || !['Normal', 'Emergency'].includes(row.urgency_level) || !statuses.includes(row.status)
      || (row.request_date !== null && typeof row.request_date !== 'string')
      || (row.donor_matching_started_at != null && typeof row.donor_matching_started_at !== 'string')) throw new Error('Unexpected bank requests response.');
    return { request_id: row.request_id, bank_id: row.bank_id ?? null, blood_group: row.blood_group,
      units_required: row.units_required, urgency_level: row.urgency_level, status: row.status,
      request_date: row.request_date, donor_matching_started_at: row.donor_matching_started_at ?? null, ...lifecycleRequestFields(row) };
  });
  return rows.sort((a, b) => Number(b.urgency_level === 'Emergency') - Number(a.urgency_level === 'Emergency')
    || requestTime(a.request_date) - requestTime(b.request_date) || a.request_id - b.request_id);
}
function fulfillmentResult(result, requestId, session, provider) {
  const v2 = result?.workflow_version === 2;
  const actorBank = session.user.user_type === 'blood_bank' ? session.user.user_id : provider?.bank_id;
  if ((result?.actor_bank_id != null && result.actor_bank_id !== actorBank)
    || result?.request_id !== requestId || !statuses.includes(result.status)
    || (!v2 && session.user.user_type === 'blood_bank' && result.bank_id !== undefined && result.bank_id !== session.user.user_id)
    || (!v2 && session.user.user_type === 'organization' && result.organization_id !== undefined && result.organization_id !== provider.organization_id)) {
    throw new Error('Unexpected request processing response.');
  }
  const fulfilled=result.fulfilled_units ?? result.allocated_units ?? 0;
  const remaining=result.remaining_units ?? 0;
  const required=result.units_required ?? fulfilled + remaining;
  return { request_id: requestId, source: result.source, status: result.status,
    allocated_units: result.allocated_units ?? result.units_donated ?? 0, notified_count: result.notified_count ?? 0,
    ...lifecycleRequestFields({ ...result, workflow_version: undefined, units_required: required, fulfilled_units: fulfilled, remaining_units: remaining,
      inventory_units: result.inventory_units ?? (result.source === 'blood_bank' || result.source === 'inventory' ? fulfilled : 0),
      donation_units: result.donation_units ?? (result.source === 'donation' ? fulfilled : 0) }, false) };
}
export async function processBankRequest(session, requestId, signal, operationKey = newOperationKey(), provider) {
  clinicalAccount(session, provider);
  if (!Number.isSafeInteger(requestId) || requestId < 1 || !validOperationKey(operationKey)) throw new Error('Invalid blood request.');
  const { data }=await axios.post(API_BASE_URL + '/api/allocations/process/' + requestId, { operation_key: operationKey }, options(session, signal));
  return fulfillmentResult(data, requestId, session, provider);
}
export async function recordDonorScreening(session, requestId, donorId, result, signal, provider) {
  clinicalAccount(session, provider);
  if (!Number.isInteger(requestId) || requestId < 1 || !Number.isInteger(donorId) || donorId < 1 || !['Passed', 'Failed'].includes(result)) throw new Error('Invalid screening.');
  const { data }=await axios.post(API_BASE_URL + '/api/screenings/' + requestId, { donor_id: donorId, result }, options(session, signal));
  if (data?.request_id !== requestId || data?.donor_id !== donorId || (data.screening_result ?? data.result) !== result) throw new Error('Unexpected screening response.');
  return { request_id: requestId, donor_id: donorId, screening_result: result };
}
export async function recordActualDonation(session, requestId, donorId, units, operationKey, signal, provider, accountingPath) {
  clinicalAccount(session, provider);
  if (!Number.isInteger(requestId) || requestId < 1 || !Number.isInteger(donorId) || donorId < 1
    || !Number.isInteger(units) || units < 1 || units > maximumUnits || !validOperationKey(operationKey)) throw new Error('Enter a valid donation quantity.');
  if (accountingPath !== undefined && !['DirectRequest','Inventory'].includes(accountingPath)) throw new Error('Invalid donation accounting path.');
  const { data }=await axios.post(API_BASE_URL + '/api/donations/' + requestId,
    { donor_id: donorId, units_donated: units, operation_key: operationKey, ...(accountingPath ? { accounting_path: accountingPath } : {}) }, options(session, signal));
  return fulfillmentResult(data, requestId, session, provider);
}
export function bankError(error, action = 'load this section') {
  const status = error.response?.status;
  if (status === 400) return 'Please check the values and try again.';
  if (status === 403) return 'Your account cannot access this organization operation.';
  if (status === 404) return 'This organization record or request is unavailable.';
  if (status === 409) return 'This request or inventory has changed. Refresh the dashboard before trying again.';
  if (status >= 500) return 'The server could not ' + action + '. Please try again later.';
  if (axios.isAxiosError(error) && !error.response) return 'Unable to reach the backend. Check your connection and try again.';
  return 'Unable to ' + action + '. Please try again.';
}

export async function findRequestDonors(session, requestId, signal, provider) {
  clinicalAccount(session, provider);
  if (!Number.isInteger(requestId) || requestId < 1) throw new Error('Invalid blood request.');
  const { data }=await axios.post(API_BASE_URL + '/api/allocations/match/' + requestId, {}, options(session, signal));
  if (data?.request_id !== requestId || !Number.isInteger(data.notified_count) || data.notified_count < 0) throw new Error('Unexpected donor matching response.');
  return { request_id: requestId, notified_count: data.notified_count };
}
