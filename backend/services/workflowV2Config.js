const requiredColumns = {
  blood_requests: ['workflow_version', 'admission_hospital_id'],
  donor_responses: ['collecting_bank_id'],
  request_allocations: ['actor_bank_id', 'collection_id'],
  donor_collections: ['collection_id', 'request_id', 'donor_id', 'bank_id', 'donation_id', 'accounting_path', 'inventory_id', 'units_collected', 'operation_key'],
  workflow_notifications: ['notification_id', 'audience_type', 'audience_id', 'request_id', 'event_key', 'message', 'is_read', 'sent_at'],
  workflow_schema_versions: ['version', 'applied_at'],
};

function isEnabled() { return process.env.LIFESAVER_WORKFLOW_V2 === 'true'; }
function unavailable() {
  const error = new Error('The new request workflow is not available yet.');
  error.status = 503;
  return error;
}

async function assertReady(executor) {
  if (!isEnabled()) throw unavailable();
  try {
    // Har baar metadata dekho; stale cache se activation nahi hogi.
    const [columns] = await executor.execute('SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
    const present = new Set(columns.map(row => row.TABLE_NAME + '.' + row.COLUMN_NAME));
    for (const [table, names] of Object.entries(requiredColumns)) {
      if (names.some(name => !present.has(table + '.' + name))) throw unavailable();
    }
    const [versions] = await executor.execute('SELECT version FROM workflow_schema_versions WHERE version = ?', [2]);
    if (!versions.some(row => Number(row.version) === 2)) throw unavailable();
    return true;
  } catch { throw unavailable(); }
}

module.exports = { isEnabled, assertReady, requiredColumns };
