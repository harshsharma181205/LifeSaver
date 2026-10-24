const pool = require('../db');
const { findUser, isPositiveInt, NotificationError } = require('../services/notificationService');

function parseId(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return isPositiveInt(id) ? id : null;
}

function respondError(res, error, message) {
  if (error instanceof NotificationError) {
    return res.status(error.status).json({ message: error.message });
  }
  if (error.code === 'ER_NO_REFERENCED_ROW_2') {
    return res.status(404).json({ message: 'Referenced user or blood request no longer exists.' });
  }
  if (error.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ message: 'Notification conflicts with an existing record.' });
  }
  return res.status(500).json({ message });
}

async function postNotification(req, res) {
  // Notifications sirf trusted backend services create kar sakti hain.
  return res.status(403).json({ message: 'Clients cannot create notifications. Notifications are created by the system.' });
}

async function getNotifications(req, res) {
  if (!['donor', 'recipient'].includes(req.user.user_type)) return res.status(403).json({ message: 'This account cannot access user notifications.' });
  try {
    const userType = req.params.user_type;
    const userId = parseId(req.params.user_id);
    if (!['donor', 'recipient'].includes(userType)) {
      return res.status(400).json({ message: 'user_type must be donor or recipient.' });
    }
    if (userId === null) {
      return res.status(400).json({ message: 'user_id must be a positive integer within MySQL INT limits.' });
    }
    if (req.user.user_type !== userType || req.user.user_id !== userId) {
      return res.status(403).json({ message: 'You can only view your own notifications.' });
    }
    await findUser(req.user.user_type, req.user.user_id);

    // Column sirf fixed options se aayega; user input SQL mein interpolate nahi hoga.
    const column = userType === 'donor' ? 'donor_id' : 'recipient_id';
    const [notifications] = await pool.execute(
      'SELECT notification_id, donor_id, recipient_id, request_id, channel, message, is_read, sent_at FROM notifications WHERE ' +
        column + ' = ? ORDER BY sent_at IS NULL ASC, sent_at DESC, notification_id DESC',
      [req.user.user_id]
    );
    return res.status(200).json({ user_type: userType, user_id: userId, notifications });
  } catch (error) {
    return respondError(res, error, 'Unable to retrieve notifications.');
  }
}

async function markNotificationRead(req, res) {
  if (!['donor', 'recipient'].includes(req.user.user_type)) return res.status(403).json({ message: 'This account cannot access user notifications.' });
  try {
    const notificationId = parseId(req.params.notification_id);
    if (notificationId === null) {
      return res.status(400).json({ message: 'notification_id must be a positive integer within MySQL INT limits.' });
    }
    // Read endpoint sirf is_read ko 1 karega; body se aur fields change nahi honge.
    if (req.body !== undefined && (!req.body || typeof req.body !== 'object' ||
        Array.isArray(req.body) || Object.keys(req.body).length > 0)) {
      return res.status(400).json({ message: 'No body fields are accepted when marking a notification as read.' });
    }
    const column = req.user.user_type === 'donor' ? 'donor_id' : 'recipient_id';
    const [result] = await pool.execute(
      'UPDATE notifications SET is_read = ? WHERE notification_id = ? AND ' + column + ' = ?',
      [1, notificationId, req.user.user_id]
    );
    if (result.affectedRows === 0) {
      // Already-read row par kuch drivers 0 dete hain; repeat PATCH bhi successful rahega.
      const [rows] = await pool.execute(
        'SELECT notification_id FROM notifications WHERE notification_id = ? AND ' + column + ' = ? LIMIT 1',
        [notificationId, req.user.user_id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ message: 'Notification not found.' });
      }
    }
    return res.status(200).json({ message: 'Notification marked as read.', notification_id: notificationId, is_read: 1 });
  } catch (error) {
    return respondError(res, error, 'Unable to mark notification as read.');
  }
}

module.exports = { postNotification, getNotifications, markNotificationRead };
