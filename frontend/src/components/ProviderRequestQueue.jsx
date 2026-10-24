import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { fetchProviderQueue } from '../services/providerQueueApi.js';
import { bankError } from '../services/bloodBankDashboardApi.js';
import { createReviewSession, getReadyRequests, startNextReview, finishReview,
  startNewReviewRound } from '../services/providerReviewSession.js';
import '../styles/providerRequestQueue.css';

function waitingLabel(seconds) {
  if (seconds === null) return 'Unavailable';
  if (seconds < 60) return 'Less than a minute';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + (minutes === 1 ? ' minute' : ' minutes');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours + (hours === 1 ? ' hour' : ' hours') + (rest ? ' ' + rest + ' min' : '');
}

function QueueDetails({ request }) {
  return <>
    <div className="provider-queue-row-heading"><strong>Request #{request.request_id}</strong>
      <span className={'bank-badge bank-urgency-' + request.urgency_level.toLowerCase()}>
        {request.urgency_level} · Priority {request.priority}</span></div>
    <dl className="provider-queue-fields">
      <div><dt>Blood group</dt><dd>{request.blood_group}</dd></div>
      <div><dt>Waiting since creation</dt><dd>{waitingLabel(request.waiting_seconds)}</dd></div>
      <div><dt>Remaining units</dt><dd>{request.remaining_units} / {request.units_required}</dd></div>
      <div><dt>Request status</dt><dd>{request.status}</dd></div>
    </dl>
    {request.time_warning && <p className="provider-queue-warning">{request.time_warning}</p>}
    <p className="provider-queue-reason">{request.selection_reason}</p>
  </>;
}

