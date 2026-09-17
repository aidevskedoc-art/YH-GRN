import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import { api } from './api/client.js';
import { BrandLockup } from './components/Brand.jsx';
import {
  IconActivity,
  IconBank,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconDepartment,
  IconLogout,
  IconMenu,
  IconMoon,
  IconPlus,
  IconReport,
  IconSheet,
  IconSliders,
  IconSun,
  IconUpload,
  IconUsers,
} from './components/icons.jsx';
import { useTheme, initials } from './theme.js';

const COLLAPSE_KEY = 'yh.grn.nav.collapsed';
const GROUP_KEY = 'yh.grn.nav.group';

/** The one dropdown every rail link sits under. */
const NAV_GROUP = 'GRN Reco';

/** Matches the drawer breakpoint in styles.css - keep the two in step. */
const NARROW = '(max-width: 940px)';

/**
 * Every entry the sidebar can show, and what an account must hold to see it.
 *
 * `screen` is a grant handed out on the user management screen; `adminOnly` is
 * the role. An entry with neither is shown to anyone signed in. The list is
 * filtered per account below rather than rendered whole and greyed out -- a
 * link to a screen you cannot open is not information, it is a dead end.
 */
const NAV = [
  { to: '/upload', label: 'New uploads', icon: IconUpload, end: true, screen: 'upload' },
  // end:false so /results/:batchId keeps the entry highlighted.
  { to: '/results', label: 'Results', icon: IconReport, end: false, badge: true, screen: 'results' },
    {
    to: '/accounts-department',
    label: 'Accounts',
    icon: IconBank,
    end: true,
    screen: 'accounts-department',
  },
  { to: '/csd', label: 'CS Department', icon: IconDepartment, end: true, screen: 'csd' },
  // The results screen's Accounts and PR-to-Bank views on their own. After
  // Results rather than beside it: an admin sees both, and the fuller screen
  // should come first for anyone who holds it.

  { to: '/config', label: 'Configuration', icon: IconSliders, end: true, screen: 'config' },
  // Every entry below is its own tick box on User management now -- deleting
  // an upload or file, and changing an administrator account, stay with the
  // administrator role on the server.
  { to: '/uploads', label: 'Uploaded files', icon: IconSheet, end: true, screen: 'uploads' },
  // `outside` keeps an entry out of the GRN Reco dropdown and standing on its
  // own below it. These two administer the tool rather than run a
  // reconciliation through it, so they are not what the group collects -- and
  // they are the two an administrator reaches for from any screen, which is a
  // poor fit for a panel that can be shut.
  { to: '/users', label: 'User management', icon: IconUsers, end: true, screen: 'users', outside: true },
  { to: '/logs', label: 'Activity logs', icon: IconActivity, end: true, screen: 'logs', outside: true },
];

/**
 * One link in the rail. The same in the dropdown and out of it -- an entry
 * should not look like a different kind of thing for having been moved.
 */
function RailLink({ item, collapsed }) {
  const { to, label, icon: Glyph, end } = item;
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
      title={collapsed ? label : undefined}
    >
      <Glyph size={18} />
      <span className="nav-label">{label}</span>
    </NavLink>
  );
}

/** Title and breadcrumb for the top bar, derived from the active route. */
function pageTitle(pathname) {
  // Tested before /upload, which is a prefix of it.
  if (pathname.startsWith('/uploads')) return { title: 'Uploaded files', crumb: 'Uploads / Files' };
  if (pathname.startsWith('/upload')) return { title: 'New reconciliation', crumb: 'Uploads / New' };
  if (pathname.startsWith('/results')) {
    return { title: 'Reconciliation results', crumb: 'Results / Pending vs accounts' };
  }
  if (pathname.startsWith('/csd')) return { title: 'CS Department', crumb: 'CSD / Handed over' };
  if (pathname.startsWith('/accounts-department')) {
    return { title: 'Accounts Department', crumb: 'Accounts / In accounts and ageing' };
  }
  if (pathname.startsWith('/users')) return { title: 'User management', crumb: 'Admin / Accounts' };
  if (pathname.startsWith('/logs')) return { title: 'Activity logs', crumb: 'Admin / Monitoring' };
  return { title: 'GRN Reconciliation', crumb: '' };
}

