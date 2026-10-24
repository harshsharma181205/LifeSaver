const pool = require('../db');
const { resolveProvider } = require('../services/organizationService');
const workflow = require('../services/fulfillmentService');
const { buildSchedule } = require('../services/priorityScheduler');

const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

async function getProviderQueue(req, res) {
  let connection;
  try {
    if (!['organization', 'blood_bank'].includes(req.user.user_type)) {
      workflow.fail(403, 'Only Hospital or Blood Bank accounts can view the provider queue.');
    }
    if (Object.keys(req.query || {}).length) {
      workflow.fail(400, 'The provider queue does not accept query overrides.');
    }
    const provider = await resolveProvider(req.user);
    if (!provider) workflow.fail(403, 'Only Hospital or Blood Bank accounts can view the provider queue.');

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [requests] = await connection.execute(
      'SELECT r.request_id, r.bank_id, r.blood_group, r.units_required, r.urgency_level, r.status, r.request_date FROM blood_requests r WHERE r.bank_id = ? AND r.status IN (?, ?)',
      [provider.bank_id, 'Pending', 'Processing']
    );
    const eligible = [];
    const seen = new Set();
    for (const request of requests) {
      if (!workflow.positiveInt(request.request_id) || seen.has(request.request_id) ||
          request.bank_id !== provider.bank_id || !workflow.positiveInt(request.units_required) ||
          !bloodGroups.includes(request.blood_group) || !['Normal', 'Emergency'].includes(request.urgency_level) ||
          !['Pending', 'Processing'].includes(request.status)) {
        workflow.fail(409, 'Blood request contains inconsistent data.');
      }
      seen.add(request.request_id);
      const progress = await workflow.readProgress(connection, request);
      if (progress.remaining_units > 0) eligible.push({ ...request, remaining_units: progress.remaining_units });
    }
    await connection.commit();
    connection.release();
    connection = null;

    // DB connection chhodne ke baad JavaScript queue banayega.
    const schedule = buildSchedule(eligible);
    return res.status(200).json({ bank_id: provider.bank_id, organization_id: provider.organization_id ?? null, ...schedule });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); }
      catch { connection.destroy(); connection = null; }
    }
    if (error.code === 'SCHEDULER_DATA_ERROR') {
      return res.status(409).json({ message: 'Provider queue contains inconsistent data.' });
    }
    return workflow.sendError(res, error, 'Unable to retrieve the provider review queue.');
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { getProviderQueue };
