// Canonical 28 states and 8 Union Territories. Source: National Portal of India,
// https://www.india.gov.in/explore-india/odop (checked 7 October 2026).
const INDIAN_STATES = Object.freeze([
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam',
  'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
]);

function normalizeState(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().replace(/\s+/g, ' ').toLowerCase();
  return INDIAN_STATES.find(state => state.toLowerCase() === key) || null;
}

function normalizeCity(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const city = value.trim().replace(/\s+/g, ' ');
  if (!city || city.length > 100 || !/^[\p{L}\p{M}\d .,'’()-]+$/u.test(city) ||
      !/\p{L}/u.test(city)) return null;
  return city;
}

function sameCity(left, right) {
  const a = normalizeCity(left);
  const b = normalizeCity(right);
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

module.exports = { INDIAN_STATES, normalizeState, normalizeCity, sameCity };
