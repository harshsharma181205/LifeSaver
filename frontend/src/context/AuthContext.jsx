import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  AUTH_STORAGE_KEY,
  clearAuthSession,
  getAuthExpiry,
  readAuthSession,
  saveAuthSession,
} from '../utils/authStorage.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => readAuthSession());

  const login = useCallback((value) => {
    const savedSession = saveAuthSession(value);
    setSession(savedSession);
    return savedSession;
  }, []);

  const logout = useCallback(() => {
    clearAuthSession();
    setSession(null);
  }, []);

  useEffect(() => {
    if (!session) return undefined;
    let timeoutId;
    function checkExpiry() {
      window.clearTimeout(timeoutId);
      const remaining = getAuthExpiry(session) - Date.now();
      if (remaining <= 0) {
        logout();
      } else {
        // Browser timers have a maximum delay, so long sessions are rechecked.
        timeoutId = window.setTimeout(checkExpiry, Math.min(remaining, 2147483647));
      }
    }
    checkExpiry();
    window.addEventListener('focus', checkExpiry);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener('focus', checkExpiry);
    };
  }, [session, logout]);

  useEffect(() => {
    function syncSession(event) {
      if (event.key === AUTH_STORAGE_KEY || event.key === null) {
        setSession(readAuthSession());
      }
    }
    window.addEventListener('storage', syncSession);
    return () => window.removeEventListener('storage', syncSession);
  }, []);

  return (
    <AuthContext.Provider value={{ session, isAuthenticated: Boolean(session), login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider.');
  return context;
}
