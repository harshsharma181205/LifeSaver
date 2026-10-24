import useWorkflowConfig from '../hooks/useWorkflowConfig.js';
import WorkflowNotice from '../components/WorkflowNotice.jsx';
import WorkflowNotifications from '../components/WorkflowNotifications.jsx';
import { useEffect, useState } from 'react';
import axios from 'axios';
import { fetchRecipientRequests, fetchRecipientName, requestHistoryError, formatRequestDate } from '../services/recipientDashboardApi.js';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import RequestFulfillment from '../components/RequestFulfillment.jsx';
import '../styles/recipientDashboard.css';

const iconPaths = {
  plus: 'M12 5v14M5 12h14',
  requests: 'M9 5H5v16h14V5h-4M9 3h6v4H9zM8 12h8M8 16h5',
  logout: 'M9 4H4v16h5M14 8l4 4-4 4M8 12h10',
  heart: 'M12 20s-8-5-8-11a5 5 0 0 1 8-4 5 5 0 0 1 8 4c0 6-8 11-8 11Z',
};

function DashboardIcon({ name, className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d={iconPaths[name]} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RecipientDashboardContent({ session, logout }) {
  const workflow = useWorkflowConfig(session);
  const navigate = useNavigate();
  const recipientId = session.user.user_id;
  const [name, setName] = useState('');
  const [requests, setRequests] = useState([]);
  const [requestState, setRequestState] = useState('loading');
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setRequestState('loading');
    setError('');

    function handleFailure(requestError, isProfile = false) {
      // Purane account ki response naye account ko affect nahi karegi.
      if (!active || axios.isCancel(requestError)) return;
      if (requestError.response?.status === 401) {
        logout();
        navigate('/login', { replace: true });
      } else if (isProfile) {
        setName('');
      } else {
        setError(requestHistoryError(requestError));
        setRequestState('error');
      }
    }

    fetchRecipientRequests(session, controller.signal).then((rows) => {
      if (!active) return;
      setRequests(rows);
      setRequestState('success');
    }).catch((requestError) => handleFailure(requestError));

    // Profile failure history ko block nahi karegi.
    fetchRecipientName(session, controller.signal).then((profileName) => {
      if (active) setName(profileName);
    }).catch((requestError) => handleFailure(requestError, true));

    return () => {
      active = false;
      controller.abort();
    };
  }, [session, logout, navigate, retryCount]);

  function handleLogout() {
    // Existing context hi session clear karega.
    logout();
    navigate('/login', { replace: true });
  }

  return (
    <main className="recipient-dashboard">
      <div className="recipient-container">
        <div className="recipient-topbar">
          <nav className="recipient-breadcrumb" aria-label="Breadcrumb">
            <Link to="/">Home</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">Recipient dashboard</span>
          </nav>
          <button className="recipient-logout" type="button" onClick={handleLogout}>
            <DashboardIcon name="logout" />
            Logout
          </button>
        </div>

        <section className="recipient-welcome" aria-labelledby="recipient-welcome-title">
          <div className="recipient-welcome-copy">
            <p className="recipient-kicker">
              <span className="recipient-status-dot" aria-hidden="true" />
              Your recipient workspace
            </p>
            <h1 id="recipient-welcome-title">
              {name ? <>Welcome back,<br /><span>{name}!</span></> : 'Welcome back!'}
            </h1>
            <p className="recipient-welcome-description">A little support goes a long way. Your blood requests will have a home here, with LifeSaver by your side.</p>
            <Link className="recipient-create-button" to="/recipient/requests/create">
              <DashboardIcon name="plus" />
              Create Blood Request
            </Link>
          </div>
          <div className="recipient-welcome-art" aria-hidden="true">
            <div className="recipient-art-orbit">
              <div className="recipient-art-center">
                <svg viewBox="0 0 24 28" fill="none">
                  <path d="M12 2C9 6 3 13 3 18a9 9 0 0 0 18 0c0-5-6-12-9-16Z" fill="currentColor" />
                  <path d="M12 13v10M7 18h10" stroke="white" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <span className="recipient-art-dot recipient-art-dot-one" />
              <span className="recipient-art-dot recipient-art-dot-two" />
            </div>
            <p>Care starts with connection.</p>
          </div>
        </section>

        <WorkflowNotice config={workflow} />
        <WorkflowNotifications session={session} enabled={workflow.enabled} onUnauthorized={handleLogout} />
        <div className="recipient-content-grid">
          <section className="recipient-requests-card" aria-labelledby="recipient-requests-title">
            <div className="recipient-card-heading">
              <span className="recipient-section-icon"><DashboardIcon name="requests" /></span>
              <div>
                <h2 id="recipient-requests-title">My Blood Requests</h2>
                <p>Your requests, together in one place.</p>
              </div>
            </div>
            <div className="recipient-history" aria-busy={requestState === 'loading'}>
              {requestState === 'loading' && (
                <div className="recipient-empty-state" role="status">
                  <span className="recipient-empty-icon"><DashboardIcon name="requests" /></span>
                  <h3>Loading your blood requests...</h3>
                  <p>Getting your latest request history.</p>
                </div>
              )}
              {requestState === 'error' && (
                <div className="recipient-empty-state recipient-history-error" role="alert">
                  <h3>We couldn't load your requests.</h3>
                  <p>{error}</p>
                  <button className="recipient-retry-button" type="button" onClick={() => setRetryCount((count) => count + 1)}>
                    Try again
                  </button>
                </div>
              )}
              {requestState === 'success' && requests.length === 0 && (
                <div className="recipient-empty-state">
                  <span className="recipient-empty-icon"><DashboardIcon name="requests" /></span>
                  <h3>You haven't created any blood requests yet.</h3>
                  <p>Create your first request when you need support.</p>
                  <Link className="recipient-create-button recipient-empty-action" to="/recipient/requests/create">
                    <DashboardIcon name="plus" />Create Blood Request
                  </Link>
                </div>
              )}
              {requestState === 'success' && requests.length > 0 && (
                <ul className="recipient-request-list" aria-label="Your blood requests">
                  {requests.map((request) => (
                    <li className="recipient-request-item" key={request.request_id}>
                      <div className="recipient-request-heading">
                        <h3>Request #{request.request_id}</h3>
                        <span className={'recipient-request-status recipient-status-' + (request.status?.toLowerCase() || 'unavailable')}>
                          {request.status || 'Status unavailable'}
                        </span>
                      </div>
                      <dl className="recipient-request-details">
                        <div><dt>Blood group</dt><dd className="recipient-blood-group">{request.blood_group}</dd></div>
                        <div><dt>Units required</dt><dd>{request.units_required}</dd></div>
                        <div><dt>Urgency</dt><dd className={request.urgency_level === 'Emergency' ? 'recipient-emergency' : ''}>{request.urgency_level}</dd></div>
                      </dl>
                      <dl className="recipient-request-details recipient-bank-details">
                        <div><dt>{request.workflow_version === 2 ? 'Admission Hospital' : 'Selected Organization'}</dt><dd>{request.admission_hospital_name || request.organization_name || request.bank_name || 'Not assigned'}</dd></div>
                        {request.city && <div><dt>Location</dt><dd>{[request.city, request.state].filter(Boolean).join(', ')}</dd></div>}
                        {request.bank_address && <div><dt>Address</dt><dd>{request.bank_address}</dd></div>}
                        {request.bank_phone && <div><dt>Phone</dt><dd>{request.bank_phone}</dd></div>}
                        {request.bank_email && <div><dt>Email</dt><dd>{request.bank_email}</dd></div>}
                      </dl>
                      {['Pending', 'Processing'].includes(request.status) && request.donor_matching_started_at && <p className="recipient-matching-note">{request.workflow_version === 2 ? 'Eligible Blood Banks in the city are coordinating matching donors.' : 'Matching donors are being contacted through your selected provider.'}</p>}
                      <RequestFulfillment request={request} />
                      <p className="recipient-request-date">Requested: {formatRequestDate(request.request_date)}</p>
                      <Link className="recipient-view-details" to={'/recipient/requests/' + request.request_id}
                        aria-label={'View details for request #' + request.request_id}>View Details <span aria-hidden="true">&#8594;</span></Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>

          </section>

          <aside className="recipient-sidebar" aria-label="Recipient account information">
            <section className="recipient-account-card" aria-labelledby="recipient-account-title">
              <div className="recipient-account-heading">
                <span className="recipient-avatar" aria-hidden="true">R</span>
                <div>
                  <h2 id="recipient-account-title">Your account</h2>
                  <p>{name || 'Recipient account'}</p>
                </div>
              </div>
              <dl className="recipient-account-details">
                <div><dt>Account type</dt><dd>Recipient</dd></div>
                <div><dt>Recipient ID</dt><dd>#{recipientId}</dd></div>
              </dl>
              <p className="recipient-session-status"><span aria-hidden="true" />Signed in to LifeSaver</p>
            </section>
            <section className="recipient-support-card" aria-labelledby="recipient-support-title">
              <DashboardIcon name="heart" className="recipient-support-icon" />
              <h2 id="recipient-support-title">Connected by care.</h2>
              <p>LifeSaver brings blood requests, donors and blood-bank availability together in one place.</p>
              <span className="recipient-support-brand">LifeSaver</span>
            </section>
          </aside>
        </div>
        <p className="recipient-footer-note">LifeSaver <span aria-hidden="true">&#8226;</span> Blood Donation Management System</p>
      </div>
    </main>
  );
}

function RecipientDashboard() {
  const { session, logout } = useAuth();
  // Token badalte hi old name aur history clear honge.
  return <RecipientDashboardContent key={session.token} session={session} logout={logout} />;
}

export default RecipientDashboard;
