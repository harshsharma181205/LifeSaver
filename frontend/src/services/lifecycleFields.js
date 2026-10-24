import { workflowV2Fields, collectionFields } from './workflowV2Api.js';
// Keep lifecycle quantities and contact fields explicit at the API boundary.
export function lifecycleRequestFields(row, includeDonors = true) {
  const required = row.units_required;
  const history = row.history_available !== false && !(row.status === 'Fulfilled' && row.fulfilled_units === undefined);
  const fulfilled = row.fulfilled_units ?? (row.status === 'Fulfilled' ? required : 0);
  const remaining = row.remaining_units ?? required - fulfilled;
  const inventory = row.inventory_units ?? (history ? 0 : null);
  const donation = row.donation_units ?? (history ? 0 : null);
  if (!Number.isInteger(fulfilled) || fulfilled < 0 || fulfilled > required || !Number.isInteger(remaining)
    || remaining !== required - fulfilled || (history && (!Number.isInteger(inventory) || inventory < 0
      || !Number.isInteger(donation) || donation < 0 || inventory + donation !== fulfilled))) {
    throw new Error('Unexpected fulfillment quantities.');
  }
  const donors = includeDonors && Array.isArray(row.accepted_donors) ? row.accepted_donors.map(donor => {
    if (!Number.isInteger(donor?.donor_id) || donor.donor_id < 1 || typeof donor.name !== 'string'
      || ![null, 'Passed', 'Failed'].includes(donor.screening_result ?? null)
      || (donor.response !== undefined && donor.response !== 'Accepted')) throw new Error('Unexpected accepted donor.');
    return { donor_id: donor.donor_id, name: donor.name, blood_group: donor.blood_group,
      phone: typeof donor.phone === 'string' ? donor.phone : '', email: typeof donor.email === 'string' ? donor.email : '',
      screening_result: donor.screening_result ?? null, screened_at: donor.screened_at ?? null,
      donated_units: Number.isInteger(donor.donated_units) ? donor.donated_units : 0,
      ...(row.workflow_version === 2 ? { ...collectionFields(donor), collecting_bank_id: donor.collecting_bank_id ?? null } : {}) };
  }) : [];
  return { organization_id: Number.isInteger(row.organization_id) ? row.organization_id : null,
    organization_type: typeof row.organization_type === 'string' ? row.organization_type : null,
    organization_name: typeof row.organization_name === 'string' ? row.organization_name : row.bank_name ?? null,
    state: typeof row.state === 'string' ? row.state : '', city: typeof row.city === 'string' ? row.city : '',
    fulfilled_units: fulfilled, remaining_units: remaining, inventory_units: inventory, donation_units: donation,
    history_available: history, accepted_donors: donors, ...workflowV2Fields(row) };
}
export function newOperationKey() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== 'function') throw new Error('Secure operation key generation is unavailable.');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}
export function validOperationKey(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
