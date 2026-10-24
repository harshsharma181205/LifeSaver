import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../config/api.js';
import '../styles/register.css';
import StateSelect from '../components/StateSelect.jsx';
import { indiaStates } from '../data/indiaStates.js';

const bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const emptyForm = {
  name: '',
  organization_type: 'Hospital',
  state: '',
  city: '',
  gender: '',
  blood_group: '',
  date_of_birth: '',
  age: '',
  phone: '',
  email: '',
  address: '',
  location: '',
  last_donation: '',
  is_available: 'true',
  monitored_by: '',
  password: '',
  confirmPassword: '',
};

function getToday() {
  // Backend ki tarah aaj ki date India timezone se nikalenge.
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year').value;
  const month = parts.find((part) => part.type === 'month').value;
  const day = parts.find((part) => part.type === 'day').value;
  return `${year}-${month}-${day}`;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1000) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateForm(data, accountType) {
  if (!data.name.trim() || (accountType !== 'organization' && (!data.gender || !data.blood_group)) ||
      !data.phone.trim() || !data.password.trim() || !data.confirmPassword) {
    return 'Please complete all required fields.';
  }
  const phone = data.phone.trim();
  if (!/^\+?\d{10,15}$/.test(phone) || phone.length > 15) {
    return 'Enter 10 to 15 phone digits, optionally starting with +, with at most 15 characters in total.';
  }
  // Basic format yahan check hoga; final email validation backend karega.
  if (data.email.trim() && !/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,63}$/.test(data.email.trim())) {
    return 'Please enter a valid email address.';
  }
  if (data.password.trim().length < 8) {
    return 'Use a password with at least 8 characters, excluding spaces at the beginning and end.';
  }
  if (data.password !== data.confirmPassword) {
    return 'Password and Confirm Password must match.';
  }

  if (accountType === 'organization'
    && (!['Hospital', 'Blood Bank', 'NGO'].includes(data.organization_type)
      || !data.address.trim() || !data.email.trim())) {
    return 'Please complete the organization type, address and email.';
  }
  if ((accountType === 'donor' || accountType === 'organization')
    && (!indiaStates.includes(data.state) || !data.city.trim() || data.city.trim().length > 100)) {
    return 'Please select a state or union territory and enter your city.';
  }

  if (accountType === 'donor') {
    if (!isValidDate(data.date_of_birth)) {
      return 'Please enter a valid Date of Birth.';
    }
    if (data.date_of_birth > getToday()) {
      return 'Date of Birth cannot be in the future.';
    }
    if (data.last_donation) {
      if (!isValidDate(data.last_donation)) {
        return 'Please enter a valid Last Donation Date.';
      }
      if (data.last_donation > getToday()) {
        return 'Last Donation Date cannot be in the future.';
      }
      if (data.last_donation < data.date_of_birth) {
        return 'Last Donation Date cannot be before Date of Birth.';
      }
    }
  } else if (accountType === 'recipient') {
    const age = Number(data.age);
    if (!data.age.trim() || !Number.isInteger(age) || age < 1 || age > 129) {
      return 'Please enter a whole-number age from 1 to 129.';
    }
    if (data.monitored_by.trim()) {
      const adminId = Number(data.monitored_by);
      if (!Number.isInteger(adminId) || adminId < 1 || adminId > 2147483647) {
        return 'Monitored By must be a positive whole-number administrator ID.';
      }
    }
  }
  return '';
}

