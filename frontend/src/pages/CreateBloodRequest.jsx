import useWorkflowConfig from '../hooks/useWorkflowConfig.js';
import WorkflowNotice from '../components/WorkflowNotice.jsx';
import { hospitalHelp, sameArea } from '../services/workflowV2Api.js';
import '../styles/workflowV2.css';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../config/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { normalizeAuthSession } from '../utils/authStorage.js';
import { fetchOrganizations, fetchOrganizationCities } from '../services/organizationApi.js';
import StateSelect from '../components/StateSelect.jsx';
import '../styles/createBloodRequest.css';

const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const emptyForm = { state: '', city: '', organization_id: '', blood_group: '', units_required: '', urgency_level: 'Normal' };
const maxInteger = 2147483647;

function CreateBloodRequest() {
  const { session, logout } = useAuth();
  const workflow = useWorkflowConfig(session);
  const [form, setForm] = useState({ ...emptyForm });
  const [error, setError] = useState('');
  const [banks, setBanks] = useState([]);
  const [cities, setCities] = useState([]);
  const [cityState, setCityState] = useState('idle');
  const [bankState, setBankState] = useState('loading');
  const [bankError, setBankError] = useState('');
  const [bankRetry, setBankRetry] = useState(0);
  const [success, setSuccess] = useState(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const isSubmitting = useRef(false);
  const hasCreated = useRef(false);
  const requestController = useRef(null);
  const previousToken = useRef(session.token);
  const successHeading = useRef(null);

  useEffect(() => {
    // Account badalne par purana form/result clear hoga.
    if (previousToken.current !== session.token) {
      previousToken.current = session.token;
      setForm({ ...emptyForm });
      setError('');
      setSuccess(null);
      setNeedsLogin(false);
      setIsLoading(false);
      isSubmitting.current = false;
      hasCreated.current = false;
    }
    return () => {
      // Page chhodne ya session badalne par pending HTTP request cancel hoga.
      const controller = requestController.current;
      requestController.current = null;
      controller?.abort();
    };
  }, [session.token]);

  useEffect(() => {
    if (success) successHeading.current?.focus();
  }, [success]);

  useEffect(() => {
    const controller = new AbortController();
    setCities([]); setCityState(form.state ? 'loading' : 'idle');
    if (!form.state || workflow.loading) return () => controller.abort();
    fetchOrganizationCities(session, form.state, controller.signal, workflow.enabled ? 'Hospital' : undefined).then(rows => {
      if (controller.signal.aborted) return;
      setCities(rows); setCityState('success');
    }).catch(requestError => {
      if (controller.signal.aborted || axios.isCancel(requestError)) return;
      setCityState('error');
      setBankError('Unable to load registered cities. Please try again.');
      if (requestError.response?.status === 401) setNeedsLogin(true);
    });
    return () => controller.abort();
  }, [session, form.state, bankRetry, workflow.enabled, workflow.loading]);

  useEffect(() => {
    const controller = new AbortController();
    setBanks([]); setBankState(form.state && form.city ? 'loading' : 'idle'); setBankError('');
    if (!form.state || !form.city || workflow.loading) return () => controller.abort();
    fetchOrganizations(session, form.state, form.city, controller.signal, workflow.enabled ? 'Hospital' : undefined).then(rows => {
      if (controller.signal.aborted) return;
      setBanks(rows); setBankState('success');
    }).catch(requestError => {
      if (controller.signal.aborted || axios.isCancel(requestError)) return;
      setBankState('error');
      if (requestError.response?.status === 401 || requestError.response?.status === 403) {
        setBankError('Please log in again as a recipient to load registered organizations.'); setNeedsLogin(true);
      } else setBankError('Unable to load registered organizations. Check your connection and try again.');
    });
    return () => controller.abort();
  }, [session, form.state, form.city, bankRetry, workflow.enabled, workflow.loading]);

  function handleChange(event) {
    const { name, value } = event.target;
    setForm(current => ({ ...current, [name]: value, ...(name === 'state' ? { city: '', organization_id: '' } : name === 'city' ? { organization_id: '' } : {}) }));
    setError('');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (isSubmitting.current || hasCreated.current || needsLogin || workflow.loading) return;
    setError('');

    const currentSession = normalizeAuthSession(session);
    if (!currentSession || currentSession.user.user_type !== 'recipient'
      || currentSession.user.user_id > maxInteger) {
      setError('Your recipient session could not be verified. Please log in again.');
      setNeedsLogin(true);
      return;
    }
    const selectedBankId = Number(form.organization_id);
    if (bankState !== 'success' || !Number.isSafeInteger(selectedBankId) || !banks.some(bank => bank.organization_id === selectedBankId && (workflow.enabled
      ? bank.organization_type === 'Hospital' && sameArea(bank.state, form.state) && sameArea(bank.city, form.city)
      : bank.state === form.state && bank.city === form.city))) {
      setError(workflow.enabled ? 'Please select the registered hospital where the patient is admitted.' : 'Please select a registered hospital or blood bank in your selected city.');
      return;
    }
    if (!bloodGroups.includes(form.blood_group)) {
      setError('Please select a supported blood group.');
      return;
    }
    const units = Number(form.units_required);
    if (!Number.isInteger(units) || units < 1 || units > maxInteger) {
      setError('Enter a positive whole number of units (maximum 2147483647).');
      return;
    }
    if (!['Normal', 'Emergency'].includes(form.urgency_level)) {
      setError('Please select Normal or Emergency urgency.');
      return;
    }


    // The backend validates the provider and location against the registered directory.
    const payload = {
      ...(workflow.enabled ? { admission_hospital_id: selectedBankId }
        : { recipient_id: currentSession.user.user_id, organization_id: selectedBankId }),
      state: form.state,
      city: form.city,
      blood_group: form.blood_group,
      units_required: units,
      urgency_level: form.urgency_level,
    };
    const controller = new AbortController();
    requestController.current = controller;
    isSubmitting.current = true;
    setIsLoading(true);

    try {
      const response = await axios.post(API_BASE_URL + '/api/requests', payload, {
        headers: { Authorization: 'Bearer ' + currentSession.token },
        timeout: 15000,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status !== 201) {
        setError('The server returned an unexpected response. Please try again.');
        return;
      }
      hasCreated.current = true;
      const requestId = response.data?.request_id;
      // Response ka message/extra fields render nahi karenge.
      setSuccess({ requestId: Number.isSafeInteger(requestId) && requestId > 0 ? requestId : null });
      setForm({ ...emptyForm });
    } catch (requestError) {
      if (axios.isCancel(requestError) || controller.signal.aborted) return;
      const status = requestError.response?.status;
      if (status === 400) {
        setError('Please check your selected organization, location, blood group, units and urgency, then try again.');
      } else if (status === 401 || status === 403) {
        setError('Your session could not be verified. Please log in again as a recipient.');
        setNeedsLogin(true);
      } else if (status === 404) {
        setError('Your recipient account could not be found. Please log in again.');
        setNeedsLogin(true);
      } else if (status === 409) {
        setError('This request conflicts with an existing record. Please check your details and try again.');
      } else if (status === 413) {
        setError('The request could not be accepted because it is too large. Please try again.');
      } else if (status >= 500) {
        setError('The server could not create your blood request. Please try again later.');
      } else if (axios.isAxiosError(requestError) && !requestError.response) {
        setError('Unable to reach the backend. Check that it is running and your connection is available, then try again.');
      } else {
        setError('Unable to create your blood request. Please try again.');
      }
    } finally {
      // Cancel hua purana request naye account ki loading state ko change nahi karega.
      if (requestController.current === controller) {
        requestController.current = null;
        isSubmitting.current = false;
        setIsLoading(false);
      }
    }
  }

  return (
    <main className="create-request-page">
      <div className="create-request-container">
        <nav className="create-request-breadcrumb" aria-label="Breadcrumb">
          <Link to="/recipient/dashboard">Recipient Dashboard</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Create blood request</span>
        </nav>
        <div className="create-request-heading">
          <p className="create-request-kicker">Your recipient workspace</p>
          <h1>Create Blood Request</h1>
          <p>{workflow.enabled ? hospitalHelp : 'Select your state, city and a registered hospital or blood bank. Your provider coordinates screening, donation and fulfillment.'}</p>
          <WorkflowNotice config={workflow} />
        </div>

        <div className="create-request-layout">
          <section className="create-request-card" aria-labelledby="create-request-card-title">
            {success ? (
              <div className="create-request-success" role="status">
                <span className="create-request-success-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none"><path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
                <p className="create-request-kicker">Request submitted</p>
                <h2 id="create-request-card-title" ref={successHeading} tabIndex={-1}>Blood request created successfully.</h2>
                <p>{workflow.enabled ? 'Your request is linked to the admission hospital and shared with eligible Blood Banks in the selected city.' : 'Your blood request has been saved.'}</p>
                {success.requestId && <span className="create-request-id">Request #{success.requestId}</span>}
                <Link className="create-request-button create-request-primary" to="/recipient/dashboard">Return to Recipient Dashboard</Link>
              </div>
            ) : (
              <>
                <div className="create-request-card-heading">
                  <span className="create-request-heading-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 28" fill="none"><path d="M12 2C9 6 3 13 3 18a9 9 0 0 0 18 0c0-5-6-12-9-16Z" fill="currentColor" /></svg>
                  </span>
                  <div><h2 id="create-request-card-title">Request details</h2><p>{workflow.enabled ? 'Select the admission Hospital and complete the request details.' : 'Select a registered provider and complete the request details.'}</p></div>
                </div>
                <form className="create-request-form" onSubmit={handleSubmit} noValidate aria-busy={isLoading}>
                  <div className="create-request-field">
                    <label htmlFor="request-state">State / Union Territory <span aria-hidden="true">*</span></label>
                    <StateSelect id="request-state" name="state" value={form.state} onChange={handleChange} required disabled={isLoading || needsLogin} />
                  </div>
                  <div className="create-request-field">
                    <label htmlFor="request-city">City <span aria-hidden="true">*</span></label>
                    <select id="request-city" name="city" value={form.city} onChange={handleChange} required disabled={isLoading || needsLogin || cityState !== 'success' || cities.length === 0}>
                      <option value="">{form.state ? 'Select a city' : 'Select a state first'}</option>
                      {cities.map(city => <option key={city} value={city}>{city}</option>)}
                    </select>
                    {cityState === 'loading' && <small role="status">Loading registered cities...</small>}
                    {cityState === 'success' && cities.length === 0 && <small role="status">No registered organizations found</small>}
                    {cityState === 'error' && <div role="alert" className="create-request-error"><p>Unable to load registered cities.</p><button type="button" onClick={() => setBankRetry(count => count + 1)}>Try again</button></div>}
                  </div>
                  <div className="create-request-field">
                    <label htmlFor="request-organization">{workflow.enabled ? 'Hospital where the patient is admitted' : 'Hospital / Blood Bank'} <span aria-hidden="true">*</span></label>
                    <select id="request-organization" name="organization_id" value={form.organization_id} onChange={handleChange} required disabled={workflow.loading || isLoading || needsLogin || bankState !== 'success' || banks.length === 0}>
                      <option value="">{form.city ? 'Select a registered organization' : 'Select a city first'}</option>
                      {banks.map(bank => <option key={bank.organization_id} value={bank.organization_id}>{bank.name} &middot; {bank.organization_type}</option>)}
                    </select>
                    {workflow.enabled && <small>{hospitalHelp}</small>}
                    {bankState === 'loading' && <small role="status">Loading registered organizations...</small>}
                    {bankState === 'success' && banks.length === 0 && <small role="status">No registered organizations found</small>}
                    {bankState === 'error' && <div className="create-request-error" role="alert"><p>{bankError}</p><button type="button" className="create-request-back" onClick={() => setBankRetry(count => count + 1)} disabled={isLoading || needsLogin}>Try again</button>{needsLogin && <Link to="/login" onClick={logout}>Log in again</Link>}</div>}
                  </div>
                  <div className="create-request-field">
                    <label htmlFor="request-blood-group">Blood Group <span aria-hidden="true">*</span></label>
                    <select id="request-blood-group" name="blood_group" value={form.blood_group} onChange={handleChange} required disabled={isLoading || needsLogin}>
                      <option value="">Select blood group</option>
                      {bloodGroups.map(group => <option key={group} value={group}>{group}</option>)}
                    </select>
                  </div>
                  <div className="create-request-field">
                    <label htmlFor="request-units">Units Required <span aria-hidden="true">*</span></label>
                    <input id="request-units" name="units_required" type="number" inputMode="numeric" min="1" max={maxInteger} step="1" placeholder="e.g. 2" value={form.units_required} onChange={handleChange} required disabled={isLoading || needsLogin} aria-describedby="request-units-hint" />
                    <small id="request-units-hint">Enter a positive whole number of units.</small>
                  </div>
                  <div className="create-request-field">
                    <label htmlFor="request-urgency">Urgency <span aria-hidden="true">*</span></label>
                    <select id="request-urgency" name="urgency_level" value={form.urgency_level} onChange={handleChange} required disabled={isLoading || needsLogin}>
                      <option value="Normal">Normal</option>
                      <option value="Emergency">Emergency</option>
                    </select>
                  </div>
                  {error && (
                    <div className="create-request-error" role="alert">
                      <p>{error}</p>
                      {needsLogin && <Link to="/login" onClick={logout}>Log in again</Link>}
                    </div>
                  )}
                  <div className="create-request-form-actions">
                    <button className="create-request-button create-request-primary" type="submit" disabled={isLoading || needsLogin || bankState !== 'success' || banks.length === 0}>{isLoading ? 'Submitting...' : 'Submit Blood Request'}</button>
                    <Link className="create-request-back" to="/recipient/dashboard">Back to dashboard</Link>
                  </div>
                </form>
              </>
            )}
          </section>

          <aside className="create-request-sidebar" aria-label="Request information">
            <section className="create-request-account" aria-labelledby="request-account-title">
              <span className="create-request-avatar" aria-hidden="true">R</span>
              <h2 id="request-account-title">Your recipient account</h2>
              <p>Recipient #{session.user.user_id}</p>
              <div className="create-request-account-note">This request is linked to the account you are signed in with.</div>
            </section>
            <section className="create-request-guide" aria-labelledby="request-guide-title">
              <h2 id="request-guide-title">Before you submit</h2>
              <p>{workflow.enabled ? 'Check the admission Hospital, location, blood group, units and urgency. Designated collecting Blood Banks handle donor screening and actual collection.' : 'Check the organization, location, blood group, units and urgency. Donation must take place through an authorized hospital or blood bank.'}</p>
              <span>Every detail helps keep your request clear.</span>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

export default CreateBloodRequest;
