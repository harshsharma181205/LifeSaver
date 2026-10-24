const workflow = require('./fulfillmentService');
const { isV2, sameLocation } = require('./requestAccessPolicy');
const { notifyAudience, notifyRequestAudience } = require('./workflowV2Notifications');

const empty = () => ({ donor_units_needed: 0, inventory_coverage_units: 0, collecting_bank_count: 0 });

async function coverage(executor, request, progress) {
  if (!isV2(request) || !['Pending', 'Processing'].includes(request.status) || progress.remaining_units <= 0) return empty();
  const [banks] = await executor.execute(
    "SELECT b.bank_id, o.organization_id, o.organization_type, o.state, o.city, i.inventory_id, i.blood_group, i.units_available FROM blood_banks b JOIN organizations o ON o.organization_id = b.organization_id LEFT JOIN blood_inventory i ON i.bank_id = b.bank_id AND i.blood_group = ? WHERE o.organization_type = 'Blood Bank' ORDER BY b.bank_id",
    [request.blood_group]
  );
  let stock = 0;
  const seen = new Set();
  for (const bank of banks) {
    if (bank.organization_type !== 'Blood Bank' || !workflow.positiveInt(bank.bank_id) ||
        !workflow.positiveInt(bank.organization_id) || !sameLocation(bank, request)) continue;
    if (seen.has(bank.bank_id)) workflow.fail(409, 'Inventory contains inconsistent data.');
    seen.add(bank.bank_id);
    if (bank.inventory_id == null) continue;
    if (bank.blood_group !== request.blood_group) continue;
    if (!workflow.positiveInt(bank.inventory_id) || !Number.isInteger(bank.units_available) ||
        bank.units_available < 0 || bank.units_available > 2147483647) workflow.fail(409, 'Inventory contains inconsistent data.');
    stock = Math.min(progress.remaining_units, stock + bank.units_available);
  }
  return { donor_units_needed: Math.max(0, progress.remaining_units - stock),
    inventory_coverage_units: stock, collecting_bank_count: seen.size };
}

// Caller request lock rakhega; ye service stock reserve ya allocate nahi karti.
async function ensureFallback(connection, request, progress, options = {}) {
  const needed = await coverage(connection, request, progress);
  const result = { ...needed, donors: [], matched_count: 0, notified_count: 0 };
  if (!needed.donor_units_needed || !needed.collecting_bank_count) return result;
  await connection.execute(
    'UPDATE blood_requests SET donor_matching_started_at = COALESCE(donor_matching_started_at, CURRENT_TIMESTAMP) WHERE request_id = ?',
    [request.request_id]
  );
  const [donors] = await connection.execute(
    'SELECT d.donor_id, d.name, d.blood_group, d.is_available, d.state, d.city, dr.response, dr.screening_result FROM donors d LEFT JOIN donor_responses dr ON dr.donor_id = d.donor_id AND dr.request_id = ? WHERE d.blood_group = ? AND d.is_available = 1 AND (dr.response IS NULL OR dr.response = ?) AND (dr.screening_result IS NULL OR dr.screening_result <> ?) ORDER BY d.donor_id',
    [request.request_id, request.blood_group, 'Accepted', 'Failed']
  );
  for (const donor of donors) {
    if (donor.blood_group !== request.blood_group || donor.is_available !== 1 || !sameLocation(donor, request) ||
        (donor.response && donor.response !== 'Accepted') || donor.screening_result === 'Failed') continue;
    result.donors.push({ donor_id: donor.donor_id, name: donor.name, blood_group: donor.blood_group,
      city: donor.city, donor_response: donor.response || null });
    if (donor.response) continue;
    result.notified_count++;
    await notifyAudience(connection, { type: 'donor', id: donor.donor_id, request_id: request.request_id,
      event_key: 'request:' + request.request_id + ':match-donor:' + donor.donor_id,
      message: 'Blood request #' + request.request_id + ' needs donor support for ' + needed.donor_units_needed +
        ' uncovered ' + request.blood_group + ' units in your city. Review current need and choose an eligible collecting Blood Bank before accepting.' });
  }
  result.matched_count = result.donors.length;
  await notifyRequestAudience(connection, request, 'matching-started',
    'Local donor fallback started for request #' + request.request_id + '. ' + needed.donor_units_needed +
      ' units are not covered by available city inventory.',
    options.collectingBankId ? { collectingBankId: options.collectingBankId } : {});
  return result;
}

module.exports = { coverage, ensureFallback };
