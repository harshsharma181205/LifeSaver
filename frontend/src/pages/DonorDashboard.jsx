import useWorkflowConfig from '../hooks/useWorkflowConfig.js';
import WorkflowNotice from '../components/WorkflowNotice.jsx';
import WorkflowNotifications from '../components/WorkflowNotifications.jsx';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext.jsx';
import { fetchDonorProfile, fetchDonorMatches, fetchDonorNotifications, markDonorNotificationRead, updateDonorAvailability, respondToDonorRequest, updateDonorLocation, donorApiError } from '../services/donorDashboardApi.js';
import { formatRequestDate } from '../services/recipientDashboardApi.js';
import '../styles/donorDashboard.css';
import StateSelect from '../components/StateSelect.jsx';

function SectionState({ section, onRetry, loadingText }) {
  if (section.state === 'loading') return <p className="donor-section-state" role="status">{loadingText}</p>;
  if (section.state === 'error') return (
    <div className="donor-section-error" role="alert">
      <p>{section.error}</p><button type="button" onClick={onRetry}>Try again</button>
    </div>
  );
  return null;
}

function DonorDashboardContent({ session, logout }) {
  const workflow = useWorkflowConfig(session);
  const [collectingBankIds, setCollectingBankIds] = useState({});
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [requests, setRequests] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [sections, setSections] = useState({
    profile: { state: 'loading' }, matches: { state: 'loading' }, notifications: { state: 'loading' },
  });
  const [retryCount, setRetryCount] = useState(0);
  const [pendingIds, setPendingIds] = useState([]);
  const [readErrors, setReadErrors] = useState({});
  const [availabilityPending, setAvailabilityPending] = useState(false);
  const [availabilityError, setAvailabilityError] = useState('');
  const [responsePending, setResponsePending] = useState([]);
  const [responseErrors, setResponseErrors] = useState({});
  const [actionMessage, setActionMessage] = useState('');
  const [locationForm, setLocationForm] = useState({ state: '', city: '' });
  const [locationPending, setLocationPending] = useState(false);
  const [locationError, setLocationError] = useState('');
  const locationBusy = useRef(false);
  const pendingResponses = useRef(new Set());
  const availabilityBusy = useRef(false);
  const pendingReads = useRef(new Set());
  const controllerRef = useRef(null);

  function handleLogout() {
    logout();
    navigate('/login', { replace: true });
  }

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    pendingReads.current.clear();
    pendingResponses.current.clear();
    availabilityBusy.current = false;
    locationBusy.current = false;
    setLocationPending(false);
    setAvailabilityPending(false);
    setAvailabilityError('');
    setResponsePending([]);
    setResponseErrors({});
    setPendingIds([]);
    setReadErrors({});
    setSections({ profile: { state: 'loading' }, matches: { state: 'loading' }, notifications: { state: 'loading' } });
    // Har section independent load hoga; profile failure doosre cards ko block nahi karegi.
    function load(key, promise, save) {
      promise.then((data) => {
        if (!active) return;
        save(data);
        setSections((current) => ({ ...current, [key]: { state: 'success' } }));
      }).catch((error) => {
        if (!active || axios.isCancel(error)) return;
        if (error.response?.status === 401) {
          logout();
          navigate('/login', { replace: true });
        } else {
          if (key === 'profile') setProfile(null);
          setSections((current) => ({ ...current, [key]: { state: 'error', error: donorApiError(error) } }));
        }
      });
    }
    load('profile', fetchDonorProfile(session, controller.signal), data => { setProfile(data); setLocationForm({ state: data.state, city: data.city }); });
    load('matches', fetchDonorMatches(session, controller.signal), setRequests);
    load('notifications', fetchDonorNotifications(session, controller.signal), setNotifications);
    return () => { active = false; controller.abort(); };
  }, [session, logout, navigate, retryCount]);

  async function handleMarkRead(id, button) {
    const hadFocus = document.activeElement === button;
    const controller = controllerRef.current;
    if (!controller || controller.signal.aborted || pendingReads.current.has(id)) return;
    pendingReads.current.add(id);
    setPendingIds((current) => [...current, id]);
    setReadErrors((current) => ({ ...current, [id]: '' }));
    try {
      await markDonorNotificationRead(session, id, controller.signal);
      if (controller.signal.aborted) return;
      // Server success ke baad hi unread state change hogi.
      setNotifications((current) => current.map((item) => item.notification_id === id ? { ...item, is_read: 1 } : item));
      // Button remove hone par keyboard focus notification par rahega.
      if (hadFocus && (document.activeElement === button || document.activeElement === document.body)) button.closest('li').focus();
    } catch (error) {
      if (controller.signal.aborted || axios.isCancel(error)) return;
      if (error.response?.status === 401) handleLogout();
      else setReadErrors((current) => ({ ...current, [id]: donorApiError(error) }));
    } finally {
      if (!controller.signal.aborted) {
        pendingReads.current.delete(id);
        setPendingIds((current) => current.filter((item) => item !== id));
      }
    }
  }

  async function handleAvailability(value) {
    const controller = controllerRef.current;
    if (!controller || controller.signal.aborted || availabilityBusy.current || profile?.is_available === Number(value)) return;
    availabilityBusy.current = true;
    setAvailabilityPending(true);
    setAvailabilityError('');
    setActionMessage('');
    try {
      await updateDonorAvailability(session, value, controller.signal);
      if (controller.signal.aborted) return;
      setActionMessage('Donation availability updated.');
      setRetryCount((count) => count + 1);
    } catch (error) {
      if (controller.signal.aborted || axios.isCancel(error)) return;
      if (error.response?.status === 401) handleLogout();
      else setAvailabilityError(donorApiError(error));
    } finally {
      if (!controller.signal.aborted) {
        availabilityBusy.current = false;
        setAvailabilityPending(false);
      }
    }
  }

  async function handleResponse(request, response, button) {
    const hadFocus = document.activeElement === button;
    const controller = controllerRef.current;
    const id = request.request_id;
    if (!controller || controller.signal.aborted || pendingResponses.current.has(id)) return;
    const bankId = request.workflow_version === 2 && response === 'Accepted' ? Number(collectingBankIds[id]) : undefined;
    if (request.workflow_version === 2 && (!workflow.enabled || workflow.loading)) { setResponseErrors(current => ({...current,[id]:'The city-wide workflow is not activated.'})); return; }
    if (request.workflow_version === 2 && response === 'Accepted' && !request.eligible_collecting_banks.some(bank => bank.bank_id === bankId)) {
      setResponseErrors(current => ({...current,[id]:'Select an eligible collecting Blood Bank before accepting.'})); return;
    }
    pendingResponses.current.add(id);
    setResponsePending((current) => [...current, id]);
    setResponseErrors((current) => ({ ...current, [id]: '' }));
    setActionMessage('');
    try {
      const saved = await respondToDonorRequest(session, id, response, controller.signal, bankId);
      if (controller.signal.aborted) return;
      // Confirmed response hi UI mein dikhayenge; Accept donation nahi hai.
      if (hadFocus && (document.activeElement === button || document.activeElement === document.body)) {
        if (response === 'Accepted') button.closest('li').focus();
        else document.querySelector('.donor-refresh').focus();
      }
      setRequests((current) => response === 'Declined' ? current.filter((item) => item.request_id !== id)
        : current.map((item) => item.request_id === id ? { ...item, donor_response: 'Accepted', status: saved.status || 'Processing' } : item));
      if (response === 'Accepted') setRetryCount(count => count + 1);
      setActionMessage(response === 'Accepted' ? request.workflow_version === 2 ? 'Accepted. Request is Processing. Arrange screening through your designated collecting Blood Bank.' : 'Accepted. Request is Processing. Arrange screening through the selected hospital or blood bank.'
        : 'Request declined. This opportunity has been removed.');
    } catch (error) {
      if (controller.signal.aborted || axios.isCancel(error)) return;
      if (error.response?.status === 401) handleLogout();
      else setResponseErrors((current) => ({ ...current, [id]: donorApiError(error) }));
    } finally {
      if (!controller.signal.aborted) {
        pendingResponses.current.delete(id);
        setResponsePending((current) => current.filter((item) => item !== id));
      }
    }
  }

  async function saveLocation(event) {
    event.preventDefault();
    const controller = controllerRef.current;
    if (!controller || controller.signal.aborted || locationBusy.current) return;
    if (!locationForm.state || !locationForm.city.trim()) { setLocationError('Select your state and enter your city.'); return; }
    locationBusy.current = true; setLocationPending(true); setLocationError('');
    try {
      await updateDonorLocation(session, locationForm.state, locationForm.city, controller.signal);
      if (controller.signal.aborted) return;
      setActionMessage('Location updated. Matching uses your blood group, availability and the same city.');
      setRetryCount(count => count + 1);
    } catch (error) {
      if (controller.signal.aborted || axios.isCancel(error)) return;
      if (error.response?.status === 401) handleLogout(); else setLocationError(donorApiError(error));
    } finally {
      if (!controller.signal.aborted) { locationBusy.current = false; setLocationPending(false); }
    }
  }

  const retry = () => setRetryCount((count) => count + 1);
  const currentProfile = sections.profile.state === 'success' ? profile : null;
  const availability = currentProfile?.is_available;
  const unreadCount = notifications.filter((item) => item.is_read === 0).length;

  return (
    <main className="donor-dashboard">
      <div className="donor-container">
        <div className="donor-topbar">
          <nav className="donor-breadcrumb" aria-label="Breadcrumb"><Link to="/">Home</Link><span aria-hidden="true">/</span><span aria-current="page">Donor dashboard</span></nav>
          <button className="donor-logout" type="button" onClick={handleLogout}>Logout <span aria-hidden="true">&#8594;</span></button>
        </div>
        <section className="donor-hero" aria-labelledby="donor-welcome-title">
          <div className="donor-hero-copy">
            <p className="donor-kicker">Your donor workspace</p>
            <h1 id="donor-welcome-title" className="donor-welcome-title">{currentProfile?.name ? <>Welcome back,<br /><span>{currentProfile.name}!</span></> : 'Welcome back!'}</h1>
            <p className="donor-hero-description">Stay connected to requests where you may be able to help. A little support can make a lasting difference.</p>
          </div>
          <div className="donor-hero-art" aria-hidden="true"><svg viewBox="0 0 24 28" fill="none"><path d="M12 2C9 6 3 13 3 18a9 9 0 0 0 18 0c0-5-6-12-9-16Z" fill="currentColor" /><path d="M12 13v10M7 18h10" stroke="white" strokeWidth="2" strokeLinecap="round" /></svg><p>Connected by care.</p></div>
        </section>

        <WorkflowNotice config={workflow} />
        <WorkflowNotifications session={session} enabled={workflow.enabled} refreshKey={retryCount} onUnauthorized={handleLogout} />
        <section className="donor-profile" aria-label="Your donor profile">
          <div className="donor-profile-grid">
            <div><span>Blood Group</span><strong className="donor-profile-value donor-blood-group">{currentProfile?.blood_group || 'Not available'}</strong></div>
            <div><span>Location</span><strong className="donor-profile-value">{currentProfile ? [currentProfile.city, currentProfile.state].filter(Boolean).join(', ') || currentProfile.location || 'Not provided' : 'Not available'}</strong></div>
            <div><span>Donation Availability (Self-reported availability)</span><strong className={'donor-profile-value donor-availability ' + (availability === 1 ? 'donor-available' : '')}>{availability === 1 ? 'Available' : availability === 0 ? 'Unavailable' : 'Availability unavailable'}</strong>
              <div className="donor-availability-controls" aria-label="Donation availability">
                <button type="button" aria-pressed={availability === 1} disabled={availabilityPending || availability == null || sections.profile.state !== 'success'} onClick={() => handleAvailability(true)}>Available</button>
                <button type="button" aria-pressed={availability === 0} disabled={availabilityPending || availability == null || sections.profile.state !== 'success'} onClick={() => handleAvailability(false)}>Not Available</button>
              </div>
              {availabilityPending && <p role="status">Updating availability...</p>}
              {availabilityError && <p className="donor-action-error" role="alert">{availabilityError}</p>}
            </div>
          </div>
          <p className="donor-availability-note">{workflow.enabled ? 'Availability is self-reported. For city-wide requests, screening and actual collection take place through the designated collecting Blood Bank.' : 'Availability is self-reported. Screening and actual donation take place through an authorized hospital or blood bank.'}</p>
          {currentProfile && <form className="donor-location-form" onSubmit={saveLocation}>
            <h2>Your matching location</h2><p>Choose your actual state and city. Matching uses the same city without GPS.</p>
            <div><label htmlFor="donor-location-state">State / Union Territory</label><StateSelect id="donor-location-state" value={locationForm.state} onChange={event=>setLocationForm(current=>({...current,state:event.target.value}))} disabled={locationPending} required /></div>
            <div><label htmlFor="donor-location-city">City</label><input id="donor-location-city" type="text" maxLength="100" value={locationForm.city} onChange={event=>setLocationForm(current=>({...current,city:event.target.value}))} disabled={locationPending} required /></div>
            <button type="submit" disabled={locationPending}>{locationPending?'Saving location...':'Save location'}</button>
            {(!currentProfile.state||!currentProfile.city)&&<p>Please save your state and city to receive local matches.</p>}
            {locationError&&<p className="donor-action-error" role="alert">{locationError}</p>}
          </form>}
          <SectionState section={sections.profile} loadingText="Loading your profile..." onRetry={retry} />
        </section>

        {actionMessage && <p className="donor-action-success" role="status">{actionMessage}</p>}
        <div className="donor-summary-row">
          <div><span>Matching requests</span><strong>{sections.matches.state === 'success' ? requests.length : sections.matches.state === 'loading' ? '...' : 'Unavailable'}</strong></div>
          <div><span>Unread notifications</span><strong className="donor-unread-count">{sections.notifications.state === 'success' ? unreadCount : sections.notifications.state === 'loading' ? '...' : 'Unavailable'}</strong></div>
        </div>

        <div className="donor-content-grid">
          <section className="donor-card donor-matches" aria-labelledby="donor-matches-title">
            <div className="donor-card-heading"><p className="donor-kicker">Opportunities to help</p><h2 id="donor-matches-title">Matching Blood Requests</h2><p>{workflow.enabled ? 'Eligible Blood Banks in your city coordinate opportunities for your blood group. Choose a collecting Blood Bank before accepting.' : 'Requests appear when your selected provider seeks donors with your blood group in the same city.'}</p><button className="donor-refresh" type="button" onClick={retry}>Refresh dashboard</button></div>
            <SectionState section={sections.matches} loadingText="Loading matching blood requests..." onRetry={retry} />
            {sections.matches.state === 'success' && (requests.length === 0 ? (
              <div className="donor-empty"><span aria-hidden="true">&#9825;</span><h3>No matching blood requests right now.</h3><p>Requests will appear here when you are available to help and additional donor support is needed.</p></div>
            ) : (
              <ul className="donor-request-list">
                {requests.map((request) => <li tabIndex={-1} className="donor-request-item" key={request.request_id}>
                  <div className="donor-request-heading"><h3>Request #{request.request_id}</h3><span className={'donor-badge donor-status-' + request.status.toLowerCase()}>{request.status}</span></div>
                  <dl><div><dt>Blood Group</dt><dd>{request.blood_group}</dd></div><div><dt>Units Required</dt><dd>{request.units_required}</dd></div><div><dt>Fulfilled</dt><dd>{request.fulfilled_units}</dd></div><div><dt>Remaining</dt><dd>{request.remaining_units}</dd></div><div><dt>Urgency</dt><dd className={request.urgency_level === 'Emergency' ? 'donor-emergency' : ''}>{request.urgency_level}</dd></div></dl>
                  {request.workflow_version === 2 && request.donor_units_needed !== undefined && <div className="workflow-v2-context"><p>Uncovered donor units: <strong>{request.donor_units_needed}</strong>. This is the current shortage after eligible city Blood Bank stock; stock availability may change.</p><p>Acceptance does not fulfill units. Screening and genuine collection remain with your designated Blood Bank.</p></div>}
                  <p className="donor-request-date">{request.history_available
                    ? <>Inventory: {request.inventory_units} units &middot; Donation: {request.donation_units} units</>
                    : 'Historical fulfillment source details are unavailable.'}</p>
                  <p className="donor-request-date">Requested: {formatRequestDate(request.request_date)}</p>
                  <div className="donor-bank-details"><strong>{request.workflow_version===2?'Admission Hospital: ':''}{request.admission_hospital_name || request.organization_name || request.bank_name}</strong>
                    {request.city && <p>{[request.city, request.state].filter(Boolean).join(', ')}</p>}
                    {request.bank_address && <p>{request.bank_address}</p>}
                    {request.bank_phone && <p>Phone: {request.bank_phone}</p>}
                    {request.bank_email && <p>Email: {request.bank_email}</p>}
                  </div>
                  {request.collection_id&&<p className="workflow-collected">Recorded collection: {request.units_collected} units - {request.accounting_path==='Inventory'?'Bank inventory; not a direct request credit':'Direct request contribution'}.</p>}
                  {request.workflow_version===2&&request.collecting_bank_id&&<p className="workflow-v2-context">Designated collecting Blood Bank: <strong>{request.collecting_bank_name || '#' + request.collecting_bank_id}</strong>{request.collecting_bank_address && ' - ' + request.collecting_bank_address}. Screening and collection take place through this Blood Bank.</p>}
                  {request.donor_response === 'Accepted' ? <div className="donor-accepted" role="status">
                    <p>{request.status === 'Fulfilled' ? 'This request has been fulfilled.' : request.collection_id ? (request.accounting_path==='Inventory'?'Actual collection recorded into the collecting Blood Bank inventory. Request fulfillment requires a separate allocation.':'Actual donation recorded toward this request.') : request.screening_result === 'Passed' ? 'Screening passed. Awaiting confirmed donation through your provider.' : request.screening_result === 'Failed' ? 'Screening failed. No donation has been recorded from this screening.' : request.workflow_version === 2 ? 'Accepted - Awaiting designated collecting Blood Bank medical screening.' : 'Accepted - Awaiting Hospital / Blood Bank Medical Screening'}</p>
                    {request.recipient && <section className="donor-recipient-details" aria-label="Recipient coordination details"><h4>Recipient information</h4><p>{request.recipient.name}</p>
                      {request.recipient.age != null && <p>Age: {request.recipient.age}</p>}{request.recipient.gender && <p>Gender: {request.recipient.gender}</p>}
                      {request.recipient.phone && <p>Phone: {request.recipient.phone}</p>}{request.recipient.email && <p>Email: {request.recipient.email}</p>}
                      <p>Coordinate through {request.workflow_version === 2 ? request.collecting_bank_name || 'your designated collecting Blood Bank' : request.organization_name || request.bank_name}. Donation must take place through its authorized medical process.</p>
                    </section>}
                  </div>
                    : <div className="donor-response-actions">
                      {request.workflow_version===2&&<div className="donor-collecting-bank"><label htmlFor={'collecting-bank-'+request.request_id}>Collecting Blood Bank</label><select id={'collecting-bank-'+request.request_id} value={collectingBankIds[request.request_id]||''} disabled={!workflow.enabled||responsePending.includes(request.request_id)} onChange={event=>setCollectingBankIds(current=>({...current,[request.request_id]:event.target.value}))}><option value="">Select an eligible Blood Bank</option>{request.eligible_collecting_banks.map(bank=><option key={bank.bank_id} value={bank.bank_id}>{bank.bank_name}</option>)}</select><small>Choose where you will attend screening and donate. City-wide choices remain available.</small>{!request.eligible_collecting_banks.length&&<p>No eligible collecting Blood Bank is available. Refresh later.</p>}</div>}
                      <button className="donor-accept" type="button" disabled={responsePending.includes(request.request_id)||(request.workflow_version===2&&!workflow.enabled)} onClick={(event) => handleResponse(request, 'Accepted', event.currentTarget)}>Accept</button>
                      <button className="donor-decline" type="button" disabled={responsePending.includes(request.request_id)} onClick={(event) => handleResponse(request, 'Declined', event.currentTarget)}>Decline</button>
                    </div>}
                  {responsePending.includes(request.request_id) && <p role="status">Saving response...</p>}
                  {responseErrors[request.request_id] && <p className="donor-action-error" role="alert">{responseErrors[request.request_id]}</p>}
                </li>)}
              </ul>
            ))}
          </section>

          <section className="donor-card donor-notifications" aria-labelledby="donor-notifications-title">
            <div className="donor-card-heading"><p className="donor-kicker">Stay informed</p><h2 id="donor-notifications-title">Notifications</h2><p>Updates sent to your donor account.</p></div>
            <SectionState section={sections.notifications} loadingText="Loading your notifications..." onRetry={retry} />
            {sections.notifications.state === 'success' && (notifications.length === 0 ? (
              <div className="donor-empty"><span aria-hidden="true">&#9993;</span><h3>No notifications yet.</h3><p>Your account updates will appear here.</p></div>
            ) : (
              <ul className="donor-notification-list">{notifications.map((item) => <li tabIndex={-1} className={'donor-notification-item ' + (item.is_read === 0 ? 'donor-notification-unread' : '')} key={item.notification_id}>
                <span className="donor-read-state" role="status">{item.is_read === 0 ? 'Unread' : 'Read'}</span>
                <p className="donor-notification-message">{item.message}</p>
                <p className="donor-notification-date">{formatRequestDate(item.sent_at)}</p>
                {item.is_read === 0 && <button className="donor-mark-read" type="button" disabled={pendingIds.includes(item.notification_id)} onClick={(event) => handleMarkRead(item.notification_id, event.currentTarget)}>{pendingIds.includes(item.notification_id) ? 'Marking...' : 'Mark as read'}</button>}
                {readErrors[item.notification_id] && <p className="donor-read-error" role="alert">{readErrors[item.notification_id]}</p>}
              </li>)}</ul>
            ))}
          </section>
        </div>
        <p className="donor-footer">LifeSaver <span aria-hidden="true">&#8226;</span> Blood Donation Management System</p>
      </div>
    </main>
  );
}

function DonorDashboard() {
  const { session, logout } = useAuth();
  // Account change par old profile, requests aur notifications turant clear honge.
  return <DonorDashboardContent key={session.token} session={session} logout={logout} />;
}
export default DonorDashboard;
