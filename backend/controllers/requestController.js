const pool = require('../db');
const { resolveProvider } = require('../services/organizationService');
const { normalizeState, normalizeCity, sameCity } = require('../services/locationService');
const workflow = require('../services/fulfillmentService');
const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const requestFields = 'r.request_id, r.recipient_id, r.blood_group, r.units_required, r.urgency_level, r.status, r.request_date, r.bank_id, r.organization_id, r.donor_matching_started_at, COALESCE(r.state, o.state) AS state, COALESCE(r.city, o.city) AS city, o.organization_type, o.name AS organization_name, b.bank_name, b.address AS bank_address, b.phone AS bank_phone, b.email AS bank_email';
const requestTables = ' FROM blood_requests r LEFT JOIN blood_banks b ON b.bank_id = r.bank_id LEFT JOIN organizations o ON o.organization_id = COALESCE(r.organization_id, b.organization_id)';

async function createRequest(req, res) {
  if (req.user.user_type !== 'recipient') return res.status(403).json({ message: 'Only recipients can create blood requests.' });

  let connection;
  try {
    const body = req.body;
    const allowed = [
      'recipient_id', 
      'bank_id', 
      'organization_id', 
      'state', 
      'city', 
      'blood_group', 
      'units_required', 
      'urgency_level'
    ];

    if (!body || 
      typeof body !== 'object' || 
      Array.isArray(body) || 
      Object.keys(body).some(
        key => !allowed.includes(key))
      ) {
      workflow.fail(400, 
        'Send only supported blood request fields. Status, dates and approval are server-managed.'
      );
    }

    if (!workflow.positiveInt(body.recipient_id)) workflow.fail(400, 'recipient_id is required and must be a positive integer.');

    if (body.recipient_id !== req.user.user_id) workflow.fail(403, 'You can only create your own blood requests.');

    if (!bloodGroups.includes(body.blood_group) || !workflow.positiveInt(body.units_required)) workflow.fail(400, 'Select a valid blood group and positive units_required.');

    const urgency = body.urgency_level === undefined ? 'Normal' : body.urgency_level;

    if (!['Normal', 'Emergency'].includes(urgency)) workflow.fail(400, 'urgency_level must be Normal or Emergency.');

    const useOrganization = body.organization_id !== undefined;

    if (!workflow.positiveInt(useOrganization ? body.organization_id : body.bank_id) ||
        (body.bank_id !== undefined && !workflow.positiveInt(body.bank_id))) workflow.fail(400, 'Select an existing organization/provider.');

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [recipients] = await connection.execute('SELECT recipient_id FROM recipients WHERE recipient_id = ? LIMIT 1', [req.user.user_id]);

    if (!recipients.length) workflow.fail(404, 'Recipient not found.');

    const [providers] = await connection.execute(
      'SELECT o.organization_id, o.organization_type, o.state, o.city, b.bank_id FROM organizations o JOIN blood_banks b ON b.organization_id = o.organization_id WHERE ' +
      (useOrganization ? 'o.organization_id' : 'b.bank_id') + ' = ? FOR SHARE',
      [useOrganization ? body.organization_id : body.bank_id]
    );

    const provider = providers[0];
    if (!provider || !['Hospital', 'Blood Bank'].includes(provider.organization_type)) workflow.fail(400, 'Select a registered Hospital or Blood Bank.');

    if (body.bank_id !== undefined && body.bank_id !== provider.bank_id) workflow.fail(400, 'The selected provider does not match bank_id.');

    // Legacy bank_id clients bhi real saved location use karenge.
    const state = normalizeState(body.state === undefined && !useOrganization ? provider.state : body.state);

    const city = normalizeCity(body.city === undefined && !useOrganization ? provider.city : body.city);

    if (!state || !city || state !== provider.state || !sameCity(city, provider.city)) workflow.fail(400, 'The organization must belong to the selected state and city.');
    
    const [created] = await connection.execute(
      'INSERT INTO blood_requests (recipient_id, bank_id, organization_id, state, city, blood_group, units_required, urgency_level, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        req.user.user_id, 
        provider.bank_id, 
        provider.organization_id, 
        provider.state, 
        provider.city, 
        body.blood_group, 
        body.units_required, 
        urgency, 
        'Pending']
    );

    await connection.commit();
    return res.status(201).json({ message: 'Blood request created successfully.', request_id: created.insertId });

  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch { connection.destroy(); connection = null; } }
    if (error.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ message: 'The selected provider or recipient is no longer available.' });
    return workflow.sendError(res, error, 'Unable to create blood request.');
  } finally { if (connection) connection.release(); }
}

