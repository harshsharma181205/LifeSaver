const pool = require('../db');
const { randomBytes, scrypt } = require('crypto');
const { promisify } = require('util');
const { INDIAN_STATES, normalizeState, normalizeCity } = require('../services/locationService');
const { organizationFields, safeOrganization } = require('../services/organizationService');
const deriveKey = promisify(scrypt);
const types = ['Hospital', 'Blood Bank', 'NGO'];
const workflowV2 = require('../services/workflowV2Config');

function registrationInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Send a JSON object with organization details.' };
  }
  const allowed = ['organization_type', 'name', 'state', 'city', 'address', 'phone', 'email', 'password'];
  if (Object.keys(body).some(key => !allowed.includes(key))) {
    return { error: 'Organization registration contains an unsupported field.' };
  }
  if (!types.includes(body.organization_type)) return { error: 'Choose Hospital, Blood Bank or NGO.' };
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) {
    return { error: 'name is required and must be at most 100 characters.' };
  }
  if (typeof body.address !== 'string' || !body.address.trim() || body.address.trim().length > 255) {
    return { error: 'address is required and must be at most 255 characters.' };
  }
  const state = normalizeState(body.state);
  const city = normalizeCity(body.city);
  if (!state || !city) return { error: 'Choose a valid Indian state or Union Territory and enter a valid city.' };
  if (typeof body.phone !== 'string' || body.phone.trim().length > 15 ||
      !/^\+?\d{10,15}$/.test(body.phone.trim())) {
    return { error: 'phone must contain 10 to 15 digits and be at most 15 characters in total.' };
  }
  if (typeof body.email !== 'string' || body.email.trim().length > 100 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
    return { error: 'A valid email of at most 100 characters is required.' };
  }
  if (typeof body.password !== 'string' || body.password.trim().length < 8 || body.password.length > 128) {
    return { error: 'password must contain at least 8 characters excluding outer whitespace and be at most 128 characters.' };
  }
  return { value: { organization_type: body.organization_type, name: body.name.trim(),
    state, city, address: body.address.trim(), phone: body.phone.trim(),
    email: body.email.trim().toLowerCase(), password: body.password } };
}

async function registerOrganization(req, res) {
  let connection;
  try {
    const input = registrationInput(req.body);
    if (input.error) return res.status(400).json({ message: input.error });
    const value = input.value;
    const v2 = workflowV2.isEnabled();
    if (v2) await workflowV2.assertReady(pool);
    const salt = randomBytes(16).toString('hex');
    const key = await deriveKey(value.password, salt, 64);
    const passwordHash = 'scrypt:' + salt + ':' + key.toString('hex');
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.execute(
      'INSERT INTO organizations (organization_type, name, state, city, address, phone, email, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [value.organization_type, value.name, value.state, value.city, value.address, value.phone, value.email, passwordHash]
    );
    const organizationId = result.insertId;
    let bankId = null;
    if (value.organization_type === 'Blood Bank' || (!v2 && value.organization_type === 'Hospital')) {
      // Preserve existing bank foreign keys by giving each clinical provider one operational bank record.
      const [bank] = await connection.execute(
        'INSERT INTO blood_banks (organization_id, bank_name, address, phone, email, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
        [organizationId, value.name, value.address, value.phone, value.email, passwordHash]
      );
      bankId = bank.insertId;
    }
    await connection.commit();
    return res.status(201).json({
      message: 'Organization registered successfully.',
      organization: safeOrganization({ ...value, organization_id: organizationId, bank_id: bankId }),
    });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); }
      catch { connection.destroy(); connection = null; }
    }
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'An organization with this phone or email is already registered.' });
    }
    if (error.status === 503) return res.status(503).json({ message: error.message });
    return res.status(500).json({ message: 'Unable to register organization.' });
  } finally {
    if (connection) connection.release();
  }
}

function listStates(req, res) {
  return res.status(200).json({ states: INDIAN_STATES });
}

async function listCities(req, res) {
  try {
    const state = normalizeState(req.query.state);
    if (!state) return res.status(400).json({ message: 'Select a valid Indian state or Union Territory.' });
    const [rows] = await pool.execute(
      "SELECT DISTINCT o.city FROM organizations o INNER JOIN blood_banks b ON b.organization_id = o.organization_id WHERE o.state = ? AND o.city IS NOT NULL AND o.organization_type IN ('Hospital', 'Blood Bank') ORDER BY o.city",
      [state]
    );
    const cities = new Map();
    for (const row of rows) {
      const city = normalizeCity(row.city);
      if (city && !cities.has(city.toLowerCase())) cities.set(city.toLowerCase(), city);
    }
    return res.status(200).json({ cities: [...cities.values()] });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to retrieve registered provider cities.' });
  }
}

async function listOrganizations(req, res) {
  try {
    const predicates = ["o.organization_type IN ('Hospital', 'Blood Bank')", 'o.state IS NOT NULL', 'o.city IS NOT NULL'];
    const values = [];
    if (req.query.state !== undefined) {
      const state = normalizeState(req.query.state);
      if (!state) return res.status(400).json({ message: 'Select a valid Indian state or Union Territory.' });
      predicates.push('o.state = ?'); values.push(state);
    }
    if (req.query.city !== undefined) {
      const city = normalizeCity(req.query.city);
      if (!city || !values.length) return res.status(400).json({ message: 'Select a valid state and city.' });
      predicates.push('LOWER(o.city) = LOWER(?)'); values.push(city);
    }
    const [rows] = await pool.execute(
      'SELECT o.organization_id, o.organization_type, o.name, o.state, o.city, o.address, b.bank_id FROM organizations o INNER JOIN blood_banks b ON b.organization_id = o.organization_id WHERE ' + predicates.join(' AND ') + ' ORDER BY o.name, o.organization_id',
      values
    );
    return res.status(200).json({ organizations: rows });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to retrieve registered organizations.' });
  }
}

async function updateOrganizationLocation(req, res) {
  let connection;
  try {
    if (!['organization', 'blood_bank'].includes(req.user.user_type)) {
      return res.status(403).json({ message: 'Only an organization can update its location.' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['state', 'city'].includes(key))) {
      return res.status(400).json({ message: 'Send only state and city.' });
    }
    const state = normalizeState(body.state);
    const city = normalizeCity(body.city);
    if (!state || !city) return res.status(400).json({ message: 'Choose a valid Indian state or Union Territory and enter a valid city.' });
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const column = req.user.user_type === 'organization' ? 'o.organization_id' : 'b.bank_id';
    const [rows] = await connection.execute(
      'SELECT ' + organizationFields + ' FROM organizations o LEFT JOIN blood_banks b ON b.organization_id = o.organization_id WHERE ' + column + ' = ? LIMIT 1 FOR UPDATE',
      [req.user.user_id]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ message: 'Organization account not found.' });
    }
    await connection.execute('UPDATE organizations SET state = ?, city = ? WHERE organization_id = ?',
      [state, city, rows[0].organization_id]);
    await connection.commit();
    // Existing request locations are historical snapshots and are never changed here.
    return res.status(200).json({
      message: 'Organization location updated.', organization: safeOrganization({ ...rows[0], state, city }),
    });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); }
      catch { connection.destroy(); connection = null; }
    }
    return res.status(500).json({ message: 'Unable to update organization location.' });
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { registerOrganization, listStates, listCities, listOrganizations, updateOrganizationLocation };