function ProviderRequestQueue({ session, provider, refreshKey, busy, onUnauthorized, onOpen }) {
  const [snapshot, setSnapshot] = useState(null);
  const [review, setReview] = useState(createReviewSession);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reviewRef = useRef(review);
  const controllerRef = useRef(null);
  const dispatchLock = useRef(false);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;

  function saveReview(value) {
    reviewRef.current = value;
    setReview(value);
  }
  async function loadQueue(dispatch = false) {
    if (dispatch && (dispatchLock.current || busy || reviewRef.current.active)) return;
    if (dispatch) { dispatchLock.current = true; setStarting(true); }
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setLoading(true); setError(''); setNotice('');
    try {
      const latest = await fetchProviderQueue(session, controller.signal, provider);
      if (controller.signal.aborted) return;
      setSnapshot(latest);
      if (dispatch) {
        // Fresh server queue se next review lo; clinical action automatic nahi hai.
        const next = startNextReview(reviewRef.current, latest.queue);
        saveReview(next);
        if (!next.active) setNotice('All available requests have been reviewed this round.');
      }
    } catch (failure) {
      if (controller.signal.aborted || axios.isCancel(failure)) return;
      if (failure.response?.status === 401) unauthorizedRef.current?.();
      else setError(bankError(failure, 'load the review queue'));
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setLoading(false);
      }
      if (dispatch) { dispatchLock.current = false; setStarting(false); }
    }
  }
  useEffect(() => {
    loadQueue();
    return () => controllerRef.current?.abort();
    // Same identity ka naya profile object active dispatch cancel nahi karega.
  }, [session.token, session.user.user_id, session.user.user_type, provider?.bank_id,
    provider?.organization_id, provider?.organization_type, provider?.state, provider?.city, refreshKey]);

  function finish() {
    if (busy || starting) return;
    saveReview(finishReview(reviewRef.current));
    setNotice('Review finished. Blood request status and fulfillment quantities were not changed.');
  }
  function newRound() {
    if (busy || starting || reviewRef.current.active) return;
    saveReview(startNewReviewRound(reviewRef.current));
    loadQueue();
  }
  const queue = snapshot?.queue ?? [];
  const ready = getReadyRequests(review, queue);
  const active = review.active && (queue.find(row => row.request_id === review.active.request_id) ?? review.active);
  const activeMissing = Boolean(review.active && snapshot && !queue.some(row => row.request_id === review.active.request_id));
  const emergencies = ready.filter(row => row.urgency_level === 'Emergency').length;
  const longWaits = queue.filter(row => row.long_waiting_normal);
  const controlsBusy = Boolean(busy) || starting;

  return <section className="bank-section provider-queue" id="provider-review-queue" aria-labelledby="provider-queue-title">
    <div className="bank-section-heading"><div><p className="bank-kicker">Priority Scheduling + FCFS</p>
      <h2 id="provider-queue-title">Provider Review Queue</h2></div><span>Review round {review.round}</span></div>
    <p className="bank-help">Emergency requests first, then oldest creation time, then request ID. One active review stays selected until you finish it.</p>
    <p className="provider-queue-scope">This queue schedules reviews in this dashboard session. Blood allocation, screening and donation still require your separate authorized actions.</p>
    <div className="provider-queue-controls">
      <button className="bank-primary provider-queue-start" type="button" disabled={controlsBusy || loading || Boolean(active) || !snapshot || ready.length === 0}
        onClick={() => loadQueue(true)}>{starting ? 'Selecting next review...' : 'Start Next Review'}</button>
      <button className="bank-secondary provider-queue-finish" type="button" disabled={controlsBusy || !active} onClick={finish}>Finish Review</button>
      <button className="bank-secondary provider-queue-new-round" type="button" disabled={controlsBusy || loading || Boolean(active)} onClick={newRound}>Start New Review Round</button>
      <button className="bank-secondary provider-queue-refresh" type="button" disabled={controlsBusy || loading} onClick={() => loadQueue()}>Refresh queue</button>
    </div>
    {loading && <p role="status" className="bank-state">{starting ? 'Checking the latest queue...' : 'Loading review queue...'}</p>}
    {error && <p className="bank-error provider-queue-error" role="alert">{error}</p>}
    {notice && <p className="provider-queue-notice" role="status">{notice}</p>}
    {longWaits.length > 0 && <p className="provider-queue-alert" role="status">{longWaits.length} long-waiting Normal request{longWaits.length === 1 ? '' : 's'}
      {' '}({waitingLabel(snapshot.long_wait_threshold_seconds)} review reminder). Consider follow-up or additional capacity. Emergency priority is unchanged; this does not guarantee starvation prevention.</p>}
    {active && emergencies > 0 && <p className="provider-queue-emergency" role="status">{emergencies} Emergency request{emergencies === 1 ? '' : 's'} waiting.
      {' '}The active review is preserved. Priority will be re-evaluated at the next dispatch.</p>}
    {active && <article className="provider-queue-active" aria-label={'Active review for request ' + active.request_id}>
      <p className="bank-kicker">Active review · Non-preemptive</p><QueueDetails request={active} />
      {activeMissing && <p className="provider-queue-warning">This request is no longer in the latest open queue. Its displayed details are from the earlier snapshot. Check the clinical request and finish this review explicitly.</p>}
      <button type="button" className="bank-secondary provider-queue-open" disabled={controlsBusy} onClick={() => onOpen?.(active.request_id)}>Open request</button>
    </article>}
    {snapshot && <>
      <p className="provider-queue-summary">{ready.length} waiting for review · {review.reviewedIds.length} reviewed this round</p>
      {ready.length ? <ol className="provider-queue-list">{ready.map((request, index) => <li key={request.request_id} data-request-id={request.request_id}>
        <span className="provider-queue-position" aria-label={'Queue position ' + (index + 1)}>{index + 1}</span>
        <div className="provider-queue-row"><QueueDetails request={request} />
          <button type="button" className="bank-secondary provider-queue-open" disabled={controlsBusy} onClick={() => onOpen?.(request.request_id)}>Open request</button></div>
      </li>)}</ol> : !loading && <p className="bank-empty">{queue.length || active ? 'No further requests are waiting in this review round.' : 'No open blood requests are waiting for review.'}</p>}
      <p className="provider-queue-footnote">Waiting age is measured at the last refresh and includes donor coordination time; it is not an estimated treatment time.
        {' '}Last refreshed: {new Date(snapshot.generated_at).toLocaleString()}. Reviewed open requests can return in a new round. Refreshing the page resets this session.</p>
    </>}
  </section>;
}

export default ProviderRequestQueue;
