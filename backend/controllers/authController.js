const pool = require('../db');
const { createToken } = require('../services/jwtService');
const { organizationFields, safeOrganization } = require('../services/organizationService');
const { scrypt, timingSafeEqual } = require('crypto');
const { promisify } = require('util');
const deriveKey = promisify(scrypt);
const dummyHash = 'scrypt:' + '0'.repeat(32) + ':' + '0'.repeat(128);

function loginInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Send a JSON object with phone or email and password.' };
  }

  const legacyPhone = body.identifier === undefined && body.phone !== undefined;
  const identifier = body.identifier === undefined ? (body.phone === undefined ? body.email : body.phone) : body.identifier;
  if (typeof identifier !== 'string' || !identifier.trim()) {
    return { error: 'A valid phone or email is required.' };
  }

  const value = identifier.trim();
  let column;
  if ((!legacyPhone && value.includes('@')) &&
      value.length <= 100 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) column = 'email';
  else if (value.length <= 15 && /^\+?\d{10,15}$/.test(value)) column = 'phone';
  else return { error: 'Enter a valid phone with 10 to 15 digits or a valid email.' };


  if (typeof body.password !== 'string' || body.password.trim() === '') {
    return { error: 'password is required and must be a non-empty string.' };
  }
  return { value: column === 'email' ? value.toLowerCase() : value, column, legacyPhone };
}


async function verifyPassword(password, storedHash) {
  const validHash = typeof storedHash === 'string' &&
    /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/i.test(storedHash);
  const [, salt, hexKey] = (validHash ? storedHash : dummyHash).split(':');
  const suppliedKey = await deriveKey(password, salt, 64);
  const matches = timingSafeEqual(suppliedKey, Buffer.from(hexKey, 'hex'));
  return validHash && matches;
}

