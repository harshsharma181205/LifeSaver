const pool = require('../db');
const { resolveProvider } = require('./organizationService');
const config = require('./workflowV2Config');
const { requireSupply, isBank } = require('./requestAccessPolicy');
const { notifyRequestAudience } = require('./workflowV2Notifications');
const { ensureFallback } = require('./cityWideDonorFallback');
const workflow = require('./fulfillmentService');

const groups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const paths = ['DirectRequest', 'Inventory'];

function validateBody(action, body) {
  const allowed = {
    allocate: ['operation_key'], match: [], screen: ['donor_id', 'result'],
    collect: ['donor_id', 'units_donated', 'operation_key', 'accounting_path'],
  };
  if (!Object.hasOwn(allowed, action) || !body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed[action].includes(key))) {
    workflow.fail(400, 'Send only supported fields for this clinical action.');
  }
  if (['allocate', 'collect'].includes(action) && !workflow.validKey(body.operation_key)) {
    workflow.fail(400, 'A UUID operation_key is required.');
  }
  if (['screen', 'collect'].includes(action) && !workflow.positiveInt(body.donor_id)) {
    workflow.fail(400, 'donor_id must be a positive integer.');
  }
  if (action === 'screen' && !['Passed', 'Failed'].includes(body.result)) {
    workflow.fail(400, 'result must be Passed or Failed.');
  }
  if (action === 'collect' && (!workflow.positiveInt(body.units_donated) ||
      (body.accounting_path !== undefined && !paths.includes(body.accounting_path)))) {
    workflow.fail(400, 'Send positive units_donated and a valid accounting_path.');
  }
}

async function allocationByKey(connection, id, key) {
  const [rows] = await connection.execute(
    'SELECT allocation_id, inventory_id, donation_id, collection_id, actor_bank_id, units_allocated FROM request_allocations WHERE request_id = ? AND operation_key = ? FOR UPDATE',
    [id, key]
  );
  return rows[0];
}

async function collectionByKey(connection, id, key) {
  const [rows] = await connection.execute(
    'SELECT collection_id, request_id, donor_id, bank_id, donation_id, accounting_path, inventory_id, units_collected, operation_key FROM donor_collections WHERE request_id = ? AND operation_key = ? FOR UPDATE',
    [id, key]
  );
  return rows[0];
}

async function lockDonorResponse(connection, request, provider, donorId) {
  const [donors] = await connection.execute('SELECT donor_id, blood_group FROM donors WHERE donor_id = ? FOR UPDATE', [donorId]);
  const [responses] = await connection.execute(
    'SELECT response, collecting_bank_id, screening_result, screened_by_organization_id FROM donor_responses WHERE request_id = ? AND donor_id = ? FOR UPDATE',
    [request.request_id, donorId]
  );
  if (!responses.length || responses[0].collecting_bank_id !== provider.bank_id) {
    workflow.fail(403, 'Only the designated collecting Blood Bank can perform this action.');
  }
  if (!donors.length || donors[0].blood_group !== request.blood_group || responses[0].response !== 'Accepted') {
    workflow.fail(409, 'An accepted donor with the matching blood group is required.');
  }
  return responses[0];
}

async function ownStock(connection, request, provider) {
  const [rows] = await connection.execute(
    'SELECT inventory_id, bank_id, blood_group, units_available, version FROM blood_inventory WHERE bank_id = ? AND blood_group = ? FOR UPDATE',
    [provider.bank_id, request.blood_group]
  );
  if (rows.length > 1 || (rows[0] && (!workflow.positiveInt(rows[0].inventory_id) ||
      rows[0].bank_id !== provider.bank_id || rows[0].blood_group !== request.blood_group ||
      !Number.isInteger(rows[0].units_available) || rows[0].units_available < 0))) {
    workflow.fail(409, 'Inventory contains inconsistent data.');
  }
  return rows[0];
}

