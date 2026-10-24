const pool = require('../db');
const { findMatchingRequests } = require('../services/donorMatchingService');
const { randomBytes, scrypt } = require('crypto');
const { promisify } = require('util');
const hashPassword = promisify(scrypt);
const { normalizeState, normalizeCity, sameCity } = require('../services/locationService');
const workflow = require('../services/fulfillmentService');

// Check that a date is a real calendar date in YYYY-MM-DD format.
function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number(value.slice(0, 4)) >= 1000 &&
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function registerDonor(req, res) {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'Send a JSON object with donor details.' });
    }

    const { name, gender, blood_group, date_of_birth, phone, password } = req.body;
    const requiredFields = { name, gender, blood_group, date_of_birth, phone, password };
    for (const [field, value] of Object.entries(requiredFields)) {
      if (typeof value !== 'string' || value.trim() === '') {
        return res.status(400).json({ message: field + ' is required and must be a non-empty string.' });
      }
    }

    if (name.trim().length > 100 || phone.trim().length > 15) {
      return res.status(400).json({ message: 'name must be at most 100 characters and phone at most 15 characters.' });
    }
    // Keep phone numbers as strings so leading zeros and an optional + are preserved.
    if (!/^\+?\d{10,15}$/.test(phone.trim())) {
      return res.status(400).json({ message: 'phone must contain 10 to 15 digits, optionally starting with +, and be at most 15 characters in total.' });
    }
    if (password.trim().length < 8) {
      return res.status(400).json({ message: 'password must contain at least 8 characters excluding leading and trailing whitespace.' });
    }
    if (!['Male', 'Female', 'Other'].includes(gender)) {
      return res.status(400).json({ message: 'gender must be Male, Female, or Other.' });
    }
    if (!['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].includes(blood_group)) {
      return res.status(400).json({ message: 'Invalid blood_group.' });
    }
    if (!isValidDate(date_of_birth)) {
      return res.status(400).json({ message: 'date_of_birth must be a valid date in YYYY-MM-DD format.' });
    }

    // ISO date strings can be compared directly; use the project's India timezone.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (date_of_birth > today) {
      return res.status(400).json({ message: 'date_of_birth cannot be in the future.' });
    }

    // Optional fields are stored as NULL when omitted or left blank.
    const optionalFields = { email: 100, address: 255, location: 100 };
    const optionalValues = {};
    for (const [field, maxLength] of Object.entries(optionalFields)) {
      const value = req.body[field];
      if (value != null && (typeof value !== 'string' || value.trim().length > maxLength)) {
        return res.status(400).json({ message: field + ' must be a string of at most ' + maxLength + ' characters.' });
      }
      optionalValues[field] = value == null || value.trim() === '' ? null : value.trim();
    }

    // Validate common email formats without changing optional blank/null handling.
    if (optionalValues.email !== null) {
      const email = optionalValues.email;
      const emailPattern = /^[a-zA-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,63}$/;
      const localPart = email.split('@')[0];
      if (!emailPattern.test(email) || localPart.length > 64 || localPart.startsWith('.') ||
          localPart.endsWith('.') || localPart.includes('..')) {
        return res.status(400).json({ message: 'email must be a valid email address.' });
      }
    }

    const lastDonation = req.body.last_donation == null || req.body.last_donation === ''
      ? null : req.body.last_donation;
    if (lastDonation !== null && !isValidDate(lastDonation)) {
      return res.status(400).json({ message: 'last_donation must be a valid date in YYYY-MM-DD format.' });
    }

    if (lastDonation !== null && lastDonation > today) {
      return res.status(400).json({ message: 'last_donation cannot be in the future.' });
    }
    if (lastDonation !== null && lastDonation < date_of_birth) {
      return res.status(400).json({ message: 'last_donation cannot be earlier than date_of_birth.' });
    }

    const isAvailable = req.body.is_available === undefined ? 1 : req.body.is_available;
    if (![0, 1, true, false].includes(isAvailable)) {
      return res.status(400).json({ message: 'is_available must be 0, 1, true, or false.' });
    }
    const bankId = req.body.bank_id == null ? null : req.body.bank_id;
    if (bankId !== null && (!Number.isInteger(bankId) || bankId < 1 || bankId > 2147483647)) {
      return res.status(400).json({ message: 'bank_id must be a positive integer.' });
    }

    const hasLocation = req.body.state !== undefined || req.body.city !== undefined;
    const state = hasLocation ? normalizeState(req.body.state) : null;
    const city = hasLocation ? normalizeCity(req.body.city) : null;
    if (hasLocation && (!state || !city)) return res.status(400).json({ message: 'Select a valid Indian state and city.' });

    // Store a salted hash instead of the original password.
    const salt = randomBytes(16).toString('hex');
    const key = await hashPassword(password, salt, 64);
    const passwordHash = 'scrypt:' + salt + ':' + key.toString('hex');

    // Placeholders keep user values separate from the SQL statement.
    const [result] = await pool.execute(
      'INSERT INTO donors (name, gender, blood_group, date_of_birth, phone, email, address, location, last_donation, is_available, password_hash, bank_id, state, city) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name.trim(), gender, blood_group, date_of_birth, phone.trim(), optionalValues.email,
        optionalValues.address, optionalValues.location, lastDonation, Number(isAvailable), passwordHash, bankId, state, city]
    );

    return res.status(201).json({ message: 'Donor registered successfully.', donor_id: result.insertId });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'A donor with this phone or email already exists.' });
    }
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ message: 'bank_id must refer to an existing blood bank.' });
    }
    return res.status(500).json({ message: 'Unable to register donor.' });
  }
}

