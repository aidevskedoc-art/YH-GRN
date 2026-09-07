import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { firstScreenPath } from '../services/screens.js';

/**
 * The gate in front of every signed-in route.
 *
 * Three things in order, and the order matters. An unresolved session waits --
 * deciding early would bounce a signed-in user to the login screen on every
 * reload. A missing session goes to the login screen, remembering where it was
 * headed. And a session without the access this route asks for is redirected to
 * a screen it does have, rather than shown an error: an account that was never
 * given Uploads has not done anything wrong by following a bookmark there.
 *
 * `screen` names a grant (upload, results, csd); `adminOnly` asks for the role.
 * Neither is a security boundary on its own -- the API refuses the same
 * requests -- this only keeps the browser from showing a screen it cannot fill.
 */
export default function ProtectedRoute({ children, screen, adminOnly = false }) {
  const { user, loading, isAdmin, can, screens } = useAuth();
  const location = useLocation();

  // Wait for the stored token to be validated before deciding, otherwise a
  // reload would bounce a signed-in user to the login screen.
  if (loading) {
    return <div className="loading">Loading…</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (adminOnly && !isAdmin) {
    return <Navigate to={firstScreenPath(screens)} replace />;
  }

  if (screen && !can(screen)) {
    return <Navigate to={firstScreenPath(screens)} replace />;
  }

  return children;
}