async function donorLogin(req, res) {
  try {
    const input = loginInput(req.body);

    if (input.error) return res.status(400).json({ message: input.error });

    const [rows] = await pool.execute(
      'SELECT donor_id, name, blood_group, phone, email, location, is_available, password_hash FROM donors WHERE ' + input.column + ' = ? LIMIT 2',
      [input.value]
    );

    const donor = rows.length === 1 ? rows[0] : null;

    const matches = await verifyPassword(req.body.password, donor ? donor.password_hash : null);
    if (!donor || !matches) return res.status(401).json({
      message: input.legacyPhone ? 'Invalid phone or password.' : 'Invalid phone, email or password.',
    });

    return res.status(200).json({
      message: 'Donor login successful.', 
      token: createToken(donor.donor_id, 'donor'),
      donor: { 
        donor_id: donor.donor_id,
        name: donor.name,
        blood_group: donor.blood_group,
        phone: donor.phone,
        email: donor.email, 
        location: donor.location, 
        is_available: donor.is_available 
      },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to log in.' });
  }
}

async function recipientLogin(req, res) {
  try {
    const input = loginInput(req.body);
    if (input.error) return res.status(400).json({ message: input.error });

    const [rows] = await pool.execute(
      'SELECT recipient_id, name, gender, blood_group, age, phone, email, monitored_by, password_hash FROM recipients WHERE ' + input.column + ' = ? LIMIT 2',
      [input.value]
    );

    const recipient = rows.length === 1 ? rows[0] : null;
    const matches = await verifyPassword(req.body.password, recipient ? recipient.password_hash : null);
    if (!recipient || !matches) return res.status(401).json({
      message: input.legacyPhone ? 'Invalid phone or password.' : 'Invalid phone, email or password.',
    });

    return res.status(200).json({
      message: 'Recipient login successful.', token: createToken(recipient.recipient_id, 'recipient'),
      recipient: { 
        recipient_id: recipient.recipient_id, name: recipient.name, 
        gender: recipient.gender,
        blood_group: recipient.blood_group, 
        age: recipient.age, 
        phone: recipient.phone,
        email: recipient.email, 
        monitored_by: recipient.monitored_by },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to log in.' });
  }
}

async function organizationLogin(req, res) {
  try {
    const input = loginInput(req.body);
    if (input.error) return res.status(400).json({ message: input.error });

    const [rows] = await pool.execute(
      'SELECT ' + organizationFields + ', o.password_hash FROM organizations o LEFT JOIN blood_banks b ON b.organization_id = o.organization_id WHERE o.' + input.column + ' = ? LIMIT 2',
      [input.value]
    );

    const organization = rows.length === 1 ? rows[0] : null;
    const matches = await verifyPassword(req.body.password, organization ? organization.password_hash : null);

    if (!organization || !matches) return res.status(401).json({ message: 'Invalid phone, email or password.' });
    
    return res.status(200).json({
      message: 'Organization login successful.',
      token: createToken(organization.organization_id, 'organization'),
      user: { user_id: organization.organization_id, user_type: 'organization', ...safeOrganization(organization) },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to log in.' });
  }
}

async function bloodBankLogin(req, res) {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ message: 'Send a JSON object with email and password.' });
    }
    if (typeof body.email !== 'string' || body.email.trim().length > 100 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
      return res.status(400).json({ message: 'A valid email is required.' });
    }
    if (typeof body.password !== 'string' || !body.password.trim()) {
      return res.status(400).json({ message: 'password is required and must be a non-empty string.' });
    }

    const [rows] = await pool.execute(
      "SELECT b.bank_id, b.bank_name, b.email, b.phone, b.address, b.password_hash FROM blood_banks b LEFT JOIN organizations o ON o.organization_id = b.organization_id WHERE b.email = ? AND (b.organization_id IS NULL OR o.organization_type = 'Blood Bank') LIMIT 2",
      [body.email.trim()]
    );

    const bank = rows.length === 1 ? rows[0] : null;
    const matches = await verifyPassword(body.password, bank ? bank.password_hash : null);

    if (!bank || !matches) return res.status(401).json({ message: 'Invalid email or password.' });

    return res.status(200).json({
      message: 'Blood Bank login successful.', 
      token: createToken(bank.bank_id, 'blood_bank'),
      user: { user_id: bank.bank_id, 
      user_type: 'blood_bank', 
      bank_name: bank.bank_name,
      email: bank.email, 
      phone: bank.phone, address: bank.address },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to log in.' });
  }
}

async function getCurrentUser(req, res) {
  try {
    if (req.user.user_type === 'organization') {
      const [rows] = await pool.execute(
        'SELECT ' + organizationFields + ' FROM organizations o LEFT JOIN blood_banks b ON b.organization_id = o.organization_id WHERE o.organization_id = ? LIMIT 1',
        [req.user.user_id]
      );
      if (!rows.length) return res.status(404).json({ message: 'Account not found.' });

      return res.status(200).json({ user_id: req.user.user_id, user_type: 'organization', ...safeOrganization(rows[0]) });
    }

    if (req.user.user_type === 'blood_bank') {
      const [rows] = await pool.execute(
        "SELECT b.bank_id, b.bank_name, b.email, b.phone, b.address, b.organization_id, COALESCE(o.organization_type, 'Blood Bank') AS organization_type, o.state, o.city FROM blood_banks b LEFT JOIN organizations o ON o.organization_id = b.organization_id WHERE b.bank_id = ? LIMIT 1",
        [req.user.user_id]
      );

      if (!rows.length) return res.status(404).json({ message: 'Account not found.' });
      
      const bank = rows[0];
      return res.status(200).json({ 
        user_id: req.user.user_id, 
        user_type: 'blood_bank',
        bank_id: bank.bank_id, 
        bank_name: bank.bank_name, 
        email: bank.email, 
        phone: bank.phone,
        address: bank.address, 
        organization_id: bank.organization_id || null,
        organization_type: bank.organization_type, 
        state: bank.state || null, 
        city: bank.city || null });
    }
    const sql = req.user.user_type === 'recipient'
      ? 'SELECT name FROM recipients WHERE recipient_id = ? LIMIT 1'
      : 'SELECT name, blood_group, location, state, city, is_available FROM donors WHERE donor_id = ? LIMIT 1';
    const [rows] = await pool.execute(sql, [req.user.user_id]);
    if (!rows.length) return res.status(404).json({ message: 'Account not found.' });
    return res.status(200).json({
      user_id: req.user.user_id, user_type: req.user.user_type, name: rows[0].name,
      ...(req.user.user_type === 'donor' ? {
        blood_group: rows[0].blood_group, location: rows[0].location,
        state: rows[0].state || null, city: rows[0].city || null, is_available: rows[0].is_available,
      } : {}),
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to retrieve your profile.' });
  }
}

module.exports = { donorLogin, recipientLogin, organizationLogin, bloodBankLogin, getCurrentUser };
