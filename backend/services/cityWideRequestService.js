const pool = require('../db');
const workflow = require('./fulfillmentService');
const config = require('./workflowV2Config');
const policy = require('./requestAccessPolicy');
const { normalizeState, normalizeCity } = require('./locationService');
const { notifyRequestAudience } = require('./workflowV2Notifications');
const { buildSchedule } = require('./priorityScheduler');
const { coverage, ensureFallback } = require('./cityWideDonorFallback');
const groups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
    workflow.fail(400, 'Send only supported fields. Identity, status and approval are server-managed.');
  }
}
function id(value) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!workflow.positiveInt(number)) workflow.fail(400, 'Provide a valid request ID.');
  return number;
}
async function transaction(work, freshStock = false) {
  let connection;
  try {
    connection = await pool.getConnection();
    if (freshStock) await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await connection.beginTransaction();
    await config.assertReady(connection);
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch { connection.destroy(); connection = null; } }
    throw error;
  } finally { if (connection) connection.release(); }
}

async function resolveActor(user, executor) {
  if (!user || !workflow.positiveInt(user.user_id)) workflow.fail(403, 'An authenticated account is required.');
  if (['recipient', 'donor'].includes(user.user_type)) return { ...user };
  if (!['organization', 'blood_bank'].includes(user.user_type)) workflow.fail(403, 'This account cannot view requests.');
  const legacyBank = user.user_type === 'blood_bank';
  const [rows] = await executor.execute(
    legacyBank ? "SELECT b.bank_id, b.organization_id, COALESCE(o.organization_type, 'Blood Bank') AS organization_type, COALESCE(o.name,b.bank_name) AS name, o.state, o.city FROM blood_banks b LEFT JOIN organizations o ON o.organization_id = b.organization_id WHERE b.bank_id = ? LIMIT 1" :
    'SELECT o.organization_id, o.organization_type, o.name, o.state, o.city, b.bank_id FROM organizations o LEFT JOIN blood_banks b ON b.organization_id = o.organization_id WHERE o.organization_id = ? LIMIT 1',
    [user.user_id]);
  if (!rows.length || !['Hospital', 'Blood Bank'].includes(rows[0].organization_type)) workflow.fail(403, 'A registered Hospital or Blood Bank is required.');
  return { ...user, provider: rows[0] };
}
async function eligibleBanks(executor, request) {
  const [rows] = await executor.execute("SELECT b.bank_id, o.organization_id, o.name AS bank_name, o.state, o.city, o.address FROM organizations o JOIN blood_banks b ON b.organization_id = o.organization_id WHERE o.organization_type = ? ORDER BY b.bank_id", ['Blood Bank']);
  const eligible = rows.filter(row => policy.isBank({ ...row, organization_type: 'Blood Bank' }) && policy.sameLocation(row, request));
  return eligible;
}
async function create(user, body) {
  if (user.user_type !== 'recipient') workflow.fail(403, 'Only recipients can create blood requests.');
  fields(body, ['admission_hospital_id', 'state', 'city', 'blood_group', 'units_required', 'urgency_level']);
  if (!workflow.positiveInt(body.admission_hospital_id) || !groups.includes(body.blood_group) || !workflow.positiveInt(body.units_required)) {
    workflow.fail(400, 'Select an admission Hospital, valid blood group and positive units required.');
  }
  const state = normalizeState(body.state), city = normalizeCity(body.city);
  const urgency = body.urgency_level ?? 'Normal';
  if (!state || !city || !['Normal', 'Emergency'].includes(urgency)) workflow.fail(400, 'Select a valid state, city and urgency.');
  return transaction(async connection => {
    const [recipients] = await connection.execute('SELECT recipient_id FROM recipients WHERE recipient_id = ? LIMIT 1', [user.user_id]);
    if (!recipients.length) workflow.fail(404, 'Recipient not found.');
    const [hospitals] = await connection.execute('SELECT organization_id, organization_type, state, city, name FROM organizations WHERE organization_id = ? FOR SHARE', [body.admission_hospital_id]);
    const hospital = hospitals[0];
    if (!hospital || hospital.organization_type !== 'Hospital' || !policy.sameLocation(hospital, { state, city })) {
      workflow.fail(400, 'Select a registered admission Hospital in the selected state and city.');
    }
    const [result] = await connection.execute('INSERT INTO blood_requests (recipient_id, workflow_version, admission_hospital_id, state, city, blood_group, units_required, urgency_level, status) VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?)',
      [user.user_id, hospital.organization_id, normalizeState(hospital.state), normalizeCity(hospital.city), body.blood_group, body.units_required, urgency, 'Pending']);
    const request = { request_id: result.insertId, recipient_id: user.user_id, workflow_version: 2,
      admission_hospital_id: hospital.organization_id, state: hospital.state, city: hospital.city,
      blood_group: body.blood_group, units_required: body.units_required, status: 'Pending' };
    await notifyRequestAudience(connection, request, 'request:' + result.insertId + ':created', 'New blood request #' + result.insertId + ' at ' + hospital.name + '.');
    await ensureFallback(connection, request, { remaining_units: body.units_required, fulfilled_units: 0 });
    return { message: 'Blood request shared with eligible city Blood Banks.', request_id: result.insertId, workflow_version: 2 };
  }, true);
}