async function getMatchingRequests(req, res) {
  if (req.user.user_type !== 'donor') {
    return res.status(403).json({ message: 'Only donors can view matching blood requests.' });
  }
  try {
    // Donor ID verified JWT se hi aayegi.
    const [donors] = await pool.execute('SELECT blood_group, is_available FROM donors WHERE donor_id = ? LIMIT 1', [req.user.user_id]);
    if (donors.length === 0) return res.status(404).json({ message: 'Donor account not found.' });
    const requests = await findMatchingRequests(req.user.user_id);
    return res.status(200).json({ requests });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to retrieve matching blood requests.' });
  }
}


async function updateAvailability(req, res) {
  if (req.user.user_type !== 'donor') {
    return res.status(403).json({ message: 'Only donors can change donation availability.' });
  }
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).length !== 1 || typeof req.body.is_available !== 'boolean') {
    return res.status(400).json({ message: 'Send only is_available as true or false.' });
  }
  try {
    const value = Number(req.body.is_available);
    // Owner ID JWT se aayegi; body se doosra donor select nahi hoga.
    const [result] = await pool.execute('UPDATE donors SET is_available = ? WHERE donor_id = ?', [value, req.user.user_id]);
    if (result.affectedRows === 0) {
      const [rows] = await pool.execute('SELECT donor_id FROM donors WHERE donor_id = ? LIMIT 1', [req.user.user_id]);
      if (rows.length === 0) return res.status(404).json({ message: 'Donor account not found.' });
    }
    return res.status(200).json({ message: 'Donation availability updated.', is_available: value });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to update donation availability.' });
  }
}