async function notifyFulfilled(connection, request, current) {
  if (current.remaining_units !== 0) return;
  const [accepted] = await connection.execute(
    'SELECT donor_id, collecting_bank_id FROM donor_responses WHERE request_id = ? AND response = ?',
    [request.request_id, 'Accepted']
  );
  for (const donor of accepted) {
    const options = { cityBanks: false, donorId: donor.donor_id };
    if (workflow.positiveInt(donor.collecting_bank_id)) options.collectingBankId = donor.collecting_bank_id;
    await notifyRequestAudience(connection, request, 'fulfilled',
      'Request #' + request.request_id + ' is fulfilled. Further collection for this request is not needed.', options);
  }
}

async function allocate({ connection, request, provider, progress }, body) {
  const key = body.operation_key.toLowerCase();
  const previous = await allocationByKey(connection, request.request_id, key);
  if (previous) {
    if (previous.actor_bank_id !== provider.bank_id || !previous.inventory_id || previous.donation_id || previous.collection_id) {
      workflow.fail(409, 'This operation_key was used for a different action.');
    }
    return { message: 'Inventory allocation already recorded.', allocated_units: previous.units_allocated,
      allocation_id: previous.allocation_id, status: request.status, ...progress };
  }
  if (await collectionByKey(connection, request.request_id, key)) workflow.fail(409, 'This operation_key was used for a different action.');
  workflow.requireOpen(request, progress);
  const stock = await ownStock(connection, request, provider);
  const units = Math.min(stock ? stock.units_available : 0, progress.remaining_units);
  if (!units) {
    const fallback = await ensureFallback(connection, request, progress, { collectingBankId: provider.bank_id });
    return { message: fallback.donor_units_needed ? 'No own stock is available. Eligible local donor fallback checked.' :
      'Other eligible city Blood Banks can cover the remaining demand.', allocated_units: 0, status: request.status, ...progress, ...fallback };
  }
  const [changed] = await connection.execute(
    'UPDATE blood_inventory SET units_available = units_available - ?, version = version + 1 WHERE inventory_id = ? AND bank_id = ? AND units_available >= ?',
    [units, stock.inventory_id, provider.bank_id, units]
  );
  if (changed.affectedRows !== 1) workflow.fail(409, 'Inventory changed. Refresh before retrying.');
  const [inserted] = await connection.execute(
    'INSERT INTO request_allocations (request_id, donation_id, inventory_id, units_allocated, operation_key, actor_bank_id) VALUES (?, NULL, ?, ?, ?, ?)',
    [request.request_id, stock.inventory_id, units, key, provider.bank_id]
  );
  const current = await workflow.updateStatus(connection, request);
  await notifyRequestAudience(connection, request, 'allocation:' + key,
    'Request #' + request.request_id + ': ' + units + ' inventory units supplied. ' + current.remaining_units + ' units remain.',
    { collectingBankId: provider.bank_id });
  await notifyFulfilled(connection, request, current);
  const fallback = await ensureFallback(connection, { ...request, status: current.status }, current, { collectingBankId: provider.bank_id });
  return { message: current.remaining_units ? 'Request partially fulfilled.' : 'Blood request fulfilled.',
    allocation_id: inserted.insertId, allocated_units: units, ...current, ...fallback };
}

async function match({ connection, request, provider, progress }) {
  workflow.requireOpen(request, progress);
  const fallback = await ensureFallback(connection, request, progress, { collectingBankId: provider.bank_id });
  return { message: 'Eligible local donors checked. Acceptance and screening do not record a donation.',
    allocated_units: 0, status: request.status, ...progress, ...fallback };
}

