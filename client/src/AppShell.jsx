import { Fragment, useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import { BrandLockup } from './components/Brand.jsx';
import {
  IconActivity,
  IconBank,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCompare,
  IconDepartment,
  IconHospital,
  IconLogout,
  IconMenu,
  IconMoon,
  IconPharmacy,
  IconPlus,
  IconReport,
  IconSliders,
  IconSun,
  IconUpload,
  IconUsers,
  IconVendorCard,
} from './components/icons.jsx';
import {
  CSD_GRANTS,
  OP_PHARMACY_BASE,
  OP_PHARMACY_LABELS,
  OP_PHARMACY_SCREENS,
  PHARMACY_CSD_PATH,
  opPharmacyGrant,
  opPharmacyPath,
} from './services/screens.js';
import { useTheme, initials } from './theme.js';

const COLLAPSE_KEY = 'yh.grn.nav.collapsed';

/**
 * The rail's dropdowns, in the order they stand. Every link that is not
 * `outside` names one of these as its `group`.
 *
 * Each remembers whether it was left open under its own key. The GRN group
 * keeps the key it has always had, so nobody's choice is reset by the second
 * group arriving.
 *
 * A group may split its links into `subs`: sub-menus that open and shut on
 * their own inside it, each remembered the same way, which a link names as its
 * `sub`. GRN Reco is run for the hospitals and for OP Pharmacy over the same
 * screens, so it holds one for each. `startsShut` is the first-visit state
 * only -- the hospitals' is the one in daily use, and both open would double
 * the length of the rail. A link of the group that names no `sub` stands in
 * the dropdown itself, below the sub-menus: CS Department does.
 */
const NAV_GROUPS = [
  {
    key: 'grn',
    label: 'GRN Reco',
    storageKey: 'yh.grn.nav.group',
    subs: [
      { key: 'hospitals', label: 'Hospitals', icon: IconHospital, storageKey: 'yh.grn.nav.sub.hospitals' },
      {
        key: 'op-pharmacy',
        label: 'OP Pharmacy',
        icon: IconPharmacy,
        storageKey: 'yh.grn.nav.sub.op-pharmacy',
        startsShut: true,
      },
    ],
  },
  { key: 'msme', label: 'Vendor Reco', storageKey: 'yh.grn.nav.group.msme' },
];

/** Everything in the rail that opens and shuts: the dropdowns, and the sub-menus inside them. */
const NAV_PANELS = NAV_GROUPS.flatMap((g) => [g, ...(g.subs || [])]);

/** Open on a first visit -- a rail that starts empty gives a new account nothing to aim at. */
function readPanelOpen({ storageKey, startsShut = false }) {
  try {
    const stored = localStorage.getItem(storageKey);
    return stored === null ? !startsShut : stored !== '0';
  } catch {
    return !startsShut;
  }
}

/** Matches the drawer breakpoint in styles.css - keep the two in step. */
const NARROW = '(max-width: 940px)';

/**
 * The GRN screens, as the Hospitals sub-menu lists them. A list of its own
 * because the OP Pharmacy sub-menu is these same entries over again -- see NAV.
 */
const HOSPITAL_NAV = [
  { to: '/upload', label: 'New uploads', icon: IconUpload, end: true, screen: 'upload' },
  // end:false so /results/:batchId keeps the entry highlighted.
  { to: '/results', label: 'Results', icon: IconReport, end: false, badge: true, screen: 'results' },
  // The results screen's Accounts and PR-to-Bank views on their own. After
  // Results rather than beside it: an admin sees both, and the fuller screen
  // should come first for anyone who holds it.
  { to: '/accounts-department', label: 'Accounts', icon: IconBank, end: true, screen: 'accounts-department' },
  { to: '/config', label: 'Configuration', icon: IconSliders, end: true, screen: 'config' },
].map((item) => ({ ...item, group: 'grn', sub: 'hospitals' }));

/**
 * Every entry the sidebar can show, and what an account must hold to see it.
 *
 * `screen` is a grant handed out on the user management screen, or a list of
 * them of which any one is enough; `adminOnly` is the role. An entry with
 * neither is shown to anyone signed in. The list is
 * filtered per account below rather than rendered whole and greyed out -- a
 * link to a screen you cannot open is not information, it is a dead end.
 */
const NAV = [
  ...HOSPITAL_NAV,
  // OP Pharmacy: the hospital entries one for one, each at its address under
  // /op-pharmacy and behind its own grant (opPharmacyGrant), so an account can
  // be given a screen in one sub-menu without its twin in the other. Derived
  // rather than written out, so the two cannot drift apart -- all but the
  // label and the grant, which are OP Pharmacy's own (see OP_PHARMACY_LABELS
  // in services/screens.js).
  ...HOSPITAL_NAV.filter((item) => OP_PHARMACY_SCREENS.includes(item.screen)).map((item) => ({
    ...item,
    label: OP_PHARMACY_LABELS[item.screen],
    to: opPharmacyPath(item.screen),
    screen: opPharmacyGrant(item.screen),
    end: true,
    sub: 'op-pharmacy',
  })),
  // In GRN Reco itself, not in either sub-menu: no `sub`, so it stands in the
  // dropdown beside the two headings rather than under one of them, and there
  // is one of it rather than a copy in each. Shown to an account holding
  // either queue's grant; the screen offers only the queues held.
  { to: '/csd', label: 'CS Department', icon: IconDepartment, end: true, screen: CSD_GRANTS, group: 'grn' },
  // No Uploaded files entry: every GRN is shown once, from its latest upload,
  // so there are no uploads to manage one by one. Every entry below is its own
  // tick box on User management -- changing an administrator account stays
  // with the administrator role on the server.
  //
  // The Vendor Reco dropdown: neither screen reads a GRN report, and screens
  // for chasing vendor master data do not belong under a heading about GRNs.
  //
  // Every vendor the HIS vendor master -- the correct data -- has ever listed,
  // once each, with its latest details, first: it is the master the reco
  // below holds FOCUS to, and each reco fills it. Read-only.
  {
    to: '/vendor-master',
    label: 'Vendor Master',
    icon: IconVendorCard,
    end: true,
    screen: 'vendor-master',
    group: 'msme',
  },
  // The HIS vendor master against the Accounts vendor list.
  {
    to: '/msme-reco',
    label: 'HIS vs FOCUS Reco',
    icon: IconCompare,
    end: true,
    screen: 'msme-reco',
    group: 'msme',
  },
  // `outside` keeps an entry out of every dropdown and standing on its own
  // below them. These two administer the tool rather than run a
  // reconciliation through it, so they are not what the groups collect -- and
  // they are the two an administrator reaches for from any screen, which is a
  // poor fit for a panel that can be shut.
  { to: '/users', label: 'User management', icon: IconUsers, end: true, screen: 'users', outside: true },
  { to: '/logs', label: 'Activity logs', icon: IconActivity, end: true, screen: 'logs', outside: true },
];

/**
 * One link in the rail. The same in the dropdown and out of it -- an entry
 * should not look like a different kind of thing for having been moved.
 */
function RailLink({ item, collapsed, within }) {
  const { to, label, icon: Glyph, end } = item;
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
      // The icons-only rail shows two sub-menus' worth of the same glyphs, so
      // the tooltip says which sub-menu this one is in.
      title={collapsed ? (within ? `${within} / ${label}` : label) : undefined}
    >
      <Glyph size={18} />
      <span className="nav-label">{label}</span>
    </NavLink>
  );
}

