import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { BrandLockup } from '../components/Brand.jsx';

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
 */
export default function NoAccess() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="login">
      <div className="login__panel noaccess">
        <div className="login__brand">
          <BrandLockup size={34} onDark />
        </div>
        <h1 className="login__title">No screens yet</h1>
        <p className="login__subtitle">
          You are signed in as <strong>{user?.fullName || user?.username}</strong>, but this account
          has not been given access to any screen. Ask an administrator to open the user management
          screen and tick the ones you need.
        </p>
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
