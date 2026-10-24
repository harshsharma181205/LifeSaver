const pool = require('../db');
const config = require('../services/workflowV2Config');
const { resolveProvider } = require('../services/organizationService');

async function audienceFor(user) {
  if (!user || !Number.isInteger(user.user_id) || user.user_id < 1) return null;
  if (['donor', 'recipient'].includes(user.user_type)) return [{ type: user.user_type, id: user.user_id }];
  let provider;
  if (user.user_type === 'organization') {
    const [rows] = await pool.execute('SELECT o.organization_id, o.organization_type, b.bank_id FROM organizations o LEFT JOIN blood_banks b ON b.organization_id = o.organization_id WHERE o.organization_id = ? LIMIT 1', [user.user_id]);
    provider = rows[0];
  } else if (user.user_type === 'blood_bank') provider = await resolveProvider(user);
  if (!provider || !['Hospital', 'Blood Bank'].includes(provider.organization_type)) return null;
  const audiences = provider.organization_type === 'Blood Bank' ?
    [{ type: 'blood_bank', id: provider.bank_id }] : [{ type: 'organization', id: provider.organization_id }];
  return audiences.filter(audience => Number.isInteger(audience.id) && audience.id > 0);
}

async function run(req, res, markRead) {
  try {
    if (!req.user) return res.status(401).json({ message: 'Authentication is required.' });
    await config.assertReady(pool);
    if (Object.keys(req.query || {}).length) return res.status(400).json({ message: 'Notification ownership cannot be overridden.' });
    const audiences = await audienceFor(req.user);
    if (!audiences?.length) return res.status(403).json({ message: 'Your account cannot access these notifications.' });
    const where = '(' + audiences.map(() => '(audience_type = ? AND audience_id = ?)').join(' OR ') + ')';
    const parameters = audiences.flatMap(audience => [audience.type, audience.id]);
    if (!markRead) {
      const [notifications] = await pool.execute(
        'SELECT notification_id, request_id, event_key, message, is_read, sent_at FROM workflow_notifications WHERE ' + where + ' ORDER BY sent_at DESC, notification_id DESC LIMIT 100', parameters);
      return res.status(200).json({ notifications: notifications.map(row => ({ ...row, source: 'workflow' })) });
    }
    const raw = req.params?.notificationId ?? req.params?.id;
    const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null;
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) return res.status(400).json({ message: 'notificationId must be a positive integer.' });
    if (req.body !== undefined && req.body !== null && (typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some(key => key !== 'source') || (req.body.source !== undefined && req.body.source !== 'workflow'))) {
      return res.status(400).json({ message: 'No notification fields may be changed.' });
    }
    // Pehle ownership check; repeated read bhi safe rahega.
    const [rows] = await pool.execute('SELECT notification_id FROM workflow_notifications WHERE notification_id = ? AND ' + where, [id, ...parameters]);
    if (!rows.length) return res.status(404).json({ message: 'Notification not found.' });
    await pool.execute('UPDATE workflow_notifications SET is_read = TRUE WHERE notification_id = ? AND ' + where, [id, ...parameters]);
    return res.status(200).json({ message: 'Notification marked as read.' });
  } catch (error) {
    return res.status(error.status === 503 ? 503 : 500).json({ message: error.status === 503 ? 'The new request workflow is not available yet.' : 'Unable to retrieve workflow notifications.' });
  }
}

const listNotifications = (req, res) => run(req, res, false);
const markNotificationRead = (req, res) => run(req, res, true);
module.exports = { listNotifications, markNotificationRead };