async function screen({ connection, request, provider, progress }, body) {
  const response = await lockDonorResponse(connection, request, provider, body.donor_id);
  workflow.requireOpen(request, progress);
  if (!workflow.positiveInt(provider.organization_id)) workflow.fail(409, 'Complete Blood Bank organization setup first.');
  if (response.screening_result) {
    if (response.screening_result !== body.result || response.screened_by_organization_id !== provider.organization_id) {
      workflow.fail(409, 'Screening is already recorded.');
    }
    return { message: 'Screening already recorded.', donor_id: body.donor_id,
      screening_result: body.result, status: request.status, ...progress };
  }
  await connection.execute(
    'UPDATE donor_responses SET screening_result = ?, screened_at = CURRENT_TIMESTAMP, screened_by_organization_id = ? WHERE request_id = ? AND donor_id = ? AND collecting_bank_id = ?',
    [body.result, provider.organization_id, request.request_id, body.donor_id, provider.bank_id]
  );
  await notifyRequestAudience(connection, request, 'screening:' + body.donor_id,
    'Request #' + request.request_id + ': screening ' + body.result.toLowerCase() + '. No donation recorded yet.',
    { donorId: body.donor_id, collectingBankId: provider.bank_id, cityBanks: false });
  return { message: 'Screening recorded.', donor_id: body.donor_id, screening_result: body.result,
    status: request.status, ...progress };
}

async function collect({ connection, request, provider, progress }, body) {
  const key = body.operation_key.toLowerCase();
  const path = body.accounting_path || 'DirectRequest';
  const previous = await collectionByKey(connection, request.request_id, key);
  if (previous) {
    if (previous.bank_id !== provider.bank_id || previous.donor_id !== body.donor_id ||
        previous.units_collected !== body.units_donated || previous.accounting_path !== path) {
      workflow.fail(409, 'This operation_key was used for different collection details.');
    }
    return { message: 'Actual collection already recorded.', collection_id: previous.collection_id,
      donation_id: previous.donation_id, accounting_path: path, units_collected: previous.units_collected,
      allocated_units: path === 'DirectRequest' ? previous.units_collected : 0, status: request.status, ...progress };
  }
  if (await allocationByKey(connection, request.request_id, key)) workflow.fail(409, 'This operation_key was used for a different action.');
  const response = await lockDonorResponse(connection, request, provider, body.donor_id);
  workflow.requireOpen(request, progress);
  if (path === 'DirectRequest' && body.units_donated > progress.remaining_units) workflow.fail(409, 'Collection exceeds the remaining requested units.');
  if (response.screening_result !== 'Passed' || response.screened_by_organization_id !== provider.organization_id ||
      !workflow.positiveInt(provider.organization_id)) {
    workflow.fail(409, 'The accepted donor must pass screening at this collecting Blood Bank first.');
  }
  const [recorded] = await connection.execute(
    'SELECT collection_id FROM donor_collections WHERE request_id = ? AND donor_id = ? FOR UPDATE',
    [request.request_id, body.donor_id]
  );
  if (recorded.length) workflow.fail(409, 'This donor collection is already recorded. A new key cannot record it again.');
  let inventoryId = null;
  if (path === 'Inventory') {
    const stock = await ownStock(connection, request, provider);
    if (stock) {
      if (stock.units_available + body.units_donated > 2147483647) workflow.fail(409, 'Inventory quantity limit would be exceeded.');
      const [changed] = await connection.execute(
        'UPDATE blood_inventory SET units_available = units_available + ?, version = version + 1 WHERE inventory_id = ? AND bank_id = ?',
        [body.units_donated, stock.inventory_id, provider.bank_id]
      );
      if (changed.affectedRows !== 1) workflow.fail(409, 'Inventory changed. Refresh before retrying.');
      inventoryId = stock.inventory_id;
    } else {
      const [stockCreated] = await connection.execute(
        'INSERT INTO blood_inventory (bank_id, blood_group, units_available) VALUES (?, ?, ?)',
        [provider.bank_id, request.blood_group, body.units_donated]
      );
      inventoryId = stockCreated.insertId;
    }
  }
  // Ek real collection ka accounting sirf ek path par hoga.
  const [donation] = await connection.execute(
    'INSERT INTO donations (donor_id, bank_id, blood_group, units_donated) VALUES (?, ?, ?, ?)',
    [body.donor_id, provider.bank_id, request.blood_group, body.units_donated]
  );
  const [collection] = await connection.execute(
    'INSERT INTO donor_collections (request_id, donor_id, bank_id, donation_id, accounting_path, inventory_id, units_collected, operation_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [request.request_id, body.donor_id, provider.bank_id, donation.insertId, path, inventoryId, body.units_donated, key]
  );
  if (path === 'DirectRequest') {
    await connection.execute(
      'INSERT INTO request_allocations (request_id, donation_id, inventory_id, units_allocated, operation_key, actor_bank_id, collection_id) VALUES (?, ?, NULL, ?, ?, ?, ?)',
      [request.request_id, donation.insertId, body.units_donated, key, provider.bank_id, collection.insertId]
    );
  }
  await connection.execute('UPDATE donors SET last_donation = CURRENT_DATE WHERE donor_id = ?', [body.donor_id]);
  const current = path === 'DirectRequest' ? await workflow.updateStatus(connection, request) : { status: request.status, ...progress };
  await notifyRequestAudience(connection, request, 'collection:' + key,
    'Request #' + request.request_id + ': actual collection recorded' +
      (path === 'DirectRequest' ? '. ' + current.remaining_units + ' units remain.' : ' into Blood Bank inventory. Request fulfillment is unchanged.'),
    { donorId: body.donor_id, collectingBankId: provider.bank_id });
  await notifyFulfilled(connection, request, current);
  const fallback = await ensureFallback(connection, { ...request, status: current.status }, current, { collectingBankId: provider.bank_id });
  return { message: path === 'DirectRequest' ? 'Actual donation contributed to the request.' : 'Actual donation added only to own inventory.',
    collection_id: collection.insertId, donation_id: donation.insertId, accounting_path: path,
    units_collected: body.units_donated, allocated_units: path === 'DirectRequest' ? body.units_donated : 0, ...current, ...fallback };
}

