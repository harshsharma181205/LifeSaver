const pool = require('../db');
const { normalizeState, normalizeCity } = require('./locationService');
async function findMatchingDonors(bloodGroup, executor = pool, location = {}) {
  const state = normalizeState(location.state), city = normalizeCity(location.city);
  if (!state || !city) return [];
  const [donors] = await executor.execute(
    'SELECT donor_id, name, gender, blood_group, phone, email, location, state, city, is_available FROM donors WHERE blood_group = ? AND is_available = ? AND state = ? AND LOWER(city) = LOWER(?) ORDER BY donor_id',
    [bloodGroup, 1, state, city]
  );
  return donors;
}
async function findMatchingRequests(donorId) {
  const [rows] = await pool.execute(
    "SELECT r.request_id, r.blood_group, r.units_required, r.urgency_level, r.status, r.request_date, " +
    "r.organization_id, COALESCE(r.state,o.state) AS state, COALESCE(r.city,o.city) AS city, o.name AS organization_name, " +
    "b.bank_id, b.bank_name, b.address AS bank_address, b.phone AS bank_phone, b.email AS bank_email, " +
    "dr.response AS donor_response, dr.screening_result, " +
    "COALESCE((SELECT SUM(a.units_allocated) FROM request_allocations a WHERE a.request_id=r.request_id),0) AS fulfilled_units, " +
    "COALESCE((SELECT SUM(a.units_allocated) FROM request_allocations a WHERE a.request_id=r.request_id AND a.inventory_id IS NOT NULL),0) AS inventory_units, " +
    "COALESCE((SELECT SUM(a.units_allocated) FROM request_allocations a WHERE a.request_id=r.request_id AND a.donation_id IS NOT NULL),0) AS donation_units, " +
    "(SELECT COUNT(*) FROM request_allocations a WHERE a.request_id=r.request_id) AS allocation_count, " +
    "CASE WHEN dr.response='Accepted' AND (dr.screening_result IS NULL OR dr.screening_result='Passed') THEN p.name END AS recipient_name, " +
    "CASE WHEN dr.response='Accepted' AND (dr.screening_result IS NULL OR dr.screening_result='Passed') THEN p.age END AS recipient_age, " +
    "CASE WHEN dr.response='Accepted' AND (dr.screening_result IS NULL OR dr.screening_result='Passed') THEN p.gender END AS recipient_gender, " +
    "CASE WHEN dr.response='Accepted' AND (dr.screening_result IS NULL OR dr.screening_result='Passed') THEN p.phone END AS recipient_phone, " +
    "CASE WHEN dr.response='Accepted' AND (dr.screening_result IS NULL OR dr.screening_result='Passed') THEN p.email END AS recipient_email " +
    "FROM donors d JOIN blood_requests r ON r.blood_group=d.blood_group JOIN blood_banks b ON b.bank_id=r.bank_id " +
    "LEFT JOIN organizations o ON o.organization_id=COALESCE(r.organization_id,b.organization_id) " +
    "JOIN recipients p ON p.recipient_id=r.recipient_id LEFT JOIN donor_responses dr ON dr.request_id=r.request_id AND dr.donor_id=d.donor_id " +
    "WHERE d.donor_id=? AND (dr.response='Accepted' OR (d.is_available=1 AND r.status IN ('Pending','Processing') " +
    "AND r.donor_matching_started_at IS NOT NULL AND dr.response IS NULL AND r.urgency_level IN ('Normal','Emergency') AND r.units_required > 0 AND r.recipient_id > 0 " +
    "AND d.state=COALESCE(r.state,o.state) AND LOWER(d.city)=LOWER(COALESCE(r.city,o.city)) " +
    "AND r.units_required > COALESCE((SELECT SUM(a.units_allocated) FROM request_allocations a WHERE a.request_id=r.request_id),0) AND COALESCE((SELECT i.units_available FROM blood_inventory i WHERE i.bank_id=r.bank_id AND i.blood_group=r.blood_group),0)>=0 AND COALESCE((SELECT i.units_available FROM blood_inventory i WHERE i.bank_id=r.bank_id AND i.blood_group=r.blood_group),0)<r.units_required-COALESCE((SELECT SUM(a.units_allocated) FROM request_allocations a WHERE a.request_id=r.request_id),0))) " +
    "ORDER BY CASE WHEN r.urgency_level='Emergency' THEN 0 ELSE 1 END,r.request_date IS NULL ASC,r.request_date,r.request_id",
    [donorId]
  );
  return rows.map(row => {
    const { recipient_name, recipient_age, recipient_gender, recipient_phone, recipient_email, allocation_count, ...safe } = row;
    // Purane fulfilled requests ki missing history ko invent nahi karna.
    const historical = row.status === 'Fulfilled' && Number(allocation_count) === 0;
    safe.fulfilled_units = historical ? row.units_required : Number(row.fulfilled_units || 0);
    safe.inventory_units = Number(row.inventory_units || 0);
    safe.donation_units = Number(row.donation_units || 0);
    safe.remaining_units = row.units_required - safe.fulfilled_units;
    safe.history_available = !historical;
    if (row.donor_response === 'Accepted' && row.screening_result !== 'Failed') {
      safe.recipient = { name: recipient_name, age: recipient_age, gender: recipient_gender, phone: recipient_phone, email: recipient_email };
    }
    return safe;
  });
}
module.exports = { findMatchingDonors, findMatchingRequests };
