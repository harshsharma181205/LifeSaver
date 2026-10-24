import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext.jsx';
import RequestFulfillment from '../components/RequestFulfillment.jsx';
import {
  fetchRecipientRequest, cancelRecipientRequest, isValidRequestId, requestDetailsError, formatRequestDate,
} from '../services/recipientDashboardApi.js';
import '../styles/recipientRequestDetails.css';

const progressSteps = ['Pending', 'Processing', 'Fulfilled'];
const statusDescriptions = {
  Pending: 'Your request is awaiting processing.',
  Processing: 'Your request is being processed.',
  Fulfilled: 'Your blood request has been fulfilled.',
  Cancelled: 'This request was cancelled and is no longer active.',
};

function RequestProgress({ status }) {
  const currentStep = progressSteps.indexOf(status);
  return (
    <section className="request-details-progress-card" aria-labelledby="request-progress-title">
      <p className="request-details-kicker">Your request journey</p>
      <h2 id="request-progress-title">Request Progress</h2>
      {status === 'Cancelled' ? (
        <p className="request-details-cancelled" role="status">This request was cancelled.</p>
      ) : currentStep < 0 ? (
        <p className="request-details-note">Progress is unavailable because this request has no recorded status.</p>
      ) : (
        <ol className="request-details-progress" aria-label="Request progress">
          {progressSteps.map((step, index) => {
            const state = index < currentStep ? 'completed' : index === currentStep ? 'current' : 'upcoming';
            return (
              <li key={step} className={'request-details-step request-details-step-' + state}
                aria-current={index === currentStep ? 'step' : undefined}>
                <span className="request-details-step-dot" aria-hidden="true">{index < currentStep ? <>&#10003;</> : index + 1}</span>
                <div>
                  <h3>{step}</h3>
                  <p>{index < currentStep || (step === 'Fulfilled' && status === 'Fulfilled')
                    ? 'Completed' : index === currentStep ? 'Current stage' : 'Upcoming'}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p className="request-details-note">The status shown here reflects the latest saved update to your request.</p>
    </section>
  );
}

function RequestDetailsContent({ session, logout, requestId }) {
  const navigate = useNavigate();
  const [request, setRequest] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const cancelController = useRef(null);
  useEffect(() => () => cancelController.current?.abort(), []);

  useEffect(() => {
    if (!isValidRequestId(requestId)) {
      setError(requestDetailsError({ response: { status: 400 } }));
      setLoadState('error');
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    setLoadState('loading');
    setError('');
    fetchRecipientRequest(session, requestId, controller.signal).then((row) => {
      if (!active) return;
      setRequest(row);
      setLoadState('success');
    }).catch((requestError) => {
      // Purane request/account ki response ignore hogi.
      if (!active || axios.isCancel(requestError)) return;
      if (requestError.response?.status === 401) {
        logout();
        navigate('/login', { replace: true });
      } else {
        setError(requestDetailsError(requestError));
        setLoadState('error');
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [session, logout, navigate, requestId, retryCount]);

  async function cancelRequest() {
    if (cancelController.current || !['Pending', 'Processing'].includes(request?.status)) return;
    const controller = new AbortController(); cancelController.current = controller;
    setCancelPending(true); setCancelError('');
    try {
      await cancelRecipientRequest(session, requestId, controller.signal);
      if (controller.signal.aborted) return;
      setRetryCount(count => count + 1);
    } catch (failure) {
      if (controller.signal.aborted || axios.isCancel(failure)) return;
      if (failure.response?.status === 401) { logout(); navigate('/login', { replace: true }); }
      else setCancelError(failure.response?.status === 409 ? 'This request has changed or is already closed. Refresh to view its current state.' : requestDetailsError(failure));
    } finally {
      if (!controller.signal.aborted) { cancelController.current = null; setCancelPending(false); }
    }
  }


  return (
    <main className="request-details-page">
      <div className="request-details-container">
        <nav className="request-details-breadcrumb" aria-label="Breadcrumb">
          <Link to="/recipient/dashboard">My Blood Requests</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Request details</span>
        </nav>

        <header className="request-details-header">
          <p className="request-details-kicker">Recipient request tracking</p>
          <h1>{loadState === 'success' ? 'Blood Request #' + request.request_id : 'Blood request details'}</h1>
          <p>Follow your request and view its latest status in one place.</p>
        </header>

        <div className="request-details-content" aria-busy={loadState === 'loading'}>
          {loadState === 'loading' && (
            <section className="request-details-state" role="status">
              <span className="request-details-state-icon" aria-hidden="true">&#8230;</span>
              <h2>Loading your blood request...</h2>
              <p>Getting the latest details for your request.</p>
            </section>
          )}
          {loadState === 'error' && (
            <section className="request-details-state request-details-error" role="alert">
              <span className="request-details-state-icon" aria-hidden="true">!</span>
              <h2>Request details unavailable</h2>
              <p>{error}</p>
              {isValidRequestId(requestId) && (
                <button className="request-details-retry" type="button" onClick={() => setRetryCount((count) => count + 1)}>Try again</button>
              )}
            </section>
          )}
          {loadState === 'success' && (
            <div className="request-details-grid">
              <section className="request-details-summary" aria-labelledby="request-summary-title">
                <div className="request-details-summary-heading">
                  <div><p className="request-details-kicker">Blood request</p><h2 id="request-summary-title">Request overview</h2></div>
                  <span className={'request-details-badge request-details-status-' + (request.status?.toLowerCase() || 'unavailable')}>
                    {request.status || 'Status unavailable'}
                  </span>
                </div>
                <p className="request-details-status-description">{['Pending', 'Processing'].includes(request.status) && request.donor_matching_started_at ? request.workflow_version === 2 ? 'Eligible Blood Banks in the city are coordinating matching donors.' : 'Matching donors are being contacted through your selected provider.' : statusDescriptions[request.status] || 'A status has not been recorded for this request.'}</p>
                <dl className="request-details-fields">
                  <div><dt>{request.workflow_version === 2 ? 'Admission Hospital' : 'Selected Organization'}</dt><dd>{request.admission_hospital_name || request.organization_name || request.bank_name || 'Not assigned'}</dd></div>
                  {request.city && <div><dt>Location</dt><dd>{[request.city, request.state].filter(Boolean).join(', ')}</dd></div>}
                  {request.bank_address && <div><dt>Address</dt><dd>{request.bank_address}</dd></div>}
                  {request.bank_phone && <div><dt>Phone</dt><dd>{request.bank_phone}</dd></div>}
                  {request.bank_email && <div><dt>Email</dt><dd>{request.bank_email}</dd></div>}
                  <div className="request-details-blood-field"><dt>Blood Group</dt><dd>{request.blood_group}</dd></div>
                  <div><dt>Units Required</dt><dd>{request.units_required}</dd></div>
                  <div><dt>Urgency</dt><dd className={request.urgency_level === 'Emergency' ? 'request-details-emergency' : ''}>{request.urgency_level}</dd></div>
                  <div><dt>Request Date</dt><dd className="request-details-date">{formatRequestDate(request.request_date)}</dd></div>
                </dl>
                <div className="request-details-fulfillment-area">
              <RequestFulfillment request={request} />
              {['Pending', 'Processing'].includes(request.status) && <button className="request-cancel" type="button" disabled={cancelPending} onClick={cancelRequest}>{cancelPending ? 'Cancelling...' : 'Cancel request'}</button>}
              {cancelError && <p role="alert" className="request-details-error">{cancelError}</p>}
                </div>
              </section>
              <RequestProgress status={request.status} />
            </div>
          )}
        </div>

        <Link className="request-details-back" to="/recipient/dashboard"><span aria-hidden="true">&#8592;</span> Back to Requests</Link>
        <p className="request-details-footer">LifeSaver <span aria-hidden="true">&#8226;</span> Blood Donation Management System</p>
      </div>
    </main>
  );
}

function RecipientRequestDetails() {
  const { session, logout } = useAuth();
  const { requestId } = useParams();
  // Account ya URL change par previous details turant clear honge.
  return <RequestDetailsContent key={session.token + ':' + requestId} session={session} logout={logout} requestId={requestId} />;
}

export default RecipientRequestDetails;