const requestSelect = 'SELECT r.*, h.name AS admission_hospital_name, b.bank_name, o.organization_type, o.name AS organization_name, b.address AS bank_address, b.phone AS bank_phone, b.email AS bank_email FROM blood_requests r LEFT JOIN organizations h ON h.organization_id = r.admission_hospital_id LEFT JOIN blood_banks b ON b.bank_id = r.bank_id LEFT JOIN organizations o ON o.organization_id = COALESCE(r.organization_id,b.organization_id)';
async function contributions(executor, requestId) {
  const [rows] = await executor.execute('SELECT a.allocation_id, a.inventory_id, a.donation_id, a.units_allocated, a.allocated_at, COALESCE(i.bank_id,d.bank_id) AS bank_id, b.bank_name FROM request_allocations a LEFT JOIN blood_inventory i ON i.inventory_id = a.inventory_id LEFT JOIN donations d ON d.donation_id = a.donation_id LEFT JOIN blood_banks b ON b.bank_id = COALESCE(i.bank_id,d.bank_id) WHERE a.request_id = ? ORDER BY a.allocation_id', [requestId]);
  return rows.map(row => ({ allocation_id: row.allocation_id, bank_id: row.bank_id, bank_name: row.bank_name,
    source: row.inventory_id == null ? 'Donation' : 'Inventory', units_allocated: row.units_allocated, allocated_at: row.allocated_at }));
}
async function project(executor, request, actor, ledger) {
  const progress = await workflow.readProgress(executor, request);
  const [responses] = await executor.execute('SELECT dr.donor_id, d.name, d.blood_group, d.phone, d.email, dr.screening_result, dr.screened_at, dr.collecting_bank_id, b.bank_name AS collecting_bank_name, dc.collection_id, dc.units_collected, dc.accounting_path FROM donor_responses dr JOIN donors d ON d.donor_id = dr.donor_id LEFT JOIN blood_banks b ON b.bank_id = dr.collecting_bank_id LEFT JOIN donor_collections dc ON dc.request_id = dr.request_id AND dc.donor_id = dr.donor_id WHERE dr.request_id = ? AND dr.response = ? ORDER BY dr.responded_at, d.donor_id', [request.request_id, 'Accepted']);
  const safe = {};
  for (const field of ['request_id', 'recipient_id', 'workflow_version', 'admission_hospital_id', 'admission_hospital_name', 'state', 'city', 'blood_group', 'units_required', 'urgency_level', 'status', 'request_date', 'bank_id', 'organization_id', 'organization_type', 'organization_name', 'bank_name', 'donor_matching_started_at']) safe[field] = request[field] ?? null;
  const isV2 = policy.isV2(request), provider = actor.provider;
  if (isV2 && actor.user_type !== 'recipient') delete safe.recipient_id;
  const bankViewer = isV2 && policy.isBank(provider);
  const accepted = responses.filter(row => !bankViewer || row.collecting_bank_id === provider.bank_id).map(row => {
    const { phone, email, ...publicInfo } = row;
    const contactAllowed = row.screening_result !== 'Failed' && (!isV2 || (bankViewer && row.collecting_bank_id === provider.bank_id));
    return contactAllowed ? { ...publicInfo, phone, email } : publicInfo;
  });
  if (!isV2) for (const field of ['bank_address', 'bank_phone', 'bank_email']) safe[field] = request[field];
  return { ...safe, ...progress, contributions: bankViewer ? ledger.filter(row => row.bank_id === provider.bank_id) : ledger, accepted_donors: accepted,
    can_supply: isV2 ? policy.canSupply(provider, request) : undefined };
}
async function retrieve(user, requestId) {
  const one = requestId !== undefined, requestedId = one ? id(requestId) : null;
  return transaction(async connection => {
    const actor = await resolveActor(user, connection);
    if (actor.user_type === 'donor') workflow.fail(403, 'Use donor matching opportunities.');
    const params = [], conditions = [];
    if (one) { conditions.push('r.request_id = ?'); params.push(requestedId); }
    if (user.user_type === 'recipient') { conditions.push('r.recipient_id = ?'); params.push(user.user_id); }
    else { conditions.push('(r.workflow_version = 2 OR r.bank_id = ?)'); params.push(actor.provider.bank_id ?? 0); }
    const [rows] = await connection.execute(requestSelect + ' WHERE ' + conditions.join(' AND ') + ' ORDER BY r.request_id', params);
    const requests = [];
    for (const row of rows) {
      const ledger = await contributions(connection, row.request_id);
      const hasOwnContribution = policy.isBank(actor.provider) && ledger.some(item => item.bank_id === actor.provider.bank_id);
      let hasOwnParticipation = false;
      if (policy.isV2(row) && policy.isBank(actor.provider)) {
        const [assigned] = await connection.execute('SELECT collecting_bank_id FROM donor_responses WHERE request_id = ? AND collecting_bank_id = ? AND response = ? LIMIT 1', [row.request_id, actor.provider.bank_id, 'Accepted']);
        hasOwnParticipation = assigned.some(item => item.collecting_bank_id === actor.provider.bank_id);
      }
      if (!policy.canView(row, actor, { hasOwnContribution, hasOwnParticipation })) continue;
      requests.push(await project(connection, row, actor, ledger));
    }
    if (one && !requests.length) workflow.fail(404, 'Blood request not found.');
    return one ? { request: requests[0] } : { requests };
  });
}
async function queue(user, query) {
  if (Object.keys(query || {}).length) workflow.fail(400, 'The provider queue does not accept query overrides.');
  const data = await retrieve(user);
  let provider;
  await transaction(async connection => { provider = (await resolveActor(user, connection)).provider; });
  if (!provider) workflow.fail(403, 'A provider account is required.');
  // Hospital V2 ko review dispatch nahi, sirf admission progress dikhayega.
  const ready = data.requests.filter(row => ['Pending', 'Processing'].includes(row.status) && row.remaining_units > 0 &&
    (!policy.isV2(row) || policy.isBank(provider)));
  return { bank_id: provider.bank_id, organization_id: provider.organization_id, state: provider.state, city: provider.city, ...buildSchedule(ready) };
}
async function cancel(user, requestId, body) {
  if (user.user_type !== 'recipient') workflow.fail(403, 'Only the recipient can cancel this request.');
  fields(body ?? {}, []); const requestedId = id(requestId);
  return transaction(async connection => {
    const [rows] = await connection.execute('SELECT * FROM blood_requests WHERE request_id = ? AND recipient_id = ? FOR UPDATE', [requestedId, user.user_id]);
    if (!rows.length) workflow.fail(404, 'Blood request not found.');
    const request = rows[0];
    if (!['Pending', 'Processing'].includes(request.status)) workflow.fail(409, 'Only open requests can be cancelled.');
    await connection.execute('UPDATE blood_requests SET status = ? WHERE request_id = ?', ['Cancelled', requestedId]);
    if (policy.isV2(request)) {
      await notifyRequestAudience(connection, request, 'request:' + requestedId + ':cancelled', 'Request #' + requestedId + ' cancelled. Recorded contributions remain in history.');
      const [donors] = await connection.execute('SELECT donor_id, collecting_bank_id FROM donor_responses WHERE request_id = ? AND response = ?', [requestedId, 'Accepted']);
      for (const donor of donors) await notifyRequestAudience(connection, request, 'request:' + requestedId + ':cancelled', 'Request #' + requestedId + ' cancelled.', { donorId: donor.donor_id, ...(donor.collecting_bank_id ? { collectingBankId: donor.collecting_bank_id } : {}) });
    } else {
      await workflow.notifyRecipient(connection, request, 'Request #' + requestedId + ' cancelled. Existing history is preserved.');
      const [donors] = await connection.execute('SELECT donor_id FROM donor_responses WHERE request_id = ? AND response = ?', [requestedId, 'Accepted']);
      for (const donor of donors) await workflow.notifyDonor(connection, request, donor.donor_id, 'Request #' + requestedId + ' has been cancelled.');
    }
    return { message: 'Blood request cancelled.', request_id: requestedId, status: 'Cancelled' };
  });
}

