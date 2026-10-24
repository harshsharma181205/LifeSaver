const pool = require('../db');
const smsService = require('./smsService');

class NotificationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0 && value <= 2147483647;
}

async function findUser(userType, userId, executor = pool) {
  if (!['donor', 'recipient'].includes(userType) || !isPositiveInt(userId)) {
    throw new NotificationError('A valid donor or recipient ID is required.');
  }
  // Fixed SQL use karenge; phone sirf SMS ke liye internal rahega.
  const sql = userType === 'donor'
    ? 'SELECT donor_id, phone FROM donors WHERE donor_id = ? LIMIT 1'
    : 'SELECT recipient_id, phone FROM recipients WHERE recipient_id = ? LIMIT 1';
  const [users] = await executor.execute(sql, [userId]);
  if (users.length === 0) {
    throw new NotificationError(userType === 'donor' ? 'Donor not found.' : 'Recipient not found.', 404);
  }
  return users[0];
}

async function createNotification(details, options = {}) {
  const executor = options.executor || pool;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new NotificationError('Send a JSON object with notification details.');
  }
  const allowedFields = ['donor_id', 'recipient_id', 'request_id', 'channel', 'message'];
  if (Object.keys(details).some(field => !allowedFields.includes(field))) {
    throw new NotificationError('Only donor_id, recipient_id, request_id, channel, and message are accepted.');
  }

  const donorId = details.donor_id == null ? null : details.donor_id;
  const recipientId = details.recipient_id == null ? null : details.recipient_id;
  // Schema dono IDs nullable rakhti hai; API exactly ek user require karegi.
  if ((donorId === null) === (recipientId === null)) {
    throw new NotificationError('Provide exactly one of donor_id or recipient_id.');
  }
  if ((donorId !== null && !isPositiveInt(donorId)) ||
      (recipientId !== null && !isPositiveInt(recipientId))) {
    throw new NotificationError('User ID must be a positive integer within MySQL INT limits.');
  }
  if (typeof details.message !== 'string' || details.message.trim() === '' ||
      [...details.message.trim()].length > 500) {
    throw new NotificationError('message must be a non-empty string of at most 500 characters.');
  }
  // Yeh module InApp row save karega; SMS result alag hai, Email scope mein nahi hai.
  if (details.channel !== undefined && details.channel !== 'InApp') {
    throw new NotificationError('channel must be InApp for an in-app notification.');
  }
  const requestId = details.request_id == null ? null : details.request_id;
  if (requestId !== null && !isPositiveInt(requestId)) {
    throw new NotificationError('request_id must be a positive integer within MySQL INT limits.');
  }

  const user = await findUser(donorId !== null ? 'donor' : 'recipient', donorId ?? recipientId, executor);
  if (requestId !== null) {
    const [requests] = await executor.execute(
      'SELECT request_id FROM blood_requests WHERE request_id = ? LIMIT 1', [requestId]
    );
    if (requests.length === 0) throw new NotificationError('Blood request not found.', 404);
  }

  const message = details.message.trim();
  const [result] = await executor.execute(
    'INSERT INTO notifications (donor_id, recipient_id, request_id, channel, message) VALUES (?, ?, ?, ?, ?)',
    [donorId, recipientId, requestId, 'InApp', message]
  );
  // Row pehle save ho chuki hai; SMS failure par rollback ya request failure nahi hoga.
  if (options.sendSMS === false) {
    return { notification_id: result.insertId, channel: 'InApp', sms: { status: 'disabled', sent: false } };
  }
  let sms;
  try {
    sms = await smsService.sendSMS(user.phone, message);
  } catch (error) {
    sms = { status: 'failed', sent: false };
  }
  return { notification_id: result.insertId, channel: 'InApp', sms };
}

async function notifyDonor(donorId, message, requestId = null, options = {}) {
  // Allocation flow baad mein yeh helper call kar sakta hai; fake donation nahi banegi.
  return createNotification({ donor_id: donorId, request_id: requestId, message }, options);
}

module.exports = { createNotification, notifyDonor, findUser, isPositiveInt, NotificationError };
