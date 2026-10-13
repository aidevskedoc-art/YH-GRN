import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from '../api/client.js';

const AuthContext = createContext(null);

/**
 * The CS Department screen's two queues, by the side whose CSD steps switch
 * hides each: the hospitals' behind `csd`, OP Pharmacy's behind `ph-csd` (see
 * CSD_GRANTS in services/screens.js).
 */
const CSD_QUEUE_SIDE = { csd: 'hospital', 'ph-csd': 'pharmacy' };

/** The same list twice, in content -- so a refresh that changed nothing keeps the old one. */
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  // The sides whose CSD steps are switched off, as the server says them with
  // the account: ['hospital'], ['pharmacy'], both, or none -- which is what it
  // says by saying nothing. See services/csdSteps.js on the server.
  const [csdOff, setCsdOff] = useState([]);
  // Which reading of the session is the latest -- see `refresh` below. Signing
  // in and signing out each start a new one, so an answer still on its way for
  // the session that was open before them is not taken up afterwards.
  const meRequest = useRef(0);

  const logout = useCallback(() => {
    meRequest.current += 1;
    setToken(null);
    setUser(null);
    setCsdOff([]);
  }, []);

  // A 401 from any request drops the session, so an expired token cannot leave
  // the UI showing a logged-in shell it can no longer populate.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  /**
   * Take the server's answer about the session: the account, and the switches.
   *
   * Each is kept as it was where it has not changed. A refresh is asked for
   * whenever the tab comes back into view, and nearly every one of them finds
   * nothing new -- handing out a fresh object each time would re-run every
   * effect keyed on the account for no reason.
   */
  const adopt = useCallback(({ user: me, csdStepsOff = [] }) => {
    setUser((old) => (sameJson(old, me) ? old : me));
    setCsdOff((old) => (sameJson(old, csdStepsOff) ? old : csdStepsOff));
  }, []);

  // Restore the session on load if a token is already stored.
  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    const mine = ++meRequest.current;
    api
      .me()
      .then((answer) => {
        if (mine === meRequest.current) adopt(answer);
      })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, [adopt]);

  const login = useCallback(
    async (username, password) => {
      const { token, ...session } = await api.login(username, password);
      // A reading of the session asked for before this sign-in is not this
      // account's, and must not land on top of it.
      meRequest.current += 1;
      setToken(token);
      adopt(session);
      return session.user;
    },
    [adopt],
  );

  /**
   * Ask again who this is and how the installation is set. For what can change
   * under a session that stays open: a CSD steps switch thrown on a
   * configuration screen -- this one's, or somebody else's.
   *
   * A failure is left alone. A 401 has already ended the session by the time
   * it gets here; anything else leaves what was known in place, which is the
   * best answer on hand.
   *
   * Only the latest request may answer. A configuration screen asks the moment
   * it has thrown a switch, and a request sent just before that -- the tab
   * coming back into view, say -- must not land after it and put the session
   * back to what was true a moment earlier. Nor may one land after Sign out,
   * and put back an account whose token has just been thrown away: signing
   * out and signing in each count as a later reading (see meRequest above).
   */
  const refresh = useCallback(() => {
    if (!getToken()) return Promise.resolve();
    const mine = ++meRequest.current;
    return api
      .me()
      .then((answer) => {
        if (mine === meRequest.current && getToken()) adopt(answer);
      })
      .catch(() => {});
  }, [adopt]);

  // A switch thrown while this tab sat in the background: caught when it is
  // looked at again, rather than at the next sign-in.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  /**
   * Is this account an administrator?
   *
   * The one role distinction the screens read directly: an admin manages
   * accounts and is the only role allowed to correct a date on the GRNS SPAN
   * tab. Everything else is decided per screen by `can` below.
   */
  const isAdmin = user?.role === 'ADMIN';

  /** Each side's CSD steps switch: `{ hospital, pharmacy }`, true while on. */
  const csdOn = useMemo(
    () => ({ hospital: !csdOff.includes('hospital'), pharmacy: !csdOff.includes('pharmacy') }),
    [csdOff],
  );

  /**
   * The screens this account can open now: the ones it was given, less a CS
   * Department queue whose side has its CSD steps switched off.
   *
   * That queue is where CSD record their stages, and with the steps off there
   * are none to record -- so it is left out here, in the one list everything
   * else reads. The sidebar's link, the route's guard, the queue picker on the
   * screen itself and the "where do I send this account instead" lookup all go
   * by `screens` and `can`, and all follow without knowing why. An account
   * holding nothing else lands on the no-access page rather than being sent
   * round to a screen that would send it back.
   *
   * The grant itself is untouched (`user.screens`, and User management): turn
   * the switch on again and the queue is back for everyone who held it.
   */
  const screens = useMemo(
    () => (user?.screens ?? []).filter((key) => !CSD_QUEUE_SIDE[key] || csdOn[CSD_QUEUE_SIDE[key]]),
    [user, csdOn],
  );

  /**
   * May this account open `screen`?
   *
   * Answered from the list the server resolved at sign-in, which already has an
   * admin holding every screen -- so this file has no rule of its own to keep in
   * step with the middleware's -- less the queues `screens` above leaves out.
   *
   * `screen` is one key, or a list of alternatives of which holding any one is
   * enough -- as requireScreen on the server reads several. The CS Department
   * screen is the case: one screen behind two grants, one for each queue.
   */
  const can = useCallback((screen) => [].concat(screen).some((key) => screens.includes(key)), [screens]);

  /**
   * What a data answer said of a side's switch, held against what the session
   * believes. A page reads the switch off its own rows (`csdStepsOff`), so it
   * is never wrong about them -- but the sidebar reads the session, and this is
   * how it hears that a switch was thrown while the tab stayed in front.
   *
   * One request for however many answers say so at once: a page's cards and
   * its rows are separate answers, and when one finds the session out of step
   * the other does too, in the same breath. The request already on its way
   * will bring what both were asking for.
   */
  const noting = useRef(false);
  const noteCsdSteps = useCallback(
    (side, on) => {
      if (csdOn[side] === on || noting.current) return;
      noting.current = true;
      refresh().finally(() => {
        noting.current = false;
      });
    },
    [csdOn, refresh],
  );

  const value = useMemo(
    () => ({ user, loading, login, logout, isAdmin, can, screens, csdOn, refresh, noteCsdSteps }),
    [user, loading, login, logout, isAdmin, can, screens, csdOn, refresh, noteCsdSteps],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider.');
  return ctx;
}
