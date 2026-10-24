const pool = require('../db');

// Hospital/NGO companion rows stock report mein Blood Banks nahi hain.
const bloodBankFilter = "(b.organization_id IS NULL OR o.organization_type = 'Blood Bank')";

// Report query options ko strictly validate karenge; filters SQL parameters se jayenge.
function hasOnlyQueryFields(query, fields = []) {
  return Object.keys(query).every(field => fields.includes(field));
}

function parseIntegerOption(value, defaultValue, min, max) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

function numericRows(rows, fields) {
  // MySQL SUM decimal strings de sakta hai; response mein numeric totals denge.
  return rows.map(row => {
    const result = { ...row };
    for (const field of fields) result[field] = Number(row[field] ?? 0);
    return result;
  });
}

async function donorTotals() {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS total_donors, COALESCE(SUM(is_available = ?), 0) AS available_donors FROM donors',
    [1]
  );
  return numericRows(rows, ['total_donors', 'available_donors'])[0];
}

async function requestTotals() {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS total_requests, COALESCE(SUM(status = ?), 0) AS pending_requests, ' +
      'COALESCE(SUM(status = ?), 0) AS processing_requests, COALESCE(SUM(status = ?), 0) AS fulfilled_requests, ' +
      'COALESCE(SUM(status = ?), 0) AS cancelled_requests FROM blood_requests',
    ['Pending', 'Processing', 'Fulfilled', 'Cancelled']
  );
  return numericRows(rows, ['total_requests', 'pending_requests', 'processing_requests',
    'fulfilled_requests', 'cancelled_requests'])[0];
}

async function inventoryGroups() {
  const [rows] = await pool.execute(
    'SELECT i.blood_group, COALESCE(SUM(i.units_available), 0) AS total_units_available, ' +
      'COUNT(DISTINCT i.bank_id) AS bank_count FROM blood_inventory AS i ' +
      'JOIN blood_banks AS b ON b.bank_id = i.bank_id ' +
      'LEFT JOIN organizations AS o ON o.organization_id = b.organization_id ' +
      'WHERE ' + bloodBankFilter + ' GROUP BY i.blood_group ORDER BY i.blood_group'
  );
  return numericRows(rows, ['total_units_available', 'bank_count']);
}

async function getDashboard(req, res) {
  try {
    if (!hasOnlyQueryFields(req.query)) {
      return res.status(400).json({ message: 'Dashboard does not accept query parameters.' });
    }
    const donors = await donorTotals();
    const requests = await requestTotals();
    const [counts] = await pool.execute(
      'SELECT (SELECT COUNT(*) FROM recipients) AS total_recipients, ' +
      '(SELECT COUNT(*) FROM blood_banks AS b LEFT JOIN organizations AS o ' +
      'ON o.organization_id = b.organization_id WHERE ' + bloodBankFilter + ') AS total_blood_banks, ' +
      '(SELECT COUNT(*) FROM organizations) AS total_organizations'
    );
    const otherTotals = numericRows(counts, ['total_recipients', 'total_blood_banks', 'total_organizations'])[0];
    const inventory = await inventoryGroups();
    return res.status(200).json({ ...donors, ...otherTotals, ...requests, inventory_by_blood_group: inventory });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to load dashboard.' });
  }
}

