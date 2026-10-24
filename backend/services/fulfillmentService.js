const pool = require('../db');
const { resolveProvider, isClinicalProvider } = require('./organizationService');
const { createNotification } = require('./notificationService');

class WorkflowError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const positiveInt = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const validKey = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function fail(status, message) { throw new WorkflowError(status, message); }

async function readProgress(executor, request, lock = false) {
  // Locking read latest committed allocation rows dekhegi.
  const [rows] = await executor.execute(
    'SELECT allocation_id, donation_id, inventory_id, units_allocated FROM request_allocations WHERE request_id = ?' + (lock ? ' FOR UPDATE' : ''),
    [request.request_id]
  );
  let inventory = 0, donation = 0;
  for (const row of rows) {
    if (!positiveInt(row.units_allocated) || (row.donation_id == null) === (row.inventory_id == null)) {
      fail(409, 'Allocation history is inconsistent.');
    }
    if (row.inventory_id != null) inventory += row.units_allocated;
    else donation += row.units_allocated;
  }
  const recorded = inventory + donation;
  if (recorded > request.units_required) fail(409, 'Allocation history exceeds the requested units.');
  const historical = request.status === 'Fulfilled' && rows.length === 0;
  const fulfilled = historical ? request.units_required : recorded;
  return { fulfilled_units: fulfilled, remaining_units: request.units_required - fulfilled,
    inventory_units: inventory, donation_units: donation, history_available: !historical };
}
async function updateStatus(connection, request) {
  const progress = await readProgress(connection, request, true);
  const status = progress.remaining_units === 0 ? 'Fulfilled' : 'Processing';
  await connection.execute('UPDATE blood_requests SET status = ? WHERE request_id = ?', [status, request.request_id]);
  return { ...progress, status };
}
async function notifyRecipient(connection, request, message) {
  return createNotification({ recipient_id: request.recipient_id, request_id: request.request_id, message },
    { executor: connection, sendSMS: false });
}
async function notifyDonor(connection, request, donorId, message) {
  return createNotification({ donor_id: donorId, request_id: request.request_id, message },
    { executor: connection, sendSMS: false });
}
async function runProviderTransaction(user, requestId, work) {
  if (!positiveInt(requestId)) fail(400, 'request_id must be a positive integer.');
  if (!['organization', 'blood_bank'].includes(user.user_type)) fail(403, 'An authorized provider account is required.');
  const provider = await resolveProvider(user);
  if (!isClinicalProvider(provider)) fail(403, 'Only Hospital or Blood Bank accounts can perform this action.');
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [requests] = await connection.execute(
      'SELECT request_id, recipient_id, bank_id, organization_id, state, city, blood_group, units_required, urgency_level, status, donor_matching_started_at FROM blood_requests WHERE request_id = ? AND bank_id = ? FOR UPDATE',
      [requestId, provider.bank_id]
    );
    if (!requests.length) fail(404, 'Blood request not found.');
    const request = requests[0];
    if (!positiveInt(request.units_required) || !positiveInt(request.recipient_id) || request.bank_id !== provider.bank_id ||
        !['A+','A-','B+','B-','AB+','AB-','O+','O-'].includes(request.blood_group) ||
        !['Normal','Emergency'].includes(request.urgency_level) || !['Pending','Processing','Fulfilled','Cancelled'].includes(request.status)) {
      fail(409, 'Blood request contains inconsistent data.');
    }
    const progress = await readProgress(connection, request, true);
    const result = await work({ connection, request, provider, progress });
    await connection.commit();
    return { organization_id: provider.organization_id, bank_id: provider.bank_id, ...result };
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); }
      catch { connection.destroy(); connection = null; }
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }
}
async function previousOperation(connection, requestId, key) {
  const [rows] = await connection.execute(
    'SELECT a.allocation_id, a.inventory_id, a.donation_id, a.units_allocated, d.donor_id FROM request_allocations a LEFT JOIN donations d ON d.donation_id = a.donation_id WHERE a.request_id = ? AND a.operation_key = ? FOR UPDATE',
    [requestId, key]
  );
  return rows[0] || null;
}
function requireOpen(request, progress) {
  if (!['Pending', 'Processing'].includes(request.status) || progress.remaining_units <= 0) {
    fail(409, 'This request is closed or has no remaining units.');
  }
}
function sendError(res, error, fallback) {
  if (error instanceof WorkflowError) return res.status(error.status).json({ message: error.message });
  if (['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) {
    return res.status(409).json({ message: 'Another operation changed this request. Refresh before retrying.' });
  }
  return res.status(500).json({ message: fallback });
}
module.exports = { WorkflowError, positiveInt, validKey, fail, readProgress, updateStatus, notifyRecipient,
  notifyDonor, runProviderTransaction, previousOperation, requireOpen, sendError };
