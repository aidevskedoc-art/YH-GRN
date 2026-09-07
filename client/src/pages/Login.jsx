import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { LogoMark } from '../components/Brand.jsx';

/**
 * The stage: a glass cube turning above a cast-concrete plinth, lit by the
 * brand orange. It is built in real 3D (see "Three-dimensional pieces" in
 * styles.css) rather than drawn, so the perspective is the browser's and the
 * object holds together at any scene angle.
 *
 * Every face is rendered, including the ones currently facing away: the cube's
 * are translucent and are seen THROUGH the near faces, and the plinth's cost
 * nothing to keep and mean the block stays solid if the scene angle is ever
 * retuned. It carries no information, so it is hidden from assistive tech and
 * dropped entirely below the login breakpoint.
 */
function Stage() {
  return (
    <div className="stage" aria-hidden="true">
      <div className="stage__glow" />

      <div className="plinth box3d">
        <div className="ped__face ped__face--back" />
        <div className="ped__face ped__face--left" >
          
          <LogoMark size={100} />
        </div>
        <div className="ped__face ped__face--right" />
        <div className="ped__face ped__face--bottom" />
        <div className="ped__face ped__face--top">
          <span className="ped__shadow" />
        </div>
        <div className="ped__face ped__face--front" >Yashoda Hospitals</div>
      </div>

      <div className="lift">
        <div className="cube">
          <span className="cube__face cube__face--back" />
          <span className="cube__face cube__face--left" />
          <span className="cube__face cube__face--right" />
          <span className="cube__face cube__face--top" />
          <span className="cube__face cube__face--bottom" />
          <span className="cube__face cube__face--front" />
        </div>

        {/* The hospital mark, suspended at the centre of the box. It is a
            SIBLING of the cube rather than a child, so it does not tumble with
            it: the glass turns around a mark that stays square to the viewer,
            which is the only way the emblem is legible at every point in the
            rotation. Sitting at z=0 in the same preserve-3d space, the browser
            sorts it between the far faces and the near ones, so the near glass
            genuinely passes in front of it. */}
        <div className="cube__mark">
          <span className="cube__core" />
          <LogoMark size={66} className="cube__emblem" />
        </div>
      </div>
    </div>
  );
}

export default function Login() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (loading) return <div className="loading">Loading…</div>;
  if (user) return <Navigate to={location.state?.from || '/results'} replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await login(username, password);
      navigate(location.state?.from || '/results', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login">
      <div className="login__inner">
        <div className="login__aside">
          <Stage />
          <div className="login__pitch">
            <h2>
              Know where every bill <span className="accent">is stuck</span>.
            </h2>
            <p>
              Match the month&apos;s GRN report against vendor ageing to see what has not reached
              accounts — and how long each one waited at every step from indent to cheque.
            </p>
          </div>
        </div>

        <form className="login__panel" onSubmit={handleSubmit}>
          <div className="login__brand">
            <LogoMark size={52} />
          </div>
          <h1 className="login__title">GRN Reconciliation</h1>
          <p className="login__subtitle">Yashoda Healthcare Services</p>

          <label className="field">
            <span className="field__label">Username</span>
            <input
              className="field__input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </label>

          <label className="field">
            <span className="field__label">Password</span>
            <input
              className="field__input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>

          {error && <div className="alert alert--error">{error}</div>}

          <button className="primary btn--block" type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