async function getRequestReport(req, res) {
  try {
    // Default latest 20 requests; client 1 se 100 tak limit de sakta hai.
    const limit = parseIntegerOption(req.query.limit, 20, 1, 100);
    if (!hasOnlyQueryFields(req.query, ['limit']) || limit === null) {
      return res.status(400).json({ message: 'Only limit is accepted; it must be an integer from 1 to 100.' });
    }
    const summary = await requestTotals();
    const [statusRows] = await pool.execute(
      'SELECT status, COUNT(*) AS total_requests, COALESCE(SUM(units_required), 0) AS total_units_required ' +
        'FROM blood_requests GROUP BY status ORDER BY status IS NULL ASC, FIELD(status, ?, ?, ?, ?)',
      ['Pending', 'Processing', 'Fulfilled', 'Cancelled']
    );
    const [urgencyRows] = await pool.execute(
      'SELECT urgency_level, COUNT(*) AS total_requests, COALESCE(SUM(units_required), 0) AS total_units_required ' +
        'FROM blood_requests GROUP BY urgency_level ORDER BY CASE WHEN urgency_level = ? THEN 0 ELSE 1 END',
      ['Emergency']
    );
    const [groupRows] = await pool.execute(
      'SELECT blood_group, COUNT(*) AS total_requests, COALESCE(SUM(units_required), 0) AS total_units_required ' +
        'FROM blood_requests GROUP BY blood_group ORDER BY blood_group'
    );
    // Latest N select karenge; display Emergency-first, phir oldest-first hoga.
    // NULL dates ko last aur same date par ID ko tie-breaker rakhenge.
    const [recentRequests] = await pool.execute(
      'SELECT request_id, blood_group, units_required, request_date, status, urgency_level FROM (' +
        'SELECT request_id, blood_group, units_required, request_date, status, urgency_level FROM blood_requests ' +
        'ORDER BY request_date IS NULL ASC, request_date DESC, request_id DESC LIMIT ?) AS recent_requests ' +
        'ORDER BY CASE WHEN urgency_level = ? THEN 0 ELSE 1 END, request_date IS NULL ASC, request_date ASC, request_id ASC',
      [limit, 'Emergency']
    );
    const fields = ['total_requests', 'total_units_required'];
    return res.status(200).json({ summary1,
      by_status: numericRows(statusRows, fields), by_urgency: numericRows(urgencyRows, fields),
      by_blood_group: numericRows(groupRows, fields), recent_limit: limit, recent_requests: recentRequests });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to generate request report.' });
  }
}

async function getDonorReport(req, res) {
  try {
    if (!hasOnlyQueryFields(req.query)) {
      return res.status(400).json({ message: 'Donor report does not accept query parameters.' });
    }
    const summary = await donorTotals();
    const [groups] = await pool.execute(
      'SELECT blood_group, COUNT(*) AS total_donors, COALESCE(SUM(is_available = ?), 0) AS available_donors ' +
        'FROM donors GROUP BY blood_group ORDER BY blood_group', [1]
    );
    // Blank/missing location ko NULL group mein rakhenge; radius logic nahi banayenge.
    const [locations] = await pool.execute(
      'SELECT normalized_location AS location, COUNT(*) AS total_donors, ' +
        'COALESCE(SUM(is_available = ?), 0) AS available_donors ' +
        "FROM (SELECT NULLIF(TRIM(location), '') AS normalized_location, is_available FROM donors) AS donor_locations " +
        'GROUP BY normalized_location ORDER BY normalized_location IS NULL ASC, normalized_location ASC', [1]
    );
    const fields = ['total_donors', 'available_donors'];
    return res.status(200).json({ summary, by_blood_group: numericRows(groups, fields),
      by_location: numericRows(locations, fields) });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to generate donor report.' });
  }
}

