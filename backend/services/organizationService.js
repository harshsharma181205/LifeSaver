const pool = require('../db');

const organizationFields = 'o.organization_id, o.organization_type, o.name, o.state, o.city, o.address, o.phone, o.email, b.bank_id';

function safeOrganization(row) {
  return {
    organization_id: row.organization_id, organization_type: row.organization_type,
    name: row.name, state: row.state, city: row.city, address: row.address,
    phone: row.phone, email: row.email, bank_id: row.bank_id || null,
  };
}

function isClinicalProvider(provider) {
  return !!provider && Number.isSafeInteger(Number(provider.bank_id)) && Number(provider.bank_id) > 0 &&
    ['Hospital', 'Blood Bank'].includes(provider.organization_type);
}

// JWT types identify accounts; clinical permission always comes from the current DB row.
async function resolveProvider(user, executor = pool, options = {}) {
  if (!user || !Number.isSafeInteger(user.user_id) || user.user_id < 1) return null;
  let rows;
  if (user.user_type === 'organization') {
    [rows] = await executor.execute(
      'SELECT ' + organizationFields + ' FROM organizations o LEFT JOIN blood_banks b ON b.organization_id = o.organization_id WHERE o.organization_id = ? LIMIT 1' + (options.lock ? ' FOR SHARE' : ''),
      [user.user_id]
    );
  } else if (user.user_type === 'blood_bank') {
    [rows] = await executor.execute(
      "SELECT b.bank_id, b.organization_id, COALESCE(o.organization_type, 'Blood Bank') AS organization_type, COALESCE(o.name, b.bank_name) AS name, o.state, o.city, COALESCE(o.address, b.address) AS address, COALESCE(o.phone, b.phone) AS phone, COALESCE(o.email, b.email) AS email FROM blood_banks b LEFT JOIN organizations o ON o.organization_id = b.organization_id WHERE b.bank_id = ? LIMIT 1" + (options.lock ? ' FOR SHARE' : ''),
      [user.user_id]
    );
  } else {
    return null;
  }
  return isClinicalProvider(rows[0]) ? rows[0] : null;
}

module.exports = { organizationFields, safeOrganization, resolveProvider, isClinicalProvider };