async function respondToRequest(req, res) {
  if (req.user.user_type !== 'donor') return res.status(403).json({ message: 'Only donors can respond to matching requests.' });
  let connection;
  try {
    const id = /^\d+$/.test(req.params.request_id || '') ? Number(req.params.request_id) : null;
    const body = req.body;
    if (!workflow.positiveInt(id) || !body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !['Accepted', 'Declined'].includes(body.response)) {
      workflow.fail(400, 'Provide a valid request_id and only response as Accepted or Declined.');
    }
    connection = await pool.getConnection(); await connection.beginTransaction();
    const [requests] = await connection.execute(
      'SELECT r.request_id, r.recipient_id, r.bank_id, r.blood_group, r.units_required, r.urgency_level, r.status, r.donor_matching_started_at, COALESCE(r.state,o.state) AS state, COALESCE(r.city,o.city) AS city FROM blood_requests r LEFT JOIN blood_banks b ON b.bank_id=r.bank_id LEFT JOIN organizations o ON o.organization_id=COALESCE(r.organization_id,b.organization_id) WHERE r.request_id = ? FOR UPDATE', [id]
    );
    if (!requests.length) workflow.fail(404, 'Blood request not found.');
    const request = requests[0];
    const [donors] = await connection.execute('SELECT donor_id, blood_group, is_available, state, city FROM donors WHERE donor_id = ? FOR UPDATE', [req.user.user_id]);
    if (!donors.length) workflow.fail(404, 'Donor account not found.');
    const [previous] = await connection.execute('SELECT response FROM donor_responses WHERE request_id = ? AND donor_id = ? FOR UPDATE', [id, req.user.user_id]);
    if (previous.length) {
      if (previous[0].response !== body.response) workflow.fail(409, 'You have already responded to this request.');
      await connection.commit();
      return res.json({ message: 'Your response is already recorded.', request_id: id, response: body.response, status: request.status });
    }
    const progress = await workflow.readProgress(connection, request, true);
    const donor = donors[0];
    workflow.requireOpen(request, progress);
    if (!request.donor_matching_started_at || !workflow.positiveInt(request.bank_id) || !['Normal','Emergency'].includes(request.urgency_level) ||
        donor.blood_group !== request.blood_group || donor.is_available !== 1 ||
        !normalizeState(donor.state) || donor.state !== request.state || !sameCity(donor.city, request.city)) {
      workflow.fail(409, 'This request is no longer eligible for your response. Check your city and availability.');
    }
    const [stock] = await connection.execute('SELECT units_available FROM blood_inventory WHERE bank_id = ? AND blood_group = ? FOR UPDATE', [request.bank_id, request.blood_group]);
    if (stock.length > 1 || (stock.length && (!Number.isInteger(stock[0].units_available) || stock[0].units_available < 0 || stock[0].units_available >= progress.remaining_units))) workflow.fail(409, 'The selected provider now has sufficient inventory.');
    await connection.execute('INSERT INTO donor_responses (request_id, donor_id, response) VALUES (?, ?, ?)', [id, req.user.user_id, body.response]);
    let status = request.status;
    if (body.response === 'Accepted') {
      status = 'Processing';
      await connection.execute('UPDATE blood_requests SET status = ? WHERE request_id = ?', [status, id]);
      await workflow.notifyRecipient(connection, request, 'A donor accepted request #' + id + '. Coordinate screening and donation through the selected organization.');
      await workflow.notifyDonor(connection, request, req.user.user_id, 'Request #' + id + ' accepted. Await authorized organization screening; no donation is recorded yet.');
    }
    await connection.commit();
    return res.status(201).json({ message: body.response === 'Accepted' ? 'Accepted. Awaiting Hospital / Blood Bank medical screening.' : 'Request declined.',
      request_id: id, response: body.response, status });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch { connection.destroy(); connection = null; } }
    return workflow.sendError(res, error, 'Unable to record your response.');
  } finally { if (connection) connection.release(); }
}
async function updateLocation(req, res) {
  if (req.user.user_type !== 'donor') return res.status(403).json({ message: 'Only donors can update their donor location.' });
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['state','city'].includes(key))) return res.status(400).json({ message: 'Send only state and city.' });
  const state = normalizeState(body.state), city = normalizeCity(body.city);
  if (!state || !city) return res.status(400).json({ message: 'Select a valid Indian state and city.' });
  try {
    const [result] = await pool.execute('UPDATE donors SET state = ?, city = ? WHERE donor_id = ?', [state, city, req.user.user_id]);
    if (!result.affectedRows) {
      const [rows] = await pool.execute('SELECT donor_id FROM donors WHERE donor_id = ? LIMIT 1', [req.user.user_id]);
      if (!rows.length) return res.status(404).json({ message: 'Donor account not found.' });
    }
    return res.json({ message: 'Donor location updated.', state, city });
  } catch { return res.status(500).json({ message: 'Unable to update donor location.' }); }
}
module.exports = { registerDonor, getMatchingRequests, updateAvailability, respondToRequest, updateLocation };
