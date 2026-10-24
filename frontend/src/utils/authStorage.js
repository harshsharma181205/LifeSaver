export const AUTH_STORAGE_KEY = 'lifesaver_auth';

export class AuthStorageError extends Error {
  constructor() {
    super('Your browser could not save your login. Allow local storage and try again.');
    this.name = 'AuthStorageError';
  }
}

export class AuthSessionError extends Error {
  constructor() {
    super('The server returned an unexpected login response. Please try again.');
    this.name = 'AuthSessionError';
  }
}

function decodePayload(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Invalid token format.');
  }
  const segment = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, '=')));
}

// Decoding helps the UI track identity and expiry; only the backend verifies JWTs.
export function normalizeAuthSession(value, now = Date.now()) {
  try {
    const user = value?.user;
    if (!Number.isSafeInteger(user?.user_id) || user.user_id <= 0
      || !['donor', 'recipient', 'blood_bank', 'organization'].includes(user.user_type)) return null;
    const payload = decodePayload(value.token);
    if (!Number.isSafeInteger(payload?.exp) || payload.exp * 1000 <= now
      || payload.user_id !== user.user_id || payload.user_type !== user.user_type) return null;
    return { token: value.token, user: { user_id: user.user_id, user_type: user.user_type } };
  } catch {
    return null;
  }
}

export function getAuthExpiry(session) {
  try {
    return decodePayload(session.token).exp * 1000;
  } catch {
    return 0;
  }
}

export function clearAuthSession(storage) {
  try {
    (storage ?? globalThis.localStorage).removeItem(AUTH_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function readAuthSession(storage) {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(AUTH_STORAGE_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    const session = normalizeAuthSession(value);
    // Older or altered records must not leave extra personal data in storage.
    const minimal = value && Object.keys(value).length === 2
      && value.user && Object.keys(value.user).length === 2;
    if (!session || !minimal) {
      clearAuthSession(storage);
      return null;
    }
    return session;
  } catch {
    clearAuthSession(storage);
    return null;
  }
}

export function saveAuthSession(value, storage) {
  const session = normalizeAuthSession(value);
  if (!session) throw new AuthSessionError();
  try {
    (storage ?? globalThis.localStorage).setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  } catch {
    throw new AuthStorageError();
  }
  return session;
}
