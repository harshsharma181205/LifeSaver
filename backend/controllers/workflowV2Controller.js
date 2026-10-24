const pool = require('../db');
const config = require('../services/workflowV2Config');
const requests = require('../services/cityWideRequestService');
const workflow = require('../services/fulfillmentService');

function sendError(res, error) {
  if ([400, 403, 404, 409, 503].includes(error.status)) return res.status(error.status).json({ message: error.message });
  return workflow.sendError(res, error, 'Unable to complete this request.');
}
async function getWorkflowConfig(req, res) {
  let ready = false;
  if (config.isEnabled()) { try { await config.assertReady(pool); ready = true; } catch {} }
  return res.json({ workflow_v2_enabled: ready });
}
function requestHandler(action) {
  return async (req, res, next) => {
    const newPayload = action === 'create' && req.body && Object.hasOwn(req.body, 'admission_hospital_id');
    if (!config.isEnabled()) {
      if (newPayload) return res.status(503).json({ message: 'The new request workflow is not activated yet.' });
      return next();
    }
    // Purane create payload V1 hi rahenge; admission ko guess nahi karenge.
    if (action === 'create' && !newPayload) return next();
    try {
      let result;
      if (action === 'create') result = await requests.create(req.user, req.body);
      if (action === 'list') result = await requests.retrieve(req.user);
      if (action === 'detail') result = await requests.retrieve(req.user, req.params.requestId);
      if (action === 'queue') result = await requests.queue(req.user, req.query);
      if (action === 'cancel') result = await requests.cancel(req.user, req.params.requestId, req.body);
      if (action === 'donorMatches') result = await requests.donorMatches(req.user);
      return res.status(action === 'create' ? 201 : 200).json(result);
    } catch (error) { return sendError(res, error); }
  };
}
function clinicalHandler(action) {
  return async (req, res, next) => {
    if (!config.isEnabled()) return next();
    try {
      if (!['organization', 'blood_bank'].includes(req.user.user_type)) workflow.fail(403, 'An authorized Blood Bank account is required.');
      await config.assertReady(pool);
      const requestId = requests.id(req.params.request_id);
      const [rows] = await pool.execute('SELECT workflow_version FROM blood_requests WHERE request_id = ? LIMIT 1', [requestId]);
      if (!rows.length || rows[0].workflow_version !== 2) return next();
      const result = await require('../services/cityWideClinicalService').runAction(req.user, requestId, action, req.body ?? {});
      return res.status(200).json(result);
    } catch (error) { return sendError(res, error); }
  };
}
async function donorResponse(req, res, next) {
  if (!config.isEnabled()) return next();
  try {
    if (req.user.user_type !== 'donor') workflow.fail(403, 'Only donors can respond to blood requests.');
    await config.assertReady(pool);
    const requestId = requests.id(req.params.request_id);
    const [rows] = await pool.execute('SELECT workflow_version FROM blood_requests WHERE request_id = ? LIMIT 1', [requestId]);
    if (!rows.length || rows[0].workflow_version !== 2) return next();
    const result = await requests.respond(req.user, requestId, req.body);
    return res.status(201).json(result);
  } catch (error) { return sendError(res, error); }
}
function directoryHandler(citiesOnly) {
  return async (req, res, next) => {
    if (!req.query.organization_type) return next();
    if (!config.isEnabled()) return res.status(503).json({ message: 'The new directory is not activated yet.' });
    try { return res.json(await requests.directory(req.query, citiesOnly)); }
    catch (error) { return sendError(res, error); }
  };
}
module.exports = { getWorkflowConfig, requestHandler, clinicalHandler, donorResponse, directoryHandler, sendError };