export default function AppShell() {
  const { user, logout, isAdmin, can } = useAuth();
  const { mode, toggle: toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [drawer, setDrawer] = useState(false);
  // The links' dropdown. Open on a first visit -- a rail that starts empty
  // gives a new account nothing to aim at -- and remembered after that.
  const [groupOpen, setGroupOpen] = useState(() => {
    try {
      return localStorage.getItem(GROUP_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [batchCount, setBatchCount] = useState(0);

  // Which layout is on screen decides what the nav toggle does and what it
  // reports to assistive tech, so it has to follow a resize, not just a reload.
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const sync = (e) => setNarrow(e.matches);
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* see theme.js - not worth failing over */
    }
  }, [collapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(GROUP_KEY, groupOpen ? '1' : '0');
    } catch {
      /* see theme.js - not worth failing over */
    }
  }, [groupOpen]);

  // Tapping a link on a phone should leave the drawer behind.
  useEffect(() => setDrawer(false), [location.pathname]);

  // The badge is re-read on navigation so it cannot go stale after an upload
  // adds a batch or the results page deletes one.
  useEffect(() => {
    let cancelled = false;
    api
      .listBatches()
      .then(({ batches }) => {
        if (!cancelled) setBatchCount(batches.length);
      })
      .catch(() => {
        // A failed count is not worth an error state in the chrome; the page
        // itself will surface whatever went wrong.
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  const handleSignOut = useCallback(() => {
    logout();
    navigate('/login', { replace: true });
  }, [logout, navigate]);

  /**
   * The collapse control lives in the rail itself, but only the docked layout
   * can host it: below the breakpoint the rail is an off-screen overlay, so a
   * button inside it could never be reached to open the drawer in the first
   * place. The narrow layout therefore keeps a hamburger in the top bar, and
   * exactly one of the two is rendered at a time - so neither is a duplicate
   * sitting in the tab order behind the other.
   */
  const railLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  const drawerLabel = drawer ? 'Close menu' : 'Open menu';
  const themeLabel = mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  /**
   * The icons-only rail hides every label, the dropdown's own included, so
   * there would be nothing left to click to get the links back. It therefore
   * forces the group open and drops the toggle (see the collapsed block in
   * styles.css) -- the remembered state is left untouched, and comes back the
   * moment the rail is expanded again. Scoped to the docked layout because
   * below the breakpoint the rail is a drawer and shows its labels regardless.
   */
  const railOnly = collapsed && !narrow;
  const navOpen = railOnly || groupOpen;
  const groupLabel = navOpen ? `Hide ${NAV_GROUP} links` : `Show ${NAV_GROUP} links`;

  const { title, crumb } = pageTitle(location.pathname);

  // What this account may actually open. Recomputed rather than memoised: it is
  // four comparisons over a list of four, and it has to follow a role change
  // taking effect on the next /me.
  const nav = NAV.filter((item) => {
    if (item.adminOnly) return isAdmin;
    if (item.screen) return can(item.screen);
    return true;
  });
  const grouped = nav.filter((item) => !item.outside);
  const loose = nav.filter((item) => item.outside);

  return (
    <div className={`app-shell${collapsed ? ' collapsed' : ''}${drawer ? ' drawer-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <BrandLockup size={30} onDark subtitle="GRN Reconciliation" showText={!collapsed} />
        </div>

        <nav className="sidenav">
          {/* Suppressed outright when the group would be empty, rather than
              left as a control that opens onto nothing: an account holding
              only the two screens below has no reconciliation links to show. */}
          {grouped.length > 0 && (
            <>
              {/* What was a caption over the links is now the control that
                  shows them, so it is a real button rather than a styled div:
                  it has to be reachable by keyboard and to say which state it
                  is in. */}
              <button
                type="button"
                className={`nav-group${navOpen ? ' is-open' : ''}`}
                onClick={() => setGroupOpen((v) => !v)}
                aria-expanded={navOpen}
                aria-controls="sidenav-links"
                title={groupLabel}
              >
                <span className="nav-group__label">{NAV_GROUP}</span>
                <IconChevronDown size={14} className="nav-group__caret" />
              </button>

              {/* Kept mounted and clipped rather than unmounted, so opening and
                  closing can be animated. `inert` is what keeps the closed
                  links out of the tab order and off the accessibility tree -
                  clipping alone would leave them both, invisible and still
                  focusable. */}
              <div className="nav-group__items" id="sidenav-links" inert={!navOpen || undefined}>
                <div className="nav-group__list">
                  {grouped.map((item) => (
                    <RailLink key={item.to} item={item} collapsed={collapsed} />
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Outside the dropdown, and below it: always on show, whether the
              group is open or shut. The rule above them is dropped when there
              is no group left to be separated from. */}
          {loose.length > 0 && (
            <div className={`sidenav__loose${grouped.length > 0 ? ' has-rule' : ''}`}>
              {loose.map((item) => (
                <RailLink key={item.to} item={item} collapsed={collapsed} />
              ))}
            </div>
          )}
        </nav>

        <div className="sidebar-foot">
          <div className="user-chip">
            <span className="avatar">{initials(user?.fullName || user?.username)}</span>
            <div className="user-meta">
              <div className="user-name">{user?.fullName || user?.username}</div>
              <div className="user-role">{isAdmin ? 'Administrator' : 'Standard user'}</div>
            </div>
            <button
              type="button"
              className="icon-btn-dark"
              onClick={handleSignOut}
              title="Sign out"
              aria-label="Sign out"
            >
              <IconLogout size={17} />
            </button>
          </div>
        </div>
      </aside>

      {/* A sibling of .sidebar rather than nested inside it: the rail is
          overflow:hidden to contain its own glow (see .sidebar::before in
          styles.css), which clipped the half of this button meant to poke
          past the rail's edge into the seam with the page. Sitting outside
          that box, it is positioned off .app-shell instead - see .rail-toggle. */}
      {!narrow && (
        <button
          type="button"
          className="rail-toggle"
          onClick={() => setCollapsed((v) => !v)}
          title={railLabel}
          aria-label={railLabel}
          aria-expanded={!collapsed}
        >
          {collapsed ? <IconChevronRight size={14} /> : <IconChevronLeft size={14} />}
        </button>
      )}

      {drawer && (
        <button type="button" className="scrim" aria-label="Close menu" onClick={() => setDrawer(false)} />
      )}

      <div className="app-main">
        <header className="topbar">
          {narrow && (
            <button
              type="button"
              className="icon-btn ghost nav-toggle"
              onClick={() => setDrawer((v) => !v)}
              title={drawerLabel}
              aria-label={drawerLabel}
              aria-expanded={drawer}
            >
              <IconMenu size={19} />
            </button>
          )}

          {/* Keyed by title so the heading re-mounts, and plays its entrance,
              when the route changes it. */}
          <div className="topbar-title" key={title}>
            <h1>{title}</h1>
            {crumb && <div className="crumb">{crumb}</div>}
          </div>

          <div className="topbar-actions">
            <button
              type="button"
              className="icon-btn ghost theme-toggle"
              onClick={toggleTheme}
              title={themeLabel}
              aria-label={themeLabel}
            >
              {mode === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
            </button>

            {/* Also gated on the grant, not just the current route: for an
                account without Uploads the button would land on a screen the
                router immediately redirects away from. */}
            {can('upload') && !location.pathname.startsWith('/upload') && (
              <button
                type="button"
                className="primary new-run"
                onClick={() => navigate('/upload')}
                // The label is hidden on narrow screens, so the accessible name
                // has to come from somewhere the glyph cannot.
                aria-label="New reconciliation"
                title="New reconciliation"
              >
                <IconPlus size={16} />
                <span className="btn-label">New reconciliation</span>
              </button>
            )}
          </div>
        </header>

        <main className="page">
          <div key={location.pathname} className="page-transition">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