async function donorMatches(user) {
  if (user.user_type !== 'donor') workflow.fail(403, 'Only donors can view matching requests.');
  return transaction(async connection => {
    const [donors] = await connection.execute('SELECT donor_id, blood_group, is_available, state, city FROM donors WHERE donor_id = ? LIMIT 1', [user.user_id]);
    if (!donors.length) workflow.fail(404, 'Donor account not found.');
    const donor = donors[0];
    const [requests] = await connection.execute(requestSelect + ' WHERE r.workflow_version = 2 AND (r.blood_group = ? OR EXISTS (SELECT 1 FROM donor_responses mine WHERE mine.request_id = r.request_id AND mine.donor_id = ? AND mine.response = ?))', [donor.blood_group, user.user_id, 'Accepted']);
    const matches = [];
    for (const request of requests) {
      const [responses] = await connection.execute('SELECT dr.response, dr.screening_result, dr.collecting_bank_id, dc.collection_id, dc.units_collected, dc.accounting_path FROM donor_responses dr LEFT JOIN donor_collections dc ON dc.request_id = dr.request_id AND dc.donor_id = dr.donor_id WHERE dr.request_id = ? AND dr.donor_id = ?', [request.request_id, user.user_id]);
      const response = responses[0], accepted = response?.response === 'Accepted';
      const progress = await workflow.readProgress(connection, request);
      const banks = await eligibleBanks(connection, request);
      const needed = await coverage(connection, request, progress);
      if (!accepted && (response || donor.is_available !== 1 || !policy.sameLocation(donor, request) || donor.blood_group !== request.blood_group ||
          !request.donor_matching_started_at || !['Pending', 'Processing'].includes(request.status) || progress.remaining_units <= 0 || !needed.donor_units_needed || !banks.length)) continue;
      let collecting = banks.find(bank => bank.bank_id === response?.collecting_bank_id);
      if (accepted && !collecting) {
        const [history] = await connection.execute('SELECT bank_id, bank_name, address FROM blood_banks WHERE bank_id = ? LIMIT 1', [response.collecting_bank_id]);
        collecting = history[0];
      }
      matches.push({ request_id: request.request_id, workflow_version: 2, admission_hospital_id: request.admission_hospital_id, admission_hospital_name: request.admission_hospital_name,
        bank_id: null, organization_id: null, state: request.state, city: request.city, blood_group: request.blood_group, units_required: request.units_required,
        urgency_level: request.urgency_level, request_date: request.request_date, status: request.status, ...progress,
        donor_units_needed: needed.donor_units_needed, donor_response: response?.response ?? null,
        screening_result: response?.screening_result ?? null, collecting_bank_id: response?.collecting_bank_id ?? null, collecting_bank_name: collecting?.bank_name ?? null,
        collection_id: response?.collection_id ?? null, units_collected: response?.units_collected ?? null, accounting_path: response?.accounting_path ?? null,
        collecting_bank_address: accepted ? collecting?.address ?? null : null, eligible_collecting_banks: banks });
    }
    const legacy = await require('./donorMatchingService').findMatchingRequests(user.user_id);
    return { requests: [...matches, ...legacy] };
  }, true);
}
async function respond(user, requestId, body) {
  if (user.user_type !== 'donor') workflow.fail(403, 'Only donors can respond.');
  const requestedId = id(requestId);
  fields(body, ['response', 'collecting_bank_id']);
  if (!['Accepted', 'Declined'].includes(body.response) || (body.response === 'Accepted' && !workflow.positiveInt(body.collecting_bank_id)) ||
      (body.response === 'Declined' && body.collecting_bank_id !== undefined)) workflow.fail(400, 'Accept with an eligible collecting_bank_id, or decline without a bank.');
  return transaction(async connection => {
    const [rows] = await connection.execute('SELECT * FROM blood_requests WHERE request_id = ? FOR UPDATE', [requestedId]);
    if (!rows.length || !policy.isV2(rows[0])) workflow.fail(404, 'Blood request not found.');
    const request = rows[0];
    const [donors] = await connection.execute('SELECT donor_id, blood_group, is_available, state, city FROM donors WHERE donor_id = ? FOR UPDATE', [user.user_id]);
    if (!donors.length) workflow.fail(404, 'Donor account not found.');
    const donor = donors[0];
    const [responses] = await connection.execute('SELECT response, collecting_bank_id FROM donor_responses WHERE request_id = ? AND donor_id = ? FOR UPDATE', [requestedId, user.user_id]);
    if (responses.length) {
      if (responses[0].response !== body.response || (responses[0].collecting_bank_id ?? null) !== (body.collecting_bank_id ?? null)) workflow.fail(409, 'Your response or collecting bank is already recorded.');
      return { message: 'Your response is already recorded.', request_id: requestedId, response: body.response, collecting_bank_id: body.collecting_bank_id ?? null, status: request.status };
    }
    const progress = await workflow.readProgress(connection, request, true);
    workflow.requireOpen(request, progress);
    if (!(await coverage(connection, request, progress)).donor_units_needed) workflow.fail(409, 'Available city inventory covers the remaining demand. Additional donor support is not needed now.');
    if (!request.donor_matching_started_at || donor.is_available !== 1 || donor.blood_group !== request.blood_group || !policy.sameLocation(donor, request)) workflow.fail(409, 'This request is no longer eligible. Check your city and availability.');
    if (body.response === 'Accepted') {
      const [banks] = await connection.execute("SELECT b.bank_id, o.organization_id, o.organization_type, o.state, o.city FROM blood_banks b JOIN organizations o ON o.organization_id = b.organization_id WHERE b.bank_id = ? FOR SHARE", [body.collecting_bank_id]);
      if (!banks.length || !policy.canSupply(banks[0], request)) workflow.fail(409, 'Select an eligible registered Blood Bank in this city.');
    }
    await connection.execute('INSERT INTO donor_responses (request_id, donor_id, response, collecting_bank_id) VALUES (?, ?, ?, ?)', [requestedId, user.user_id, body.response, body.collecting_bank_id ?? null]);
    if (body.response === 'Accepted') {
      await connection.execute('UPDATE blood_requests SET status = ? WHERE request_id = ?', ['Processing', requestedId]);
      await notifyRequestAudience(connection, request, 'request:' + requestedId + ':donor:' + user.user_id + ':accepted', 'A donor accepted request #' + requestedId + '. Screening and actual collection are still required.', { donorId: user.user_id, collectingBankId: body.collecting_bank_id, cityBanks: false });
    }
    return { message: body.response === 'Accepted' ? 'Accepted. Visit your designated Blood Bank for authorized screening.' : 'Request declined.', request_id: requestedId, response: body.response, collecting_bank_id: body.collecting_bank_id ?? null, status: body.response === 'Accepted' ? 'Processing' : request.status };
  }, true);
}

