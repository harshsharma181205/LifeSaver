const pool = require('../db');
const { resolveProvider } = require('../services/organizationService');
const workflow = require('../services/fulfillmentService');
const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const validUnits = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;
async function ownBank(req) {
  if (!['organization', 'blood_bank'].includes(req.user.user_type)) workflow.fail(403, 'Blood Bank access is required.');
  const provider = await resolveProvider(req.user);
  if (!provider || provider.organization_type !== 'Blood Bank') workflow.fail(403, 'Only Blood Bank organizations can manage inventory.');
  const id = req.params.bank_id === undefined ? req.body?.bank_id : (/^\d+$/.test(req.params.bank_id) ? Number(req.params.bank_id) : null);
  if (!workflow.positiveInt(id)) workflow.fail(400, 'bank_id must be a positive integer.');
  if (id !== provider.bank_id) workflow.fail(403, 'You can access only your own blood bank inventory.');
  return provider.bank_id;
}
async function createInventory(req, res) {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['bank_id','blood_group','units_available'].includes(key)) ||
        !bloodGroups.includes(body.blood_group) || !validUnits(body.units_available)) workflow.fail(400, 'Send bank_id, a valid blood_group and nonnegative integer units_available.');
    const bankId = await ownBank(req);
    const [result] = await pool.execute('INSERT INTO blood_inventory (bank_id, blood_group, units_available) VALUES (?, ?, ?)', [bankId, body.blood_group, body.units_available]);
    return res.status(201).json({ message: 'Inventory created successfully.', inventory_id: result.insertId, version: 0 });
  } catch (error) { return workflow.sendError(res, error, 'Unable to create inventory.'); }
}
async function getInventory(req, res) {
  try {
    const bankId = await ownBank(req);
    const [inventory] = await pool.execute('SELECT inventory_id, bank_id, blood_group, units_available, updated_at, version FROM blood_inventory WHERE bank_id = ? ORDER BY blood_group', [bankId]);
    return res.json({ bank_id: bankId, inventory: inventory.map(row => ({ ...row, version: Number(row.version) })) });
  } catch (error) { return workflow.sendError(res, error, 'Unable to retrieve inventory.'); }
}
async function updateInventory(req, res) {
  let connection;
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['units_available','expected_version'].includes(key)) ||
        !validUnits(body.units_available) || (body.expected_version !== undefined && (!Number.isSafeInteger(body.expected_version) || body.expected_version < 0))) {
      workflow.fail(400, 'Send nonnegative integer units_available and expected_version.');
    }
    if (!bloodGroups.includes(req.params.blood_group)) workflow.fail(400, 'Select a supported blood group.');
    const bankId = await ownBank(req);
    connection = await pool.getConnection(); await connection.beginTransaction();
    const [rows] = await connection.execute('SELECT inventory_id, units_available, version FROM blood_inventory WHERE bank_id = ? AND blood_group = ? FOR UPDATE', [bankId, req.params.blood_group]);
    let version = 0;
    if (rows.length) {
      // Existing rows require a revision, taaki purana form deducted stock restore na kare.
      if (body.expected_version === undefined) workflow.fail(400, 'expected_version is required when updating existing stock. Reload inventory first.');
      version = Number(rows[0].version);
      if (body.expected_version !== version) workflow.fail(409, 'Inventory changed. Reload the current stock before saving.');
      await connection.execute('UPDATE blood_inventory SET units_available = ?, version = version + 1 WHERE inventory_id = ?', [body.units_available, rows[0].inventory_id]);
      version++;
    } else {
      if (body.expected_version !== undefined && body.expected_version !== 0) workflow.fail(409, 'Inventory changed. Reload before saving.');
      await connection.execute('INSERT INTO blood_inventory (bank_id, blood_group, units_available) VALUES (?, ?, ?)', [bankId, req.params.blood_group, body.units_available]);
    }
    await connection.commit();
    return res.json({ message: 'Inventory updated successfully.', bank_id: bankId, blood_group: req.params.blood_group, units_available: body.units_available, version });
  } catch (error) {
    if (connection) { try { await connection.rollback(); } catch { connection.destroy(); connection = null; } }
    return workflow.sendError(res, error, 'Unable to update inventory.');
  } finally { if (connection) connection.release(); }
}
async function checkAvailability(req, res) {
  try {
    const bankId = await ownBank(req);
    if (!bloodGroups.includes(req.params.blood_group)) workflow.fail(400, 'Select a supported blood group.');
    const [rows] = await pool.execute('SELECT units_available FROM blood_inventory WHERE bank_id = ? AND blood_group = ? LIMIT 1', [bankId, req.params.blood_group]);
    const units = rows[0]?.units_available || 0;
    return res.json({ bank_id: bankId, blood_group: req.params.blood_group, units_available: units, available: units > 0 });
  } catch (error) { return workflow.sendError(res, error, 'Unable to check inventory availability.'); }
}
module.exports = { createInventory, getInventory, updateInventory, checkAvailability };
