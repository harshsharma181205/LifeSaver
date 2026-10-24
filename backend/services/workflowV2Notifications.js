const { normalizeLocation, sameLocation, isV2 } = require('./requestAccessPolicy');
const audiences = ['donor', 'recipient', 'organization', 'blood_bank'];
const positiveId = value => Number.isInteger(value) && value > 0;

function invalid() {
  const error = new Error('Invalid workflow notification.');
  error.status = 400;
  return error;
}

async function notifyAudience(executor, input) {
  if (!executor?.execute || !input || !audiences.includes(input.type) || !positiveId(input.id) ||
      !positiveId(input.request_id) || typeof input.event_key !== 'string' || !input.event_key.trim() || input.event_key.length > 100 ||
      typeof input.message !== 'string' || !input.message.trim() || input.message.length > 500) throw invalid();
  const [result] = await executor.execute(
    'INSERT INTO workflow_notifications (audience_type, audience_id, request_id, event_key, message) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE notification_id = LAST_INSERT_ID(notification_id)',
    [input.type, input.id, input.request_id, input.event_key, input.message]
  );
  return { notification_id: result.insertId || null };
}

async function notifyRequestAudience(executor, request, eventKey, message, options = {}) {
  if (!isV2(request) || !positiveId(request.request_id) || !positiveId(request.recipient_id) ||
      !positiveId(request.admission_hospital_id) || !normalizeLocation(request.state) || !normalizeLocation(request.city)) throw invalid();
  const destinations = [{ type: 'recipient', id: request.recipient_id },
    { type: 'organization', id: request.admission_hospital_id }];
  const [banks] = await executor.execute(
    "SELECT b.bank_id, o.organization_id, o.state, o.city FROM blood_banks b INNER JOIN organizations o ON o.organization_id = b.organization_id WHERE o.organization_type = 'Blood Bank'"
  );
  for (const bank of banks) {
    if ((options.cityBanks !== false && sameLocation(bank, request)) || bank.bank_id === options.collectingBankId) {
      destinations.push({ type: 'blood_bank', id: bank.bank_id });
    }
  }
  if (options.donorId !== undefined) {
    if (!positiveId(options.donorId)) throw invalid();
    destinations.push({ type: 'donor', id: options.donorId });
  }
  if (options.collectingBankId !== undefined && !banks.some(bank => bank.bank_id === options.collectingBankId)) throw invalid();
  const sent = new Set();
  for (const destination of destinations) {
    const identity = destination.type + ':' + destination.id;
    if (sent.has(identity)) continue;
    sent.add(identity);
    await notifyAudience(executor, { ...destination, request_id: request.request_id,
      event_key: 'request:' + request.request_id + ':' + eventKey, message });
  }
  return { audience_count: sent.size };
}

module.exports = { notifyAudience, notifyRequestAudience };
