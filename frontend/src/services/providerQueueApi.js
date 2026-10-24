import { ownsProviderRequest, workflowV2Fields } from './workflowV2Api.js';
import axios from 'axios';
import { API_BASE_URL } from '../config/api.js';

const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const algorithm = 'Non-preemptive Priority + FCFS';
function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function isoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function providerIdentity(session, provider) {
  const user = session?.user;
  if (typeof session?.token !== 'string' || !session.token.trim() || !positiveInteger(user?.user_id)) {
    throw new Error('A signed-in provider account is required.');
  }
  if (user.user_type === 'blood_bank') {
    if (provider?.bank_id != null && provider.bank_id !== user.user_id) throw new Error('Invalid provider identity.');
    return { bankId: user.user_id, organizationId: null, legacy: true };
  }
  if (user.user_type !== 'organization' || provider?.organization_id !== user.user_id
    || !['Hospital', 'Blood Bank'].includes(provider.organization_type) || (provider.organization_type !== 'Hospital' && !positiveInteger(provider.bank_id))) {
    throw new Error('A clinical provider account is required.');
  }
  return { bankId: provider.bank_id ?? null, organizationId: user.user_id, legacy: false };
}

export async function fetchProviderQueue(session, signal, provider) {
  const identity = providerIdentity(session, provider);
  const { data } = await axios.get(API_BASE_URL + '/api/requests/provider-queue', {
    headers: { Authorization: 'Bearer ' + session.token }, timeout: 15000, signal,
  });
  if (data?.bank_id !== identity.bankId
    || (data.organization_id !== null && !positiveInteger(data.organization_id))
    || (!identity.legacy && data.organization_id !== identity.organizationId)
    || data.algorithm !== algorithm || !isoDate(data.generated_at)
    || !positiveInteger(data.long_wait_threshold_seconds) || !Array.isArray(data.queue)) {
    throw new Error('Unexpected provider queue response.');
  }
  const seen = new Set();
  // Server ka scheduling order rakhein; frontend dobara sort nahi karega.
  const queue = data.queue.map((row, index) => {
    if (!positiveInteger(row?.request_id) || seen.has(row.request_id) || (row.workflow_version === 2 ? !ownsProviderRequest(row, session, provider) : row.bank_id !== identity.bankId)
      || !bloodGroups.includes(row.blood_group) || !positiveInteger(row.units_required)
      || !positiveInteger(row.remaining_units) || row.remaining_units > row.units_required
      || !['Pending', 'Processing'].includes(row.status) || !['Emergency', 'Normal'].includes(row.urgency_level)
      || row.priority !== (row.urgency_level === 'Emergency' ? 0 : 1) || row.position !== index + 1
      || (row.request_date !== null && !isoDate(row.request_date))
      || (row.waiting_seconds !== null && (!Number.isSafeInteger(row.waiting_seconds) || row.waiting_seconds < 0))
      || typeof row.long_waiting_normal !== 'boolean'
      || row.long_waiting_normal !== (row.urgency_level === 'Normal' && row.waiting_seconds !== null
        && row.waiting_seconds >= data.long_wait_threshold_seconds)
      || (row.time_warning !== null && (typeof row.time_warning !== 'string' || !row.time_warning.trim()))
      || typeof row.selection_reason !== 'string' || !row.selection_reason.trim()) {
      throw new Error('Unexpected provider queue response.');
    }
    seen.add(row.request_id);
    // Sirf display ke safe fields return karein.
    return { request_id: row.request_id, bank_id: row.bank_id, blood_group: row.blood_group,
      units_required: row.units_required, remaining_units: row.remaining_units,
      urgency_level: row.urgency_level, status: row.status, request_date: row.request_date,
      priority: row.priority, position: row.position, waiting_seconds: row.waiting_seconds,
      long_waiting_normal: row.long_waiting_normal, time_warning: row.time_warning,
      selection_reason: row.selection_reason, ...(row.workflow_version === 2 ? { ...workflowV2Fields(row), state: row.state, city: row.city } : {}) };
  });
  return { bank_id: data.bank_id, organization_id: data.organization_id, algorithm,
    generated_at: data.generated_at, long_wait_threshold_seconds: data.long_wait_threshold_seconds, queue };
}
