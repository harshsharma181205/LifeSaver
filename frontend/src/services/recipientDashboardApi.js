import axios from 'axios';
import { API_BASE_URL } from '../config/api.js';
import { lifecycleRequestFields } from './lifecycleFields.js';

function options(session, signal) {
  return { headers: { Authorization: 'Bearer ' + session.token }, signal, timeout: 15000 };
}

function selectedBankFields(row) {
  const bank_id = row.bank_id ?? null;
  const marker = row.donor_matching_started_at ?? null;
  if ((bank_id !== null && (!Number.isSafeInteger(bank_id) || bank_id < 1))
    || (marker !== null && (typeof marker !== 'string' || Number.isNaN(Date.parse(marker))))
    || ['bank_name', 'bank_address', 'bank_phone', 'bank_email'].some(field => row[field] != null && typeof row[field] !== 'string')) {
    throw new Error('Unexpected selected blood bank information.');
  }
  return { ...lifecycleRequestFields(row), bank_id, donor_matching_started_at: marker, bank_name: row.bank_name ?? null,
    bank_address: row.bank_address ?? null, bank_phone: row.bank_phone ?? null, bank_email: row.bank_email ?? null };
}

export async function fetchRecipientRequests(session, signal) {
  // Backend JWT se ownership check karega; recipient_id query mein nahi bhejenge.
  const response = await axios.get(API_BASE_URL + '/api/requests', options(session, signal));
  const rows = response.data?.requests;
  if (!Array.isArray(rows)) throw new Error('Unexpected request history response.');

  return rows.map((row) => {
    if (!row || !Number.isSafeInteger(row.request_id) || row.request_id <= 0
      || !Number.isInteger(row.units_required) || row.units_required <= 0
      || typeof row.blood_group !== 'string' || (row.status !== null && typeof row.status !== 'string')
      || typeof row.urgency_level !== 'string'
      || (row.recipient_id !== undefined && row.recipient_id !== session.user.user_id)) {
      throw new Error('Unexpected request history response.');
    }
    // Display ke liye sirf zaroori fields rakhenge.
    return {
      request_id: row.request_id,
      blood_group: row.blood_group,
      units_required: row.units_required,
      urgency_level: row.urgency_level,
      status: row.status,
      request_date: row.request_date,
      ...selectedBankFields(row),
    };
  });
}

export async function fetchRecipientName(session, signal) {
  const response = await axios.get(API_BASE_URL + '/api/auth/me', options(session, signal));
  const profile = response.data;
  if (profile?.user_id !== session.user.user_id || profile?.user_type !== 'recipient'
    || typeof profile?.name !== 'string' || !profile.name.trim()) return '';
  return profile.name.trim();
}

export function requestHistoryError(error) {
  const status = error.response?.status;
  if (status === 403) return 'Your account cannot access recipient blood requests.';
  if (status === 404) return 'Request history is currently unavailable. Please try again.';
  if (status >= 500) return 'The server could not load your requests. Please try again later.';
  if (axios.isAxiosError(error) && !error.response) {
    return 'Unable to reach the backend. Check your connection and try again.';
  }
  return 'Unable to load your blood requests. Please try again.';
}

export function formatRequestDate(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
  }).format(date);
}

export function isValidRequestId(value) {
  const id = Number(value);
  return typeof value === 'string' && /^\d+$/.test(value)
    && Number.isInteger(id) && id >= 1 && id <= 2147483647;
}

export async function fetchRecipientRequest(session, requestId, signal) {
  if (!isValidRequestId(requestId)) throw new Error('Invalid request link.');
  const response = await axios.get(
    API_BASE_URL + '/api/requests/' + encodeURIComponent(requestId), options(session, signal),
  );
  const row = response.data?.request;
  if (!row || row.request_id !== Number(requestId)
    || !['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].includes(row.blood_group)
    || !Number.isInteger(row.units_required) || row.units_required < 1 || row.units_required > 2147483647
    || !['Normal', 'Emergency'].includes(row.urgency_level)
    || (row.status !== null && !['Pending', 'Processing', 'Fulfilled', 'Cancelled'].includes(row.status))
    || (row.request_date !== null && typeof row.request_date !== 'string')
    || (row.recipient_id !== undefined && row.recipient_id !== session.user.user_id)) {
    throw new Error('Unexpected request details response.');
  }
  // Response se sirf display fields lenge; ownership backend enforce karega.
  return {
    request_id: row.request_id, blood_group: row.blood_group, units_required: row.units_required,
    urgency_level: row.urgency_level, status: row.status, request_date: row.request_date,
    ...selectedBankFields(row),
  };
}

export function requestDetailsError(error) {
  const status = error.response?.status;
  if (status === 400) return 'This request link is invalid. Open a request from your dashboard.';
  if (status === 403) return 'You do not have permission to view this blood request.';
  if (status === 404) return 'This blood request was not found or is not available to your account.';
  if (status >= 500) return 'The server could not load this request. Please try again later.';
  if (axios.isAxiosError(error) && !error.response) {
    return 'Unable to reach the backend. Check your connection and try again.';
  }
  return 'Unable to load this blood request. Please try again.';
}

export async function cancelRecipientRequest(session, requestId, signal) {
  if (!isValidRequestId(String(requestId))) throw new Error('Invalid request link.');
  const { data } = await axios.patch(API_BASE_URL + '/api/requests/' + requestId + '/cancel', {}, options(session, signal));
  if (data?.request_id !== Number(requestId) || data.status !== 'Cancelled') throw new Error('Unexpected cancellation response.');
  return data;
}