function Register() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const requestedType = ['donor', 'recipient', 'organization'].includes(searchParams.get('type'))
    ? searchParams.get('type') : 'donor';
  const [accountType, setAccountType] = useState(requestedType);
  const [formData, setFormData] = useState({ ...emptyForm });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const isSubmitting = useRef(false);
  const requestController = useRef(null);
  const isDonor = accountType === 'donor';
  const isOrganization = accountType === 'organization';
  const today = getToday();

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    // Footer link se sahi account form khulega.
    requestController.current?.abort();
    requestController.current = null;
    isSubmitting.current = false;
    setIsLoading(false);
    setAccountType(requestedType);
    setFormData({ ...emptyForm });
    setError('');
    setSuccess('');
  }, [location.key, requestedType]);

  function clearMessages() {
    setError('');
    setSuccess('');
  }

  function handleChange(event) {
    const { name, value } = event.target;
    setFormData((current) => ({ ...current, [name]: value, ...(name === 'state' ? { city: '' } : {}) }));
    clearMessages();
  }

  function handleTypeChange(event) {
    setAccountType(event.target.value);
    // Type badalne par purani details aur passwords clear karenge.
    setFormData({ ...emptyForm });
    clearMessages();
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (isSubmitting.current) return;
    clearMessages();

    const validationError = validateForm(formData, accountType);
    if (validationError) {
      setError(validationError);
      return;
    }

    // API mein sirf selected account type ke fields jayenge.
    const payload = {
      name: formData.name.trim(),
      ...(isOrganization ? { organization_type: formData.organization_type } : { gender: formData.gender, blood_group: formData.blood_group }),
      phone: formData.phone.trim(),
      password: formData.password,
    };
    if (formData.email.trim()) payload.email = formData.email.trim();

    if (isDonor || isOrganization) {
      payload.state = formData.state;
      payload.city = formData.city.trim().replace(/\s+/g, ' ');
      if (formData.address.trim()) payload.address = formData.address.trim();
    }
    if (isDonor) {
      payload.date_of_birth = formData.date_of_birth;
      payload.is_available = formData.is_available === 'true';
      if (formData.address.trim()) payload.address = formData.address.trim();
      if (formData.location.trim()) payload.location = formData.location.trim();
      if (formData.last_donation) payload.last_donation = formData.last_donation;
    } else if (!isOrganization) {
      payload.age = Number(formData.age);
      if (formData.monitored_by.trim()) payload.monitored_by = Number(formData.monitored_by);
    }

    isSubmitting.current = true;
    setIsLoading(true);
    const controller = new AbortController();
    requestController.current = controller;

    try {
      const endpoint = isOrganization ? '/api/organizations' : isDonor ? '/api/donors' : '/api/recipients';
      const response = await axios.post(`${API_BASE_URL}${endpoint}`, payload, { timeout: 15000, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.status !== 201) {
        setError('The server returned an unexpected registration response. Please try again.');
        return;
      }

      // Response mein password/hash ho bhi toh use display ya store nahi karenge.
      setSuccess(`Your ${accountType} account was registered successfully. You can now log in.`);
      setFormData({ ...emptyForm });
    } catch (requestError) {
      if (controller.signal.aborted || axios.isCancel(requestError)) return;
      const status = requestError.response?.status;
      if (status === 400) {
        const message = requestError.response?.data?.message;
        if (message === 'monitored_by must refer to an existing admin.') {
          setError('The Monitored By ID does not match an existing administrator. Check the ID or leave it blank.');
        } else if (message === 'email must be a valid email address.') {
          setError('Please enter a valid email address.');
        } else {
          setError('Some registration details are invalid. Please check your fields and try again.');
        }
      } else if (status === 409) {
        setError(isDonor
          ? 'A donor with this phone number or email already exists. Please log in or use different details.'
          : 'These details conflict with an existing record. Please check them and try again.');
      } else if (status === 413) {
        setError('Your registration request is too large. Please shorten your details and try again.');
      } else if (status >= 500) {
        setError('The server could not complete your registration. Please try again later.');
      } else if (axios.isAxiosError(requestError) && !requestError.response) {
        setError('Unable to reach the backend. Check that it is running and your connection is available, then try again.');
      } else {
        setError('Unable to register. Please try again.');
      }
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
        if (!controller.signal.aborted) {
          setFormData((current) => ({ ...current, password: '', confirmPassword: '' }));
          setIsLoading(false);
          isSubmitting.current = false;
        }
      }
    }
  }

  return (
    <main className="register-page">
      <section className="register-card" aria-labelledby="register-title">
        <div className="register-heading">
          <p className="eyebrow">Join our community</p>
          <h1 id="register-title">LifeSaver</h1>
          <p className="register-subtitle">Blood Donation Management System</p>
          <p className="register-intro">Create a donor, recipient or organization account. Fields marked * are required.</p>
        </div>

        <form className="register-form" onSubmit={handleSubmit} noValidate aria-busy={isLoading}>
          <div className="register-field">
            <label htmlFor="register-type">Account type</label>
            <select id="register-type" value={accountType} onChange={handleTypeChange} disabled={isLoading}>
              <option value="donor">Donor</option>
              <option value="recipient">Recipient</option>
              <option value="organization">Organization</option>
            </select>
          </div>

          <fieldset className="register-section" disabled={isLoading}>
            <legend>{isOrganization ? 'Organization details' : 'Personal details'}</legend>
            <div className="register-grid">
              <div className={isOrganization ? 'register-field' : 'register-field register-full-width'}>
                <label htmlFor="register-name">{isOrganization ? 'Organization Name *' : 'Full Name *'}</label>
                <input id="register-name" name="name" autoComplete={isOrganization ? 'organization' : 'name'} maxLength={100} value={formData.name} onChange={handleChange} required />
              </div>
              {isOrganization ? (
                <div className="register-field">
                  <label htmlFor="register-organization-type">Organization Type *</label>
                  <select id="register-organization-type" name="organization_type" value={formData.organization_type} onChange={handleChange} required>
                    <option value="Hospital">Hospital</option>
                    <option value="Blood Bank">Blood Bank</option>
                    <option value="NGO">NGO</option>
                  </select>
                  <small>{formData.organization_type === 'NGO'
                    ? 'NGOs coordinate community support. Screening and donation recording are reserved for hospitals and blood banks.'
                    : 'Coordinate blood requests, screening and donations through your organization.'}</small>
                </div>
              ) : (<>
              <div className="register-field">
                <label htmlFor="register-gender">Gender *</label>
                <select id="register-gender" name="gender" value={formData.gender} onChange={handleChange} required>
                  <option value="">Select gender</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div className="register-field">
                <label htmlFor="register-blood-group">Blood Group *</label>
                <select id="register-blood-group" name="blood_group" value={formData.blood_group} onChange={handleChange} required>
                  <option value="">Select blood group</option>
                  {bloodGroups.map((group) => <option key={group} value={group}>{group}</option>)}
                </select>
              </div>
              {isDonor ? (
                <div className="register-field">
                  <label htmlFor="register-date-of-birth">Date of Birth *</label>
                  <input id="register-date-of-birth" name="date_of_birth" type="date" min="1000-01-01" max={today} value={formData.date_of_birth} onChange={handleChange} required />
                </div>
              ) : (
                <div className="register-field">
                  <label htmlFor="register-age">Age *</label>
                  <input id="register-age" name="age" type="number" min="1" max="129" step="1" value={formData.age} onChange={handleChange} required />
                </div>
              )}
              </>)}
            </div>
          </fieldset>

          <fieldset className="register-section" disabled={isLoading}>
            <legend>Contact details</legend>
            <div className="register-grid">
              <div className="register-field">
                <label htmlFor="register-phone">Phone *</label>
                <input id="register-phone" name="phone" type="tel" autoComplete="tel" maxLength={15} aria-describedby="register-phone-hint" value={formData.phone} onChange={handleChange} required />
                <small id="register-phone-hint">Use 10-15 digits; + is optional (15 characters maximum).</small>
              </div>
              <div className="register-field">
                <label htmlFor="register-email">{isOrganization ? 'Email *' : 'Email (optional)'}</label>
                <input id="register-email" name="email" type="email" autoComplete="email" maxLength={100} value={formData.email} onChange={handleChange} required={isOrganization} />
              </div>
              {isDonor || isOrganization ? (
                <>
                  <div className="register-field register-full-width">
                    <label htmlFor="register-address">{isOrganization ? 'Address *' : 'Address (optional)'}</label>
                    <textarea id="register-address" name="address" rows="3" autoComplete="street-address" maxLength={255} value={formData.address} onChange={handleChange} required={isOrganization} />
                  </div>
                  <div className="register-field">
                    <label htmlFor="register-state">State / Union Territory *</label>
                    <StateSelect id="register-state" value={formData.state} onChange={handleChange} searchable={false} required />
                  </div>
                  <div className="register-field">
                    <label htmlFor="register-city">City *</label>
                    <input id="register-city" name="city" maxLength={100} autoComplete="address-level2" aria-describedby="register-city-hint" placeholder={formData.state ? 'Enter your city' : 'Select a state first'} value={formData.city} onChange={handleChange} disabled={!formData.state} required />
                    <small id="register-city-hint">{formData.state ? 'Enter your city in ' + formData.state + '.' : 'Select a state or union territory to enter your city.'}</small>
                  </div>
                  {isDonor && <div className="register-field register-full-width">
                    <label htmlFor="register-location">Area / locality (optional)</label>
                    <input id="register-location" name="location" maxLength={100} value={formData.location} onChange={handleChange} />
                  </div>}
                </>
              ) : (
                <div className="register-field register-full-width">
                  <label htmlFor="register-monitored-by">Monitored By (optional)</label>
                  <input id="register-monitored-by" name="monitored_by" type="number" min="1" max="2147483647" step="1" aria-describedby="register-monitored-by-hint" value={formData.monitored_by} onChange={handleChange} />
                  <small id="register-monitored-by-hint">Enter an existing administrator's ID, or leave blank.</small>
                </div>
              )}
            </div>
          </fieldset>

          {isDonor && (
            <fieldset className="register-section" disabled={isLoading}>
              <legend>Donation details</legend>
              <div className="register-grid">
                <div className="register-field">
                  <label htmlFor="register-last-donation">Last Donation Date (optional)</label>
                  <input id="register-last-donation" name="last_donation" type="date" min={formData.date_of_birth || '1000-01-01'} max={today} value={formData.last_donation} onChange={handleChange} />
                </div>
                <div className="register-field">
                  <label htmlFor="register-availability">Availability</label>
                  <select id="register-availability" name="is_available" value={formData.is_available} onChange={handleChange}>
                    <option value="true">Available</option>
                    <option value="false">Not Available</option>
                  </select>
                </div>
              </div>
            </fieldset>
          )}

          <fieldset className="register-section" disabled={isLoading}>
            <legend>Account security</legend>
            <div className="register-grid">
              <div className="register-field">
                <label htmlFor="register-password">Password *</label>
                <input id="register-password" name="password" type="password" autoComplete="new-password" aria-describedby="register-password-hint" value={formData.password} onChange={handleChange} required />
                <small id="register-password-hint">At least 8 characters, excluding spaces at the beginning and end.</small>
              </div>
              <div className="register-field">
                <label htmlFor="register-confirm-password">Confirm Password *</label>
                <input id="register-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" value={formData.confirmPassword} onChange={handleChange} required />
              </div>
            </div>
          </fieldset>

          {error && <p className="register-message register-error" role="alert">{error}</p>}
          {success && (
            <div className="register-message register-success" role="status">
              <p>{success}</p>
              <Link to="/login">Go to Login</Link>
            </div>
          )}
          <button className="register-submit" type="submit" disabled={isLoading}>
            {isLoading ? 'Registering...' : 'Register'}
          </button>
        </form>

        <div className="register-footer">
          <p>Already have an account? <Link to="/login">Login</Link></p>
          <Link to="/">Back to Home</Link>
        </div>
      </section>
    </main>
  );
}

export default Register;
