import useWorkflowConfig from '../hooks/useWorkflowConfig.js';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext.jsx';
import StateSelect from '../components/StateSelect.jsx';
import BloodBankDashboard from './BloodBankDashboard.jsx';
import { indiaStates } from '../data/indiaStates.js';
import { fetchOrganizationProfile, updateOrganizationLocation, organizationError } from '../services/organizationApi.js';
import '../styles/organizationDashboard.css';

function OrganizationContent({ session, logout }) {
  const workflow = useWorkflowConfig(session);
  const navigate = useNavigate();
  const [profile, setProfile] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState(false);
  const [location, setLocation] = useState({ state: '', city: '' });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const saveController = useRef(null);
  const submitting = useRef(false);

  function expire() {
    logout();
    navigate('/login', { replace: true });
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoadState('loading');
    setError('');
    fetchOrganizationProfile(session, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setProfile(value);
      setLocation({ state: indiaStates.includes(value.state) ? value.state : '', city: value.city ?? '' });
      setLoadState('success');
    }).catch(requestError => {
      if (controller.signal.aborted || axios.isCancel(requestError)) return;
      if (requestError.response?.status === 401) expire();
      else { setError(organizationError(requestError)); setLoadState('error'); }
    });
    return () => { controller.abort(); saveController.current?.abort(); };
  }, [session.token, retry]);

  async function saveLocation(event) {
    event.preventDefault();
    if (submitting.current) return;
    setError('');
    setNotice('');
    if (!indiaStates.includes(location.state) || !location.city.trim() || location.city.trim().length > 100) {
      setError('Select a state or union territory and enter your city.');
      return;
    }
    submitting.current = true;
    setSaving(true);
    const controller = new AbortController();
    saveController.current = controller;
    try {
      const value = await updateOrganizationLocation(session, location, controller.signal);
      if (controller.signal.aborted) return;
      setProfile(value);
      setLocation({ state: value.state ?? '', city: value.city ?? '' });
      setEditing(false);
      setNotice('Organization location saved.');
    } catch (requestError) {
      if (controller.signal.aborted || axios.isCancel(requestError)) return;
      if (requestError.response?.status === 401) expire();
      else setError(organizationError(requestError, 'save the organization location'));
    } finally {
      if (saveController.current === controller) {
        saveController.current = null;
        submitting.current = false;
        if (!controller.signal.aborted) setSaving(false);
      }
    }
  }

  if (loadState === 'loading') return <main className="organization-page"><p role="status">Loading your organization...</p></main>;
  if (loadState === 'error') return (
    <main className="organization-page"><div className="organization-card">
      <h1>Organization Dashboard</h1><p className="organization-error" role="alert">{error}</p>
      <button className="organization-button" onClick={() => setRetry(value => value + 1)}>Try again</button>
      <button className="organization-secondary" onClick={expire}>Logout</button>
    </div></main>
  );
  const hasLocation = indiaStates.includes(profile.state) && typeof profile.city === 'string' && profile.city.trim();
  const isProvider = ['Hospital', 'Blood Bank'].includes(profile.organization_type);
  const showForm = editing || !hasLocation;
  const locationPanel = (
    <section className="organization-card organization-location" aria-labelledby="organization-location-title">
      <div className="organization-heading">
        <div><span className="organization-type">{profile.organization_type}</span>
          <h2 id="organization-location-title">{hasLocation ? profile.city + ', ' + profile.state : 'Complete your organization location'}</h2>
          <p>{hasLocation ? 'Your registered location is used for requests and donor matching.'
            : 'Add a state and city so recipients and donors can find your organization.'}</p></div>
        {hasLocation && !editing && <button className="organization-secondary" onClick={() => { setEditing(true); setError(''); setNotice(''); }}>Edit location</button>}
      </div>
      {showForm && (
        <form className="organization-location-form" onSubmit={saveLocation} noValidate aria-busy={saving}>
          <fieldset disabled={saving}>
            <div className="organization-field"><label htmlFor="organization-state">State / Union Territory *</label>
              <StateSelect id="organization-state" value={location.state} required
                onChange={event => setLocation({ state: event.target.value, city: '' })} /></div>
            <div className="organization-field"><label htmlFor="organization-city">City *</label>
              <input id="organization-city" value={location.city} maxLength={100} required disabled={!location.state}
                onChange={event => setLocation(current => ({ ...current, city: event.target.value }))} /></div>
          </fieldset>
          <div className="organization-actions">
            <button className="organization-button" type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save location'}</button>
            {hasLocation && <button className="organization-secondary" type="button" disabled={saving}
              onClick={() => { setEditing(false); setLocation({ state: profile.state, city: profile.city }); setError(''); }}>Cancel</button>}
          </div>
        </form>
      )}
      {error && <p className="organization-error" role="alert">{error}</p>}
      {notice && <p className="organization-notice" role="status">{notice}</p>}
    </section>
  );

  if (isProvider && hasLocation && (profile.bank_id || (workflow.enabled && profile.organization_type === 'Hospital'))) return (
    <><div className="organization-provider-location">{locationPanel}</div><BloodBankDashboard provider={profile} /></>
  );
  return (
    <main className="organization-page">
      <div className="organization-topbar"><p className="organization-kicker">Your organization workspace</p>
        <button className="organization-secondary" onClick={expire}>Logout</button></div>
      <h1>{profile.name}</h1>
      <p className="organization-intro">{isProvider
        ? 'Manage blood requests and coordinate donations through your organization.'
        : 'Support your community through your registered NGO.'}</p>
      {locationPanel}
      <section className="organization-card" aria-labelledby="organization-profile-title">
        <h2 id="organization-profile-title">Organization profile</h2>
        <dl className="organization-profile">
          <div><dt>Name</dt><dd>{profile.name}</dd></div>
          <div><dt>Type</dt><dd>{profile.organization_type}</dd></div>
          <div><dt>Address</dt><dd>{profile.address || 'Not provided'}</dd></div>
          <div><dt>Phone</dt><dd>{profile.phone || 'Not provided'}</dd></div>
          <div><dt>Email</dt><dd>{profile.email || 'Not provided'}</dd></div>
        </dl>
        {!isProvider && <p className="organization-note">Hospitals and blood banks manage clinical screening, donations and inventory. Your NGO account supports community coordination.</p>}
        {isProvider && !profile.bank_id && <p className="organization-error" role="alert">A provider inventory account has not been linked. Clinical operations are unavailable.</p>}
      </section>
    </main>
  );
}

function OrganizationDashboard() {
  const { session, logout } = useAuth();
  return <OrganizationContent key={session.token} session={session} logout={logout} />;
}
export default OrganizationDashboard;