async function runAction(user, requestId, action, body = {}) {
  if (!config.isEnabled()) workflow.fail(503, 'The city-wide workflow is not enabled.');
  if (!workflow.positiveInt(requestId)) workflow.fail(400, 'request_id must be a positive integer.');
  if (!user || !['organization', 'blood_bank'].includes(user.user_type)) workflow.fail(403, 'An authorized Blood Bank account is required.');
  validateBody(action, body);
  let connection;
  try {
    connection = await pool.getConnection();
    // Fresh city stock dekhenge; request aur own-stock row locks waise hi rahenge.
    await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await connection.beginTransaction();
    await config.assertReady(connection);
    // Shared request lock sab banks ki combined fulfillment ko serialize karega.
    const [requests] = await connection.execute('SELECT * FROM blood_requests WHERE request_id = ? FOR UPDATE', [requestId]);
    if (!requests.length) workflow.fail(404, 'Blood request not found.');
    const request = requests[0];
    if (request.workflow_version !== 2) workflow.fail(409, 'This action requires a city-wide workflow request.');
    const provider = await resolveProvider(user, connection, { lock: true });
    if (action === 'screen' || action === 'collect') {
      // Collection assignment authority hai; city eligibility sirf supply/matching ke liye hai.
      if (!isBank(provider)) workflow.fail(403, 'An authorized collecting Blood Bank is required.');
    } else await requireSupply(provider, request, { allowClosedReplay: true });
    if (!workflow.positiveInt(request.units_required) || !workflow.positiveInt(request.recipient_id) ||
        !groups.includes(request.blood_group) || !['Normal', 'Emergency'].includes(request.urgency_level) ||
        !['Pending', 'Processing', 'Fulfilled', 'Cancelled'].includes(request.status)) {
      workflow.fail(409, 'Blood request contains inconsistent data.');
    }
    const progress = await workflow.readProgress(connection, request, true);
    const actions = { allocate, match, screen, collect };
    const result = await actions[action]({ connection, request, provider, progress }, body);
    await connection.commit();
    return { request_id: requestId, bank_id: provider.bank_id, actor_bank_id: provider.bank_id,
      organization_id: provider.organization_id, ...result };
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); }
      catch { connection.destroy(); connection = null; }
    }
    if (!(error instanceof workflow.WorkflowError) && [400, 401, 403, 404, 409, 503].includes(error.status)) {
      workflow.fail(error.status, error.message);
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { runAction };