async function decorateRequest(connection, request) {
  const progress = await workflow.readProgress(connection, request);
  const [donors] = await connection.execute(
    'SELECT d.donor_id, d.name, d.blood_group, d.phone, d.email, dr.screening_result, dr.screened_at FROM donor_responses dr JOIN donors d ON d.donor_id = dr.donor_id WHERE dr.request_id = ? AND dr.response = ? ORDER BY dr.responded_at, d.donor_id',
    [request.request_id, 'Accepted']
  );
 
  const accepted = donors.map(donor => donor.screening_result === 'Failed' ?
    { donor_id: donor.donor_id, name: donor.name, blood_group: donor.blood_group, screening_result: donor.screening_result, screened_at: donor.screened_at } : donor);
  return { ...request, ...progress, accepted_donors: accepted };
}

async function owner(req) {
  if (req.user.user_type === 'recipient') return { column: 'r.recipient_id', id: req.user.user_id };
  const provider = await resolveProvider(req.user);
  if (!provider) workflow.fail(403, 'Your account cannot view provider requests.');
  return { column: 'r.bank_id', id: provider.bank_id };
}
async function retrieveRequests(req, res, one) {
  let connection;
  try {
    if (!['recipient', 'blood_bank', 'organization'].includes(req.user.user_type)) workflow.fail(403, 'Your account cannot view these requests.');
    const requestId = one && /^\d+$/.test(req.params.requestId || '') ? Number(req.params.requestId) : null;
    if (one && !workflow.positiveInt(requestId)) workflow.fail(400, 'requestId must be a positive integer.');
    const ownership = await owner(req);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const params = one ? [ownership.id, requestId] : [ownership.id];
    const [requests] = await connection.execute('SELECT ' + requestFields + requestTables +
      ' WHERE ' + ownership.column + ' = ?' + (one ? ' AND r.request_id = ?' : '') +
      " ORDER BY CASE WHEN r.urgency_level = 'Emergency' THEN 0 ELSE 1 END, r.request_date IS NULL ASC, r.request_date ASC, r.request_id ASC", params);
    if (one && !requests.length) workflow.fail(404, 'Blood request not found.');
    const result = [];
    for (const request of requests) result.push(await decorateRequest(connection, request));
    await connection.commit();
    return res.status(200).json(one ? { request: result[0] } : { requests: result });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch { connection.destroy(); connection = null; } }
    return workflow.sendError(res, error, 'Unable to retrieve blood requests.');
  } finally { if (connection) connection.release(); }
}
const getRequests = (req, res) => retrieveRequests(req, res, false);
const getRequestById = (req, res) => retrieveRequests(req, res, true);
async function cancelRequest(req, res) {
  if (req.user.user_type !== 'recipient') return res.status(403).json({ message: 'Only the recipient can cancel this request.' });
  let connection;
  try {
    const id = /^\d+$/.test(req.params.requestId || '') ? Number(req.params.requestId) : null;
    if (!workflow.positiveInt(id) || (req.body !== undefined && (!req.body || Array.isArray(req.body) || typeof req.body !== 'object' || Object.keys(req.body).length))) workflow.fail(400, 'Provide a valid request ID and no body fields.');
    connection = await pool.getConnection(); await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT request_id, recipient_id, status FROM blood_requests WHERE request_id = ? AND recipient_id = ? FOR UPDATE', [id, req.user.user_id]);
    if (!rows.length) workflow.fail(404, 'Blood request not found.');
    if (!['Pending', 'Processing'].includes(rows[0].status)) workflow.fail(409, 'Only open requests can be cancelled.');
    await connection.execute('UPDATE blood_requests SET status = ? WHERE request_id = ?', ['Cancelled', id]);
    await workflow.notifyRecipient(connection, rows[0], 'Request #' + id + ' cancelled. Existing recorded donations and allocations remain in history.');
    const [donors] = await connection.execute('SELECT donor_id FROM donor_responses WHERE request_id = ? AND response = ?', [id, 'Accepted']);
    for (const donor of donors) await workflow.notifyDonor(connection, rows[0], donor.donor_id, 'Request #' + id + ' has been cancelled.');
    await connection.commit();
    return res.json({ message: 'Blood request cancelled.', request_id: id, status: 'Cancelled' });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch { connection.destroy(); connection = null; } }
    return workflow.sendError(res, error, 'Unable to cancel blood request.');
  } finally { if (connection) connection.release(); }
}
module.exports = { createRequest, getRequests, getRequestById, cancelRequest };
