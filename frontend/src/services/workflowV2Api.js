import axios from 'axios';
import { API_BASE_URL } from '../config/api.js';

export const hospitalHelp = 'Select the hospital where the patient is admitted. Your blood request will automatically be shared with eligible Blood Banks in the selected city.';
export function sameArea(left, right) { return typeof left === 'string' && typeof right === 'string'
  && left.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase() === right.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase(); }
function id(value) { return Number.isSafeInteger(value) && value > 0 && value <= 2147483647; }
export async function fetchWorkflowConfig(session, signal) {
  const { data } = await axios.get(API_BASE_URL + '/api/requests/workflow-config', {
    ...(session?.token ? { headers: { Authorization: 'Bearer ' + session.token } } : {}), signal, timeout: 15000,
  });
  if (typeof data?.workflow_v2_enabled !== 'boolean') throw new Error('Unexpected workflow configuration.');
  return { workflow_v2_enabled: data.workflow_v2_enabled };
}
export function workflowV2Fields(row) {
  if (row.workflow_version == null || row.workflow_version === 1) return {};
  if (row.workflow_version !== 2 || !id(row.admission_hospital_id)
    || typeof row.admission_hospital_name !== 'string' || !row.admission_hospital_name.trim()
    || typeof row.state !== 'string' || !row.state.trim() || typeof row.city !== 'string' || !row.city.trim()
    || row.bank_id != null || row.organization_id != null) throw new Error('Unexpected V2 request information.');
  const contributions = row.contributions ?? [];
  if (!Array.isArray(contributions)) throw new Error('Unexpected contribution history.');
  return { workflow_version: 2, admission_hospital_id: row.admission_hospital_id,
    admission_hospital_name: row.admission_hospital_name,
    ...(typeof row.can_supply === 'boolean' ? { can_supply: row.can_supply } : {}),
    contributions: contributions.map(item => {
      if (!id(item?.bank_id) || typeof item.bank_name !== 'string' || !item.bank_name.trim()
        || !['Inventory', 'Donation'].includes(item.source) || !Number.isInteger(item.units_allocated)
        || item.units_allocated < 1 || (item.allocated_at != null && (typeof item.allocated_at !== 'string'
          || !Number.isFinite(Date.parse(item.allocated_at))))) throw new Error('Unexpected contribution history.');
      return { bank_id: item.bank_id, bank_name: item.bank_name, source: item.source,
        units_allocated: item.units_allocated, allocated_at: item.allocated_at ?? null };
    }) };
}
export function ownsProviderRequest(row, session, provider) {
  if (row.workflow_version !== 2) return session.user.user_type === 'organization'
    ? row?.organization_id === provider?.organization_id || (row?.organization_id == null && row?.bank_id === provider?.bank_id)
    : row?.bank_id === session.user.user_id;
  if (session.user.user_type === 'organization' && provider?.organization_type === 'Hospital') {
    return row.admission_hospital_id === provider.organization_id;
  }
  const ownBankId = session.user.user_type === 'blood_bank' ? session.user.user_id : provider?.bank_id;
  const ownsContribution = Array.isArray(row.contributions) && row.contributions.some(item => item.bank_id === ownBankId);
  const ownsResponse = Array.isArray(row.accepted_donors) && row.accepted_donors.some(item => item.collecting_bank_id === ownBankId);
  const ownsHistory = row.can_supply === false && (ownsContribution || ownsResponse);
  return (session.user.user_type === 'blood_bank' || provider?.organization_type === 'Blood Bank')
    && (ownsHistory || (sameArea(row.state, provider?.state) && sameArea(row.city, provider?.city)));
}
export function collectingBanks(row) {
  if (row.workflow_version !== 2) return {};
  if (!Array.isArray(row.eligible_collecting_banks)) throw new Error('Unexpected collecting bank directory.');
  const seen = new Set();
  const banks = row.eligible_collecting_banks.map(bank => {
    if (!id(bank?.bank_id) || seen.has(bank.bank_id) || typeof bank.bank_name !== 'string' || !bank.bank_name.trim()
      || !sameArea(bank.state, row.state) || !sameArea(bank.city, row.city)
      || (bank.address != null && typeof bank.address !== 'string')) throw new Error('Unexpected collecting bank directory.');
    seen.add(bank.bank_id);
    return { bank_id: bank.bank_id, bank_name: bank.bank_name, state: bank.state, city: bank.city,
      address: bank.address ?? '' };
  });
  if (row.collecting_bank_id != null && !id(row.collecting_bank_id)) throw new Error('Unexpected collecting bank.');
  return { eligible_collecting_banks: banks, collecting_bank_id: row.collecting_bank_id ?? null,
    collecting_bank_name: typeof row.collecting_bank_name === 'string' ? row.collecting_bank_name : '',
    collecting_bank_address: typeof row.collecting_bank_address === 'string' ? row.collecting_bank_address : '' };
}

export function collectionFields(row) {
  if (row.collection_id == null) {
    if (row.units_collected != null || row.accounting_path != null) throw new Error('Unexpected collection record.');
    return { collection_id: null, units_collected: null, accounting_path: null };
  }
  if (!id(row.collection_id) || !Number.isInteger(row.units_collected) || row.units_collected < 1
    || row.units_collected > 2147483647 || !['DirectRequest','Inventory'].includes(row.accounting_path)
    || row.screening_result !== 'Passed') throw new Error('Unexpected collection record.');
  return { collection_id: row.collection_id, units_collected: row.units_collected, accounting_path: row.accounting_path };
}
