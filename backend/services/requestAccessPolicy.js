function problem(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validId(value) {
  return Number.isInteger(value) && value > 0 && value <= 2147483647;
}

function normalizeLocation(value) {
  return typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';
}

function sameLocation(a, b) {
  const state = normalizeLocation(a?.state);
  const city = normalizeLocation(a?.city);
  return !!state && !!city && state === normalizeLocation(b?.state) && city === normalizeLocation(b?.city);
}

function isV2(request) { return request?.workflow_version === 2; }
function isLegacy(request) { return request && (request.workflow_version == null || request.workflow_version === 1); }
function isBank(provider) {
  return provider?.organization_type === 'Blood Bank' && validId(provider.bank_id) && validId(provider.organization_id);
}
function isOpen(request) { return ['Pending', 'Processing'].includes(request?.status); }

function canSupply(provider, request, options = {}) {
  if (!provider || (!isOpen(request) && options.allowClosedReplay !== true)) return false;
  if (isV2(request)) return isBank(provider) && validId(request.admission_hospital_id) && sameLocation(provider, request);
  return isLegacy(request) && provider.organization_type === 'Blood Bank' && validId(provider.bank_id) && request.bank_id === provider.bank_id;
}

function requireSupply(provider, request, options = {}) {
  if (!canSupply(provider, request, options)) throw problem(403, 'This bank cannot supply this request.');
}

function canView(request, actor, options = {}) {
  if (!request || !actor || !validId(actor.user_id)) return false;
  if (!isV2(request) && !isLegacy(request)) return false;
  if (actor.user_type === 'recipient') return request.recipient_id === actor.user_id;
  if (!['organization', 'blood_bank'].includes(actor.user_type)) return false;
  const provider = actor.provider;
  if (!provider) return false;
  if (actor.user_type === 'organization' && provider.organization_id !== actor.user_id) return false;
  if (actor.user_type === 'blood_bank' && provider.bank_id !== actor.user_id) return false;
  if (isLegacy(request)) {
    return validId(provider.bank_id) && ['Hospital', 'Blood Bank'].includes(provider.organization_type) &&
      request.bank_id === provider.bank_id;
  }
  if (provider.organization_type === 'Hospital') {
    return validId(provider.organization_id) && request.admission_hospital_id === provider.organization_id;
  }
  // History flag sirf server ki verified query se aayega.
  return isBank(provider) && ((isOpen(request) && sameLocation(provider, request)) || options.hasOwnContribution === true || options.hasOwnParticipation === true);
}

module.exports = { normalizeLocation, sameLocation, isV2, isBank, canView, canSupply, requireSupply };