async function directory(query, citiesOnly = false) {
  const type = query.organization_type;
  if (!['Hospital', 'Blood Bank'].includes(type)) workflow.fail(400, 'Select Hospital or Blood Bank.');
  const state = normalizeState(query.state), city = citiesOnly || query.city === undefined ? null : normalizeCity(query.city);
  if (!state || (!citiesOnly && query.city !== undefined && !city)) workflow.fail(400, 'Select a valid state and city.');
  return transaction(async connection => {
    const [rows] = await connection.execute('SELECT o.organization_id, o.organization_type, o.name, o.state, o.city, o.address, b.bank_id FROM organizations o LEFT JOIN blood_banks b ON b.organization_id = o.organization_id WHERE o.organization_type = ? ORDER BY o.name, o.organization_id', [type]);
    let eligible = rows.filter(row => policy.normalizeLocation(row.state) === policy.normalizeLocation(state) && normalizeCity(row.city) &&
      (!city || policy.sameLocation(row, { state, city })) && (type === 'Hospital' || workflow.positiveInt(row.bank_id)));
    if (citiesOnly) return { cities: [...new Map(eligible.map(row => [policy.normalizeLocation(row.city), normalizeCity(row.city)])).values()] };
    return { organizations: eligible };
  });
}
module.exports = { create, retrieve, queue, cancel, donorMatches, respond, directory, transaction, resolveActor, eligibleBanks, fields, id };
