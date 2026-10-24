import { collectingBanks, collectionFields } from './workflowV2Api.js';
import axios from 'axios';
import { API_BASE_URL } from '../config/api.js';
import { lifecycleRequestFields } from './lifecycleFields.js';

const groups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
function options(session, signal) {
  return { headers: { Authorization: 'Bearer ' + session.token }, signal, timeout: 15000 };
}
export async function fetchDonorProfile(session, signal) {
  const { data } = await axios.get(API_BASE_URL + '/api/auth/me', options(session, signal));
  if (data?.user_id !== session.user.user_id || data?.user_type !== 'donor') throw new Error('Unexpected profile.');
  return {
    name: typeof data.name === 'string' ? data.name.trim() : '',
    blood_group: groups.includes(data.blood_group) ? data.blood_group : '',
    location: typeof data.location === 'string' ? data.location.trim() : '',
    state: typeof data.state === 'string' ? data.state : '', city: typeof data.city === 'string' ? data.city : '',
    is_available: data.is_available === 1 || data.is_available === true ? 1
      : data.is_available === 0 || data.is_available === false ? 0 : null,
  };
}
export async function fetchDonorMatches(session, signal) {
  const { data } = await axios.get(API_BASE_URL + '/api/donors/me/matching-requests', options(session, signal));
  if (!Array.isArray(data?.requests)) throw new Error('Unexpected matching requests.');
  return data.requests.map((row) => {
    if (!row || !Number.isInteger(row.request_id) || row.request_id < 1
      || !groups.includes(row.blood_group) || !Number.isInteger(row.units_required) || row.units_required < 1
      || !['Normal', 'Emergency'].includes(row.urgency_level)
      || !['Pending', 'Processing', 'Fulfilled', 'Cancelled'].includes(row.status)
      || (['Fulfilled', 'Cancelled'].includes(row.status) && row.donor_response !== 'Accepted')
      || (row.workflow_version !== 2 && (!(Number.isInteger(row.bank_id) && row.bank_id > 0) && !(Number.isInteger(row.organization_id) && row.organization_id > 0)))
      || typeof (row.admission_hospital_name ?? row.organization_name ?? row.bank_name) !== 'string' || ![null, 'Accepted'].includes(row.donor_response ?? null)) throw new Error('Unexpected matching request.');
    const progress = lifecycleRequestFields(row, false);
    if (row.workflow_version === 2 && row.donor_units_needed !== undefined &&
      (!Number.isInteger(row.donor_units_needed) || row.donor_units_needed < 0 || row.donor_units_needed > progress.remaining_units)) {
      throw new Error('Unexpected uncovered donor units.');
    }
    return { request_id: row.request_id, blood_group: row.blood_group, units_required: row.units_required,
      urgency_level: row.urgency_level, status: row.status, request_date: row.request_date,
      ...progress, bank_id: row.bank_id ?? null, bank_name: row.admission_hospital_name ?? row.organization_name ?? row.bank_name, ...collectingBanks(row), ...(row.workflow_version === 2 ? collectionFields(row) : {}),
      ...(row.workflow_version === 2 && row.donor_units_needed !== undefined ? { donor_units_needed: row.donor_units_needed } : {}),
      bank_address: typeof row.bank_address === 'string' ? row.bank_address : '',
      bank_phone: typeof row.bank_phone === 'string' ? row.bank_phone : '',
      bank_email: typeof row.bank_email === 'string' ? row.bank_email : '',
      donor_response: row.donor_response ?? null,
      screening_result: ['Passed', 'Failed'].includes(row.screening_result) ? row.screening_result : null,
      recipient: row.donor_response === 'Accepted' && row.recipient && typeof row.recipient.name === 'string'
        ? { name: row.recipient.name, age: Number.isInteger(row.recipient.age) ? row.recipient.age : null,
          gender: typeof row.recipient.gender === 'string' ? row.recipient.gender : '',
          phone: typeof row.recipient.phone === 'string' ? row.recipient.phone : '',
          email: typeof row.recipient.email === 'string' ? row.recipient.email : '' } : null };
  });
}
export async function fetchDonorNotifications(session, signal) {
  const { data } = await axios.get(API_BASE_URL + '/api/notifications/donor/' + session.user.user_id, options(session, signal));
  if (data?.user_type !== 'donor' || data?.user_id !== session.user.user_id
    || !Array.isArray(data?.notifications)) throw new Error('Unexpected notifications.');
  return data.notifications.map((row) => {
    if (!row || !Number.isInteger(row.notification_id) || row.notification_id < 1
      || typeof row.message !== 'string' || ![0, 1].includes(row.is_read)
      || (row.donor_id !== undefined && row.donor_id !== session.user.user_id)
      || (row.recipient_id !== undefined && row.recipient_id !== null)) throw new Error('Unexpected notification.');
    return { notification_id: row.notification_id, message: row.message, is_read: row.is_read, sent_at: row.sent_at };
  });
}
export async function markDonorNotificationRead(session, id, signal) {
  if (!Number.isInteger(id) || id < 1) throw new Error('Invalid notification.');
  const { data } = await axios.patch(API_BASE_URL + '/api/notifications/' + id + '/read', {}, options(session, signal));
  if (data?.notification_id !== id || data?.is_read !== 1) throw new Error('Unexpected read response.');
  return data;
}
export async function updateDonorAvailability(session, value, signal) {
  if (typeof value !== 'boolean') throw new Error('Invalid availability.');
  const { data } = await axios.patch(API_BASE_URL + '/api/donors/me/availability', { is_available: value }, options(session, signal));
  if (data?.is_available !== Number(value)) throw new Error('Unexpected availability response.');
  return data.is_available;
}
export async function respondToDonorRequest(session, id, response, signal, collectingBankId) {
  if (!Number.isInteger(id) || id < 1 || id > 2147483647 || !['Accepted', 'Declined'].includes(response)) throw new Error('Invalid donor response.');
  if (collectingBankId !== undefined && (!Number.isSafeInteger(collectingBankId) || collectingBankId < 1)) throw new Error('Select an eligible collecting Blood Bank.');
  const { data } = await axios.post(API_BASE_URL + '/api/donors/me/requests/' + id + '/response',
    { response, ...(response === 'Accepted' && collectingBankId !== undefined ? { collecting_bank_id: collectingBankId } : {}) }, options(session, signal));
  if (data?.request_id !== id || data?.response !== response) throw new Error('Unexpected donor response.');
  return { request_id: id, response, status: data.status ?? (response === 'Accepted' ? 'Processing' : undefined) };
}
export function donorApiError(error) {
  const status = error.response?.status;
  if (status === 400) return 'Please check your input and try again.';
  if (status === 409) return 'This opportunity has changed or you have already responded. Refresh the dashboard to see the latest information.';
  if (status === 403) return 'Your account does not have permission to access this information.';
  if (status === 404) return 'This information is currently unavailable. Please try again.';
  if (status >= 500) return 'The server could not complete this request. Please try again later.';
  if (axios.isAxiosError(error) && !error.response) return 'Unable to reach the backend. Check your connection and try again.';
  return 'Unable to load this information. Please try again.';
}

export async function updateDonorLocation(session, state, city, signal) {
  if (typeof state !== 'string' || !state.trim() || typeof city !== 'string' || !city.trim() || city.trim().length > 100) {
    throw new Error('Select a state and enter your city.');
  }
  const { data } = await axios.put(API_BASE_URL + '/api/donors/me/location',
    { state, city: city.trim() }, options(session, signal));
  if (data?.state !== state || typeof data.city !== 'string' || !data.city.trim()) throw new Error('Unexpected location response.');
  return { state: data.state, city: data.city };
}
