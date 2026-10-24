import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_STORAGE_KEY, AuthSessionError, AuthStorageError, clearAuthSession,
  getAuthExpiry, normalizeAuthSession, readAuthSession, saveAuthSession,
} from '../src/utils/authStorage.js';

function mockToken(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.dGVzdC1zaWduYXR1cmU`;
}

function mockSession(userType = 'donor', expiresAt = Math.floor(Date.now() / 1000) + 3600) {
  const user = { user_id: 12, user_type: userType };
  return { token: mockToken({ ...user, iat: expiresAt - 3600, exp: expiresAt }), user };
}

function memoryStorage() {
  const records = new Map();
  return {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, String(value)),
    removeItem: (key) => records.delete(key),
  };
}

for (const userType of ['donor', 'recipient', 'blood_bank', 'organization']) {
  test(`${userType} session survives storage reload`, () => {
    const storage = memoryStorage();
    const session = mockSession(userType);
    assert.deepEqual(saveAuthSession(session, storage), session);
    assert.deepEqual(readAuthSession(storage), session);
    assert.equal(getAuthExpiry(session), JSON.parse(Buffer.from(session.token.split('.')[1], 'base64url').toString()).exp * 1000);
  });
}

test('saving explicitly omits personal fields and passwords', () => {
  const storage = memoryStorage();
  const session = mockSession();
  saveAuthSession({
    ...session, password: 'never-store-this',
    user: { ...session.user, name: 'Transient Name', phone: '1234567890', password: 'private-password', password_hash: 'private-hash' },
  }, storage);
  const saved = storage.getItem(AUTH_STORAGE_KEY);
  assert.deepEqual(JSON.parse(saved), session);
  for (const forbidden of ['name', 'phone', 'password', 'password_hash', 'never-store-this', 'private-hash']) {
    assert.equal(saved.includes(forbidden), false);
  }
});

test('token identity must match the stored donor or recipient identity', () => {
  const session = mockSession();
  assert.equal(normalizeAuthSession({ ...session, user: { ...session.user, user_type: 'recipient' } }), null);
  assert.equal(normalizeAuthSession({ ...session, user: { ...session.user, user_id: 13 } }), null);
  for (const userId of [0, -1, '12', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeAuthSession({ ...session, user: { ...session.user, user_id: userId } }), null);
  }
  assert.equal(normalizeAuthSession({ ...session, user: { ...session.user, user_type: 'admin' } }), null);
});

test('malformed tokens and missing or invalid expiration cannot create a session', () => {
  const session = mockSession();
  for (const token of [undefined, '', 'not-a-jwt', 'a.b.c', '.payload.signature', `${session.token}.extra`]) {
    assert.equal(normalizeAuthSession({ ...session, token }), null);
  }
  for (const exp of [undefined, null, '3600', 1.5]) {
    assert.equal(normalizeAuthSession({ ...session, token: mockToken({ ...session.user, exp }) }), null);
  }
  assert.equal(getAuthExpiry(null), 0);
});

test('session expires exactly at the JWT expiration time', () => {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const session = mockSession('donor', expiry);
  assert.deepEqual(normalizeAuthSession(session, expiry * 1000 - 1), session);
  assert.equal(normalizeAuthSession(session, expiry * 1000), null);
  assert.equal(normalizeAuthSession(session, expiry * 1000 + 1), null);
});

test('corrupt, expired and nonminimal records are removed safely', () => {
  const session = mockSession();
  const records = [
    '{broken JSON', 'null', '{}',
    JSON.stringify(mockSession('donor', Math.floor(Date.now() / 1000) - 1)),
    JSON.stringify({ ...session, password: 'private-password' }),
    JSON.stringify({ ...session, user: { ...session.user, phone: '1234567890' } }),
  ];
  for (const raw of records) {
    const storage = memoryStorage();
    storage.setItem(AUTH_STORAGE_KEY, raw);
    assert.equal(readAuthSession(storage), null);
    assert.equal(storage.getItem(AUTH_STORAGE_KEY), null);
  }
  assert.equal(readAuthSession(memoryStorage()), null);
});

test('invalid responses never overwrite an existing valid session', () => {
  const storage = memoryStorage();
  const session = mockSession();
  saveAuthSession(session, storage);
  assert.throws(() => saveAuthSession({ ...session, token: undefined }, storage), AuthSessionError);
  assert.throws(() => saveAuthSession(mockSession('recipient', 1), storage), AuthSessionError);
  assert.deepEqual(readAuthSession(storage), session);
});

test('storage write failures return a specific safe error', () => {
  const storage = memoryStorage();
  const session = mockSession();
  saveAuthSession(session, storage);
  const fullStorage = { ...storage, setItem() { throw new Error('Internal quota details.'); } };
  assert.throws(() => saveAuthSession(mockSession('recipient'), fullStorage), (error) => {
    assert.equal(error instanceof AuthStorageError, true);
    assert.match(error.message, /could not save your login/);
    assert.equal(error.message.includes('Internal quota details'), false);
    return true;
  });
  assert.deepEqual(readAuthSession(storage), session);
});

test('unavailable storage reads and cleanup cannot crash the app', () => {
  const blockedStorage = {
    getItem() { throw new Error('Blocked.'); },
    removeItem() { throw new Error('Blocked.'); },
  };
  assert.equal(readAuthSession(blockedStorage), null);
  assert.equal(clearAuthSession(blockedStorage), false);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Blocked.'); } });
  try {
    assert.equal(readAuthSession(), null);
    assert.equal(clearAuthSession(), false);
    assert.throws(() => saveAuthSession(mockSession()), AuthStorageError);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

test('clearing a session removes only the authentication key', () => {
  const storage = memoryStorage();
  saveAuthSession(mockSession(), storage);
  storage.setItem('unrelated_preference', 'kept');
  assert.equal(clearAuthSession(storage), true);
  assert.equal(storage.getItem(AUTH_STORAGE_KEY), null);
  assert.equal(storage.getItem('unrelated_preference'), 'kept');
});

test('blood bank identity omits contact information and rejects role mismatch', () => {
  const storage = memoryStorage();
  const session = mockSession('blood_bank');
  saveAuthSession({ ...session, user: { ...session.user, bank_name: 'Central', email: 'private@example.test', address: 'Pune', password_hash: 'private' } }, storage);
  assert.deepEqual(readAuthSession(storage), session);
  assert.equal(normalizeAuthSession({ ...session, user: { ...session.user, user_type: 'donor' } }), null);
});

test('organization identity persists without provider contacts, type or password fields', () => {
  const storage = memoryStorage();
  const session = mockSession('organization');
  saveAuthSession({ ...session, user: { ...session.user, organization_type: 'Hospital', bank_id: 3, email: 'private@example.test', password_hash: 'private' } }, storage);
  assert.deepEqual(readAuthSession(storage), session);
  assert.equal(normalizeAuthSession({ ...session, user: { ...session.user, user_type: 'blood_bank' } }), null);
});