async function getInventoryReport(req, res) {
  try {
    // Project mein low-stock cutoff defined nahi hai; default 0 sirf zero stock dikhayega.
    const threshold = parseIntegerOption(req.query.low_stock_threshold, 0, 0, 2147483647);
    if (!hasOnlyQueryFields(req.query, ['low_stock_threshold']) || threshold === null) {
      return res.status(400).json({ message: 'Only low_stock_threshold is accepted; it must be an integer from 0 to 2147483647.' });
    }
    const [totals] = await pool.execute(
      'SELECT COUNT(*) AS inventory_records, COALESCE(SUM(i.units_available), 0) AS total_units_available, ' +
        'COUNT(DISTINCT i.bank_id) AS banks_with_inventory FROM blood_inventory AS i ' +
        'JOIN blood_banks AS b ON b.bank_id = i.bank_id ' +
        'LEFT JOIN organizations AS o ON o.organization_id = b.organization_id WHERE ' + bloodBankFilter
    );
    const groups = await inventoryGroups();
    const [stock] = await pool.execute(
      'SELECT i.inventory_id, i.bank_id, b.bank_name, i.blood_group, i.units_available, i.updated_at ' +
        'FROM blood_inventory AS i JOIN blood_banks AS b ON b.bank_id = i.bank_id ' +
        'LEFT JOIN organizations AS o ON o.organization_id = b.organization_id ' +
        'WHERE ' + bloodBankFilter + ' ORDER BY i.bank_id, i.blood_group'
    );
    // Unrecorded inventory ko zero stock claim nahi karenge; banks alag list mein aayenge.
    const [unrecordedBanks] = await pool.execute(
      'SELECT b.bank_id, b.bank_name FROM blood_banks AS b ' +
        'LEFT JOIN organizations AS o ON o.organization_id = b.organization_id ' +
        'LEFT JOIN blood_inventory AS i ON i.bank_id = b.bank_id ' +
        'WHERE i.inventory_id IS NULL AND ' + bloodBankFilter + ' ORDER BY b.bank_id'
    );
    const bankStock = numericRows(stock, ['units_available']);
    return res.status(200).json({
      summary: numericRows(totals, ['inventory_records', 'total_units_available', 'banks_with_inventory'])[0],
      by_blood_group: groups, bank_wise_stock: bankStock, low_stock_threshold: threshold,
      low_or_zero_stock: bankStock.filter(row => row.units_available <= threshold),
      banks_without_inventory: unrecordedBanks,
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to generate inventory report.' });
  }
}

async function getDonationReport(req, res) {
  try {
    if (!hasOnlyQueryFields(req.query)) {
      return res.status(400).json({ message: 'Donation report does not accept query parameters.' });
    }
    const [totals] = await pool.execute(
      'SELECT COUNT(*) AS total_donations, COALESCE(SUM(units_donated), 0) AS total_units_donated FROM donations'
    );
    const [groups] = await pool.execute(
      'SELECT blood_group, COUNT(*) AS total_donations, COALESCE(SUM(units_donated), 0) AS total_units_donated ' +
        'FROM donations GROUP BY blood_group ORDER BY blood_group'
    );
    const [months] = await pool.execute(
      "SELECT DATE_FORMAT(donation_date, '%Y-%m') AS month, COUNT(*) AS total_donations, " +
        'COALESCE(SUM(units_donated), 0) AS total_units_donated FROM donations ' +
        'GROUP BY month ORDER BY month IS NULL ASC, month DESC'
    );
    const fields = ['total_donations', 'total_units_donated'];
    return res.status(200).json({ summary: numericRows(totals, fields)[0],
      by_blood_group: numericRows(groups, fields), by_month: numericRows(months, fields) });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to generate donation report.' });
  }
}

async function getAllocationReport(req, res) {
  try {
    if (!hasOnlyQueryFields(req.query)) {
      return res.status(400).json({ message: 'Allocation report does not accept query parameters.' });
    }
    // Sirf actual request_allocations rows count hongi; bank deductions ke fake records nahi banenge.
    const [totals] = await pool.execute(
      'SELECT COUNT(*) AS total_allocations, COALESCE(SUM(units_allocated), 0) AS total_units_allocated, COALESCE(SUM(CASE WHEN inventory_id IS NOT NULL THEN units_allocated ELSE 0 END),0) AS inventory_units, COALESCE(SUM(CASE WHEN donation_id IS NOT NULL THEN units_allocated ELSE 0 END),0) AS donation_units FROM request_allocations'
    );
    const [requests] = await pool.execute(
      'SELECT request_id, COUNT(*) AS total_allocations, COALESCE(SUM(units_allocated), 0) AS total_units_allocated, ' +
        'MIN(allocated_at) AS first_allocation_at, MAX(allocated_at) AS last_allocation_at ' +
        'FROM request_allocations GROUP BY request_id ORDER BY request_id'
    );
    const [months] = await pool.execute(
      "SELECT DATE_FORMAT(allocated_at, '%Y-%m') AS month, COUNT(*) AS total_allocations, " +
        'COALESCE(SUM(units_allocated), 0) AS total_units_allocated FROM request_allocations ' +
        'GROUP BY month ORDER BY month IS NULL ASC, month DESC'
    );
    const fields = ['total_allocations', 'total_units_allocated'];
    return res.status(200).json({ summary: numericRows(totals, [...fields, 'inventory_units', 'donation_units'])[0],
      by_request: numericRows(requests, fields), by_month: numericRows(months, fields) });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to generate allocation report.' });
  }
}

module.exports = { getDashboard, getRequestReport, getDonorReport, getInventoryReport,
  getDonationReport, getAllocationReport };
