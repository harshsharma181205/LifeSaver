import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { API_BASE_URL } from '../config/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { AuthSessionError, AuthStorageError, readAuthSession } from '../utils/authStorage.js';
import '../styles/login.css';

function Login() {
  const { login, session } = useAuth();
  const navigate = useNavigate();
  const [loginType, setLoginType] = useState('donor');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const isSubmitting = useRef(false);
  const requestController = useRef(null);
  const previousSessionToken = useRef(session?.token);
  const isOrganization = loginType === 'organization';

  useEffect(() => () => requestController.current?.abort(), []);
  useEffect(() => {
    if (previousSessionToken.current === session?.token) return;
    previousSessionToken.current = session?.token;
    requestController.current?.abort();
    requestController.current = null;
    isSubmitting.current = false;
    setIsLoading(false);
    setPassword('');
    setError('');
  }, [session?.token]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (isSubmitting.current) return;
    setError('');
    const value = identifier.trim();
    if (!value || !password.trim()) {
      setError('Please enter your phone number or email and password.');
      return;
    }
    const isEmail = value.includes('@');
    if (isEmail ? (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 100)
      : (!/^\+?\d{10,15}$/.test(value) || value.length > 15)) {
      setError('Enter a valid email or 10-15 phone digits (+ optional, 15 characters maximum).');
      return;
    }
    isSubmitting.current = true;
    setIsLoading(true);
    const initiatingToken = session?.token ?? null;
    const controller = new AbortController();
    requestController.current = controller;
    try {
      const response = await axios.post(API_BASE_URL + '/api/auth/' + loginType + '/login',
        { identifier: value, password },
        { timeout: 15000, signal: controller.signal });
      if (controller.signal.aborted || (readAuthSession()?.token ?? null) !== initiatingToken) return;
      const account = isOrganization ? response.data?.user : response.data?.[loginType];
      const name = account?.name;
      if (typeof name !== 'string' || !name.trim()
        || (isOrganization && account?.user_type !== loginType)) {
        setError('The server returned an unexpected login response. Please try again.');
        return;
      }
      login({
        token: response.data?.token,
        user: { user_id: isOrganization ? account?.user_id : account?.[loginType + '_id'],
          user_type: isOrganization ? account?.user_type : loginType },
      });
      const paths = { donor: '/donor/dashboard', recipient: '/recipient/dashboard',
        organization: '/organization/dashboard' };
      navigate(paths[loginType], { replace: true });
    } catch (requestError) {
      if (controller.signal.aborted || axios.isCancel(requestError)
        || (readAuthSession()?.token ?? null) !== initiatingToken) return;
      const status = requestError.response?.status;
      if (requestError instanceof AuthStorageError || requestError instanceof AuthSessionError) {
        setError(requestError.message);
      } else if (status === 401) {
        setError('Incorrect phone number, email or password. Please try again.');
      } else if (status === 400) {
        setError('Please check your phone number or email and password, then try again.');
      } else if (status === 403) {
        setError('Your account does not have access to this login.');
      } else if (status === 404) {
        setError('This login service is currently unavailable.');
      } else if (status === 409) {
        setError('This identifier matches more than one account. Please use your other identifier.');
      } else if (status >= 500) {
        setError('The server could not complete your login. Please try again later.');
      } else if (axios.isAxiosError(requestError) && !requestError.response) {
        setError('Unable to reach the backend. Check that it is running and your connection is available, then try again.');
      } else {
        setError('Unable to log in. Please try again.');
      }
    } finally {
      if (requestController.current === controller) {
        requestController.current = null;
        isSubmitting.current = false;
        if (!controller.signal.aborted) {
          setPassword('');
          setIsLoading(false);
        }
      }
    }
  }

  const inputId = isOrganization ? 'login-identifier' : 'login-phone';
  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-heading">
          <p className="eyebrow">Welcome back</p>
          <h1 id="login-title">LifeSaver</h1>
          <p className="login-subtitle">Blood Donation Management System</p>
          <p className="login-intro">Log in to your donor, recipient or organization account.</p>
        </div>
        <form className="login-form" onSubmit={handleSubmit} noValidate aria-busy={isLoading}>
          <div className="login-field">
            <label htmlFor="login-type">Login as</label>
            <select id="login-type" value={loginType} disabled={isLoading}
              onChange={event => { setLoginType(event.target.value); setIdentifier(''); setPassword(''); setError(''); }}>
              <option value="donor">Donor</option>
              <option value="recipient">Recipient</option>
              <option value="organization">Organization</option>
            </select>
          </div>
          <div className="login-field">
            <label htmlFor={inputId}>Phone or Email</label>
            <input id={inputId} name="identifier" type="text" autoComplete="username"
              placeholder="Enter your phone number or email"
              aria-describedby="login-identifier-hint" value={identifier} disabled={isLoading} required maxLength={100}
              onChange={event => { setIdentifier(event.target.value); setError(''); }} />
            <small id="login-identifier-hint">{isOrganization
              ? 'For Hospital, Blood Bank and NGO accounts, use your registered phone number or email.'
              : 'Use the phone number or email registered for this account type.'}</small>
          </div>
          <div className="login-field">
            <label htmlFor="login-password">Password</label>
            <input id="login-password" name="password" type="password" autoComplete="current-password"
              placeholder="Enter your password" value={password} disabled={isLoading} required
              onChange={event => { setPassword(event.target.value); setError(''); }} />
          </div>
          {error && <p className="login-message login-error" role="alert">{error}</p>}
          <button className="login-submit" type="submit" disabled={isLoading}>{isLoading ? 'Logging in...' : 'Login'}</button>
        </form>
        <div className="login-footer">
          <p>New to LifeSaver?</p>
          <Link className="login-register" to="/register">Register</Link>
          <Link className="login-home-link" to="/">Back to Home</Link>
        </div>
      </section>
    </main>
  );
}
export default Login;
