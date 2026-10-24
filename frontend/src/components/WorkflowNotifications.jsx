import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { fetchWorkflowNotifications, markWorkflowNotificationRead } from '../services/workflowNotificationsApi.js';
import { formatRequestDate, requestHistoryError } from '../services/recipientDashboardApi.js';
import '../styles/workflowV2.css';

export default function WorkflowNotifications({ session, enabled, refreshKey = 0, onUnauthorized }) {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState([]);
  const reads = useRef(new Set());
  const controller = useRef(null);
  const expired = useRef(onUnauthorized); expired.current = onUnauthorized;
  useEffect(() => {
    if (!enabled) return;
    const current = new AbortController(); controller.current = current;
    setStatus('loading'); setRows([]); setError(''); reads.current.clear(); setPending([]);
    fetchWorkflowNotifications(session, current.signal).then(data => {
      if (!current.signal.aborted) { setRows(data); setStatus('success'); }
    }).catch(failure => {
      if (current.signal.aborted || axios.isCancel(failure)) return;
      if (failure.response?.status === 401) expired.current?.();
      else { setError(requestHistoryError(failure)); setStatus('error'); }
    });
    return () => current.abort();
  }, [session.token, enabled, refreshKey, retry]);
  async function markRead(id) {
    const current = controller.current;
    if (!current || current.signal.aborted || reads.current.has(id)) return;
    reads.current.add(id); setPending(values => [...values, id]); setError('');
    try {
      await markWorkflowNotificationRead(session, id, current.signal);
      if (!current.signal.aborted) setRows(values => values.map(row => row.notification_id === id ? { ...row, is_read: 1 } : row));
    } catch (failure) {
      if (current.signal.aborted || axios.isCancel(failure)) return;
      if (failure.response?.status === 401) expired.current?.();
      else setError('Unable to mark this notification as read. Please try again.');
    } finally {
      if (!current.signal.aborted) { reads.current.delete(id); setPending(values => values.filter(value => value !== id)); }
    }
  }
  if (!enabled) return null;
  return <section className="workflow-notifications" aria-label="City-wide request notifications">
    <div className="workflow-section-heading"><h2>Request notifications</h2><button type="button" onClick={() => setRetry(value => value + 1)}>Refresh notifications</button></div>
    <p>Updates for your own city-wide requests and assigned collection activity.</p>
    {status === 'loading' && <p role="status">Loading notifications...</p>}
    {error && <p role="alert" className="workflow-error">{error}</p>}
    {status === 'success' && (rows.length ? <ul>{rows.map(row => <li key={row.notification_id} className={row.is_read ? '' : 'workflow-unread'}>
      <strong>{row.is_read ? 'Read' : 'Unread'}{row.request_id ? ' - Request #' + row.request_id : ''}</strong>
      <p>{row.message}</p><small>{formatRequestDate(row.sent_at)}</small>
      {!row.is_read && <button type="button" disabled={pending.includes(row.notification_id)} onClick={() => markRead(row.notification_id)}>{pending.includes(row.notification_id) ? 'Marking...' : 'Mark as read'}</button>}
    </li>)}</ul> : <p>No request notifications yet.</p>)}
  </section>;
}
