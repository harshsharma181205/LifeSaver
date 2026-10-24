import axios from 'axios';
import { API_BASE_URL } from '../config/api.js';
import { indiaStates } from '../data/indiaStates.js';

const organizationTypes = ['Hospital', 'Blood Bank', 'NGO'];
function options(session, signal) {
  if (!session?.token || !session?.user) throw new Error('A signed-in account is required.');
  return { headers: { Authorization: 'Bearer ' + session.token }, timeout: 15000, signal };
}
function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}
function textOrNull(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('Unexpected organization information.');
  return value;
}
function sameLocation(left, right) {
  return left.trim().replace(/\s+/g, ' ').toLowerCase() === right.trim().replace(/\s+/g, ' ').toLowerCase();
}
export async function fetchOrganizationProfile(session, signal) {
  if (!['organization', 'blood_bank'].includes(session?.user?.user_type)) throw new Error('An organization account is required.');
  const { data } = await axios.get(API_BASE_URL + '/api/auth/me', options(session, signal));
  if (data?.user_id !== session.user.user_id || data?.user_type !== session.user.user_type) {
    throw new Error('Unexpected organization identity.');
  }
  const legacy = data.user_type === 'blood_bank';
  const name = legacy ? data.bank_name : data.name;
  const type = legacy ? data.organization_type ?? 'Blood Bank' : data.organization_type;
  const bankId = data.bank_id ?? (legacy ? data.user_id : null);
  if (typeof name !== 'string' || !name.trim() || !organizationTypes.includes(type)
    || (!legacy && (!positiveId(data.organization_id) || data.organization_id !== data.user_id))
    || (data.organization_id != null && !positiveId(data.organization_id))
    || (bankId !== null && !positiveId(bankId))
    || (type === 'NGO' && bankId !== null)) throw new Error('Unexpected organization profile.');
  return {
    user_id: data.user_id, user_type: data.user_type, organization_id: data.organization_id ?? null,
    organization_type: type, name: name.trim(), bank_id: bankId,
    state: textOrNull(data.state), city: textOrNull(data.city),
    address: textOrNull(data.address), phone: textOrNull(data.phone), email: textOrNull(data.email),
  };
}
export async function fetchOrganizationCities(session, state, signal, organizationType) {
  if (!indiaStates.includes(state)) throw new Error('Select a valid state or union territory.');
  const { data } = await axios.get(API_BASE_URL + '/api/organizations/cities',
    { ...options(session, signal), params: { state, ...(organizationType ? { organization_type: organizationType } : {}) } });
  if (!Array.isArray(data?.cities) || data.cities.some(city => typeof city !== 'string'
    || !city.trim() || city.length > 100)) throw new Error('Unexpected registered cities.');
  return [...new Set(data.cities)];
}
export async function fetchOrganizations(session, state, city, signal, organizationType) {
  if (!indiaStates.includes(state) || typeof city !== 'string' || !city.trim() || city.trim().length > 100) {
    throw new Error('Select a valid state and city.');
  }
  const { data } = await axios.get(API_BASE_URL + '/api/organizations',
    { ...options(session, signal), params: { state, city: city.trim(), ...(organizationType ? { organization_type: organizationType } : {}) } });
  if (!Array.isArray(data?.organizations)) throw new Error('Unexpected organization directory.');
  const seen = new Set();
  return data.organizations.map(row => {
    if (!positiveId(row?.organization_id) || seen.has(row.organization_id)
      || !['Hospital', 'Blood Bank'].includes(row.organization_type) || (organizationType && row.organization_type !== organizationType)
      || (!(organizationType === 'Hospital' && row.bank_id == null) && !positiveId(row.bank_id))
      || typeof row.name !== 'string' || !row.name.trim()
      || typeof row.state !== 'string' || !sameLocation(row.state, state)
      || typeof row.city !== 'string' || !sameLocation(row.city, city)) {
      throw new Error('Unexpected organization directory.');
    }
    seen.add(row.organization_id);
    return { organization_id: row.organization_id, organization_type: row.organization_type,
      name: row.name, state: row.state, city: row.city, bank_id: row.bank_id ?? null, address: textOrNull(row.address) };
  });
}
export async function updateOrganizationLocation(session, location, signal) {
  if (!['organization', 'blood_bank'].includes(session?.user?.user_type)
    || !indiaStates.includes(location?.state) || typeof location.city !== 'string'
    || !location.city.trim() || location.city.trim().length > 100) throw new Error('Enter a valid state and city.');
  await axios.put(API_BASE_URL + '/api/organizations/me/location',
    { state: location.state, city: location.city.trim().replace(/\s+/g, ' ') }, options(session, signal));
  // /me preserves the JWT identity for both legacy banks and new organizations.
  return fetchOrganizationProfile(session, signal);
}
export function organizationError(error, action = 'load your organization') {
  const status = error.response?.status;
  if (status === 400) return 'Please check the organization details, state and city.';
  if (status === 401) return 'Your session has expired. Please log in again.';
  if (status === 403) return 'Your account cannot perform this organization operation.';
  if (status === 404) return 'Your organization record could not be found.';
  if (status === 409) return 'These details conflict with an existing record. Refresh and try again.';
  if (status >= 500) return 'The server could not ' + action + '. Please try again later.';
  if (axios.isAxiosError(error) && !error.response) return 'Unable to reach the backend. Check your connection and try again.';
  return 'Unable to ' + action + '. Please try again.';
}
