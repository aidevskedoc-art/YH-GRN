import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  // A 401 from any request drops the session, so an expired token cannot leave
  // the UI showing a logged-in shell it can no longer populate.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  // Restore the session on load if a token is already stored.
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then(({ user: me }) => setUser(me))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username, password) => {
    const { token, user: me } = await api.login(username, password);
    setToken(token);
    setUser(me);
    return me;
  }, []);

  /**
   * Is this account an administrator?
   *
   * The one role distinction the screens read directly: an admin manages
   * accounts and is the only role allowed to correct a date on the GRNS SPAN
   * tab. Everything else is decided per screen by `can` below.
   */
  const isAdmin = user?.role === 'ADMIN';

  /**
   * May this account open `screen`?
   *
   * Answered from the list the server resolved at sign-in, which already has an
   * admin holding every screen -- so this file has no rule of its own to keep in
   * step with the middleware's.
   */
  const can = useCallback((screen) => (user?.screens ?? []).includes(screen), [user]);

  const value = useMemo(
    () => ({ user, loading, login, logout, isAdmin, can, screens: user?.screens ?? [] }),
    [user, loading, login, logout, isAdmin, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider.');
  return ctx;
}
