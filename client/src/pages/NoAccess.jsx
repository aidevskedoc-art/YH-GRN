import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { BrandLockup } from '../components/Brand.jsx';
import { firstScreenPath } from '../services/screens.js';

/** How often an account waiting on a switched-off queue asks whether it is back. */
const QUEUE_CHECK_MS = 60_000;

/**
 * Where an account with no screens at all lands.
 *
 * It should be rare -- the users API refuses to leave an active standard user
 * with nothing ticked -- but "signed in and nowhere to go" is a state the app
 * can reach (an account demoted from administrator, say), and bouncing between
 * guarded routes forever is not an acceptable way to express it.
 *
 * Deliberately outside the shell: the sidebar is built from the screens this
 * account holds, and there are none, so there is no navigation to draw.
 *
 * One other way here: an account given only a CS Department queue, while that
 * side's CSD steps are switched off in Configuration. The queue is hidden then
 * (see `screens` in AuthContext), so it has been given something and can open
 * nothing -- and saying "not given access to any screen" would send it to an
 * administrator to ask for what it already has.
 *
 * That account is only waiting, so this page is not where it stays. While it
 * waits the session is asked again every minute, and the moment the session
 * holds a screen it can open -- the switch thrown back on, or a screen ticked
 * for it -- it is sent there. Without that the page would go on saying the
 * queue was off after it had come back, or worse, flip to "no screens yet" for
 * an account that has one.
 */
export default function NoAccess() {
  const { user, logout, screens, refresh } = useAuth();
  const navigate = useNavigate();
  // Granted something, and none of it open: only a switched-off queue does that.
  const granted = user?.screens ?? [];
  const queueSwitchedOff = screens.length === 0 && granted.length > 0;
  // The screen each queue's switch is on, so the account is pointed at the one
  // that hid its own queue -- the hospitals' and OP Pharmacy's are different.
  const switchedOffOn = [
    granted.includes('csd') && 'Configuration',
    granted.includes('ph-csd') && 'Ph-Configuration',
  ]
    .filter(Boolean)
    .join(' and ');

  useEffect(() => {
    if (!queueSwitchedOff) return undefined;
    const timer = setInterval(refresh, QUEUE_CHECK_MS);
    return () => clearInterval(timer);
  }, [queueSwitchedOff, refresh]);

  // Somewhere to go after all. firstScreenPath only answers /no-access for an
  // empty list, so this cannot send the account back here.
  if (user && screens.length > 0) {
    return <Navigate to={firstScreenPath(screens)} replace />;
  }

  return (
    <div className="login">
      <div className="login__panel noaccess">
        <div className="login__brand">
          <BrandLockup size={34} onDark />
        </div>
        <h1 className="login__title">{queueSwitchedOff ? 'CSD queue switched off' : 'No screens yet'}</h1>
        {queueSwitchedOff ? (
          <p className="login__subtitle">
            You are signed in as <strong>{user?.fullName || user?.username}</strong>. This account
            opens the CS Department queue, and the CSD steps are switched off in{' '}
            {switchedOffOn || 'Configuration'}, so there is no queue to work at present. It comes
            back when they are switched on again.
          </p>
        ) : (
          <p className="login__subtitle">
            You are signed in as <strong>{user?.fullName || user?.username}</strong>, but this account
            has not been given access to any screen. Ask an administrator to open the user management
            screen and tick the ones you need.
          </p>
        )}
        <button
          type="button"
          className="primary btn--block"
          onClick={() => {
            logout();
            navigate('/login', { replace: true });
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
