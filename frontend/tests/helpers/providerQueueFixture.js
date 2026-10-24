import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSchedule } = require('../../../backend/services/priorityScheduler.js');

// Pure scheduler se memory fixture banegi; MySQL ko call nahi hota.
export function providerQueueFixture(requests = [], { bankId = 3, organizationId = null, now = Date.now() } = {}) {
  const rows = requests.map(row => ({ ...row, bank_id: row.bank_id ?? bankId,
    remaining_units: row.remaining_units ?? (row.status === 'Fulfilled' ? 0 : row.units_required - (row.fulfilled_units ?? 0)) }));
  return { bank_id: bankId, organization_id: organizationId, ...buildSchedule(rows, { now }) };
}
