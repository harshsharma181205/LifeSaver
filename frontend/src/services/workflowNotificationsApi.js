import axios from 'axios';
import { API_BASE_URL } from '../config/api.js';
function options(session, signal) {
  if (!session?.token || !session?.user) throw new Error('A signed-in account is required.');
  return { headers: { Authorization: 'Bearer ' + session.token }, signal, timeout: 15000 };
}
export async function fetchWorkflowNotifications(session, signal) {
  const { data } = await axios.get(API_BASE_URL + '/api/notifications/me', options(session, signal));
  if (!Array.isArray(data?.notifications)) throw new Error('Unexpected notifications.');
  const seen = new Set();
  return data.notifications.map(row => {
    if (!Number.isSafeInteger(row?.notification_id) || row.notification_id < 1 || seen.has(row.notification_id)
      || row.source !== 'workflow' || typeof row.message !== 'string' || ![0, 1].includes(row.is_read)
      || (row.request_id != null && (!Number.isSafeInteger(row.request_id) || row.request_id < 1))
      || (row.sent_at != null && (typeof row.sent_at !== 'string' || !Number.isFinite(Date.parse(row.sent_at))))) {
      throw new Error('Unexpected notifications.');
    }
    seen.add(row.notification_id);
    return { notification_id: row.notification_id, request_id: row.request_id ?? null,
      message: row.message, is_read: row.is_read, sent_at: row.sent_at ?? null, source: 'workflow' };
  });
}
export async function markWorkflowNotificationRead(session, id, signal) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid notification.');
  const { data } = await axios.patch(API_BASE_URL + '/api/notifications/me/' + id + '/read', { source: 'workflow' }, options(session, signal));
  if (data?.notification_id !== id || data.is_read !== 1) throw new Error('Unexpected read response.');
  return { notification_id: id, is_read: 1 };
}