/** Is `pathname` this entry's screen? The test NavLink applies to light it. */
function isCurrent({ to, end }, pathname) {
  return pathname === to || (!end && pathname.startsWith(`${to}/`));
}

/** Title and breadcrumb for the top bar, derived from the active route. */
function pageTitle(pathname) {
  // First: nothing below would claim these addresses, but it should not be
  // left to the order of the tests to say so.
  if (pathname.startsWith(OP_PHARMACY_BASE)) {
    const screen = OP_PHARMACY_SCREENS.find((key) => pathname === opPharmacyPath(key));
    return {
      title: 'OP Pharmacy',
      crumb: screen ? `GRN Reco / OP Pharmacy / ${OP_PHARMACY_LABELS[screen]}` : 'GRN Reco / OP Pharmacy',
    };
  }
  if (pathname.startsWith('/upload')) return { title: 'New reconciliation', crumb: 'Uploads / New' };
  if (pathname.startsWith('/results')) {
    return { title: 'Reconciliation results', crumb: 'Results / Pending vs accounts' };
  }
  if (pathname.startsWith('/csd')) return { title: 'CS Department', crumb: 'CSD / Handed over' };
  if (pathname.startsWith('/accounts-department')) {
    return { title: 'Accounts Department', crumb: 'Accounts / In accounts and ageing' };
  }
  if (pathname.startsWith('/vendor-master')) {
    return { title: 'Vendor Master', crumb: 'Vendor Reco / HIS vendor master' };
  }
  if (pathname.startsWith('/msme-reco')) {
    return { title: 'HIS vs FOCUS Reco', crumb: 'Vendor Reco / HIS vendor master vs FOCUS' };
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
  // Each dropdown's and sub-menu's open state, by its key -- remembered one by
  // one, so shutting one leaves the others as they were.
  const [panelOpen, setPanelOpen] = useState(() =>
    Object.fromEntries(NAV_PANELS.map((p) => [p.key, readPanelOpen(p)])),
  );
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);

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
      for (const p of NAV_PANELS) localStorage.setItem(p.storageKey, panelOpen[p.key] ? '1' : '0');
    } catch {
      /* see theme.js - not worth failing over */
    }
  }, [panelOpen]);

  // Arriving on a screen whose sub-menu is shut -- by the top bar's New
  // reconciliation button, a bookmark, a redirect -- opens it, so the rail
  // shows where you are. On arrival only: shutting it again while still on one
  // of its screens is left alone.
  useEffect(() => {
    const here = NAV.find((item) => item.sub && isCurrent(item, location.pathname));
    if (here) setPanelOpen((all) => (all[here.sub] ? all : { ...all, [here.sub]: true }));
  }, [location.pathname]);

  // Tapping a link on a phone should leave the drawer behind.
  useEffect(() => setDrawer(false), [location.pathname]);

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
   * The icons-only rail hides every label, the dropdowns' own included, so
   * there would be nothing left to click to get the links back. It therefore
   * forces every group open and drops the toggles (see the collapsed block in
   * styles.css) -- the remembered state is left untouched, and comes back the
   * moment the rail is expanded again. Scoped to the docked layout because
   * below the breakpoint the rail is a drawer and shows its labels regardless.
   *
   * The sub-menus are not forced: their headings carry an icon, which the
   * icons-only rail keeps, so each can still be opened and shut from there.
   */
  const railOnly = collapsed && !narrow;

  const { title, crumb } = pageTitle(location.pathname);

  // What this account may actually open. Recomputed rather than memoised: it is
  // a handful of comparisons over a short list, and it has to follow a role
  // change taking effect on the next /me.
  const nav = NAV.filter((item) => {
    if (item.adminOnly) return isAdmin;
    if (item.screen) return can(item.screen);
    return true;
  })
    // CS Department's link opens on the hospitals' queue. An account holding
    // only OP Pharmacy's is given that queue's own address instead, so the
    // link is where the screen rests: pressed again from the queue it goes
    // nowhere, rather than to /csd and back with the page's filters lost.
    .map((item) => (item.screen === CSD_GRANTS && !can('csd') ? { ...item, to: PHARMACY_CSD_PATH } : item));
  // A group this account holds nothing in is left out entirely, rather than
  // drawn as a control that opens onto nothing -- and a sub-menu likewise.
  const groups = NAV_GROUPS.map((g) => {
    const held = nav.filter((item) => !item.outside && item.group === g.key);
    return {
      ...g,
      items: held.filter((item) => !item.sub),
      subs: (g.subs || [])
        .map((s) => ({
          ...s,
          items: held.filter((item) => item.sub === s.key),
          open: Boolean(panelOpen[s.key]),
        }))
        .filter((s) => s.items.length > 0),
      open: railOnly || Boolean(panelOpen[g.key]),
    };
  }).filter((g) => g.items.length + g.subs.length > 0);
  const loose = nav.filter((item) => item.outside);

  return (
    <div className={`app-shell${collapsed ? ' collapsed' : ''}${drawer ? ' drawer-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <BrandLockup size={30} onDark subtitle="GRN Reconciliation" showText={!collapsed} />
        </div>

        <nav className="sidenav">
          {groups.map((g) => (
            <Fragment key={g.key}>
              {/* The caption over a group's links is the control that shows
                  them, so it is a real button rather than a styled div: it has
                  to be reachable by keyboard and to say which state it is in. */}
              <button
                type="button"
                className={`nav-group${g.open ? ' is-open' : ''}`}
                onClick={() => setPanelOpen((all) => ({ ...all, [g.key]: !all[g.key] }))}
                aria-expanded={g.open}
                aria-controls={`sidenav-links-${g.key}`}
                title={g.open ? `Hide ${g.label} links` : `Show ${g.label} links`}
              >
                <span className="nav-group__label">{g.label}</span>
                <IconChevronDown size={14} className="nav-group__caret" />
              </button>

              {/* Kept mounted and clipped rather than unmounted, so opening and
                  closing can be animated. `inert` is what keeps the closed
                  links out of the tab order and off the accessibility tree -
                  clipping alone would leave them both, invisible and still
                  focusable. */}
              <div className="nav-group__items" id={`sidenav-links-${g.key}`} inert={!g.open || undefined}>
                <div className="nav-group__list">
                  {/* The group's sub-menus: the same heading-over-a-clipped-list
                      as the group itself, one level down. */}
                  {g.subs.map((s) => {
                    const Glyph = s.icon;
                    // Lit while one of its screens is open, so the rail still
                    // says which sub-menu you are in when it has been shut.
                    const holdsCurrent = s.items.some((item) => isCurrent(item, location.pathname));
                    return (
                      <Fragment key={s.key}>
                        <button
                          type="button"
                          className={`nav-sub${s.open ? ' is-open' : ''}${holdsCurrent ? ' is-current' : ''}`}
                          onClick={() => setPanelOpen((all) => ({ ...all, [s.key]: !all[s.key] }))}
                          aria-expanded={s.open}
                          aria-controls={`sidenav-links-${s.key}`}
                          title={s.open ? `Hide ${s.label} links` : `Show ${s.label} links`}
                        >
                          <Glyph size={18} />
                          <span className="nav-sub__label">{s.label}</span>
                          <IconChevronDown size={14} className="nav-sub__caret" />
                        </button>

                        <div className="nav-sub__items" id={`sidenav-links-${s.key}`} inert={!s.open || undefined}>
                          <div className="nav-sub__list">
                            {s.items.map((item) => (
                              <RailLink key={item.to} item={item} collapsed={collapsed} within={s.label} />
                            ))}
                          </div>
                        </div>
                      </Fragment>
                    );
                  })}

                  {/* The links that are the group's own, in no sub-menu. After
                      the sub-menus, so they read as the rows that follow the two
                      headings rather than as a first item above them. */}
                  {g.items.map((item) => (
                    <RailLink key={item.to} item={item} collapsed={collapsed} />
                  ))}
                </div>
              </div>
            </Fragment>
          ))}

          {/* Outside the dropdowns, and below them: always on show, whether
              the groups are open or shut. The rule above them is dropped when
              there is no group left to be separated from. */}
          {loose.length > 0 && (
            <div className={`sidenav__loose${groups.length > 0 ? ' has-rule' : ''}`}>
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
                router immediately redirects away from. Not on the Vendor Reco
                screens either: it is a GRN reconciliation this starts, and
                the vendor files go in through HIS vs FOCUS Reco's New reco.
                Nor on OP Pharmacy's: the upload it opens is the hospitals'. */}
            {can('upload') &&
              !location.pathname.startsWith('/upload') &&
              !location.pathname.startsWith(OP_PHARMACY_BASE) &&
              !location.pathname.startsWith('/vendor-master') &&
              !location.pathname.startsWith('/msme-reco') && (
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
