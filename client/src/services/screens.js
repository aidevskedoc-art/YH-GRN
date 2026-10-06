/**
 * What each screen key means to the browser.
 *
 * The server owns the catalogue -- config/screens.js there is what the users
 * API validates against, and it sends the list down with GET /api/users so the
 * form is never built from a stale copy. What it cannot send is the route and
 * the icon, which are client concerns; that is all this file adds.
 *
 * Keyed on the same strings the server uses, so the navigation an account sees
 * and the requests it is allowed to make are decided by one list, not two.
 */
export const SCREEN_ROUTES = {
  upload: '/upload',
  results: '/results',
  csd: '/csd',
  // The results screen's Accounts and PR-to-Bank views, and nothing else --
  // see pages/AccountsDepartment.jsx. Listed after `results` so an account holding
  // both lands on the fuller screen, which is the superset of this one.
  'accounts-department': '/accounts-department',
  config: '/config',
  // After the GRN screens, as they are in the sidebar: an account holding both
  // lands on a GRN screen, and one holding only these lands here.
  'vendor-master': '/vendor-master',
  'msme-reco': '/msme-reco',
  logs: '/logs',
  users: '/users',
};

/** Fallback labels, for the nav -- the users screen prefers the server's. */
export const SCREEN_LABELS = {
  upload: 'New uploads',
  results: 'Results',
  'accounts-department': 'Accounts Department',
  csd: 'CS Department',
  config: 'Configuration',
  'vendor-master': 'Vendor Master',
  'msme-reco': 'HIS vs FOCUS Reco',
  users: 'User management',
  logs: 'Activity logs',
};

/**
 * OP Pharmacy's copy of the GRN screens.
 *
 * The GRN Reco dropdown is split into two sub-menus, Hospitals and OP
 * Pharmacy, and the second repeats the first screen for screen: each one at
 * the hospital screen's address under /op-pharmacy, behind the same grant.
 * One list, read by the router and the sidebar both, so a link cannot be drawn
 * for an address the router does not know.
 *
 * CS Department is in neither: it is a link of the GRN Reco dropdown itself,
 * so there is one of it and no OP Pharmacy twin.
 *
 * Deliberately not in SCREEN_ROUTES: that is the list an account is forwarded
 * through when it lands somewhere it may not go, and it should arrive on a
 * hospital screen, not on its OP Pharmacy twin.
 */
export const OP_PHARMACY_BASE = '/op-pharmacy';

/**
 * What each OP Pharmacy screen is called -- in the sidebar, in the top bar's
 * breadcrumb and on the screen itself. Its own names rather than the hospital
 * screens': two links both reading "Results" are told apart only by the
 * heading above them, which the icons-only rail does not show.
 *
 * Keyed on the hospital screen each is the twin of, and the list of OP
 * Pharmacy screens is read off these keys -- so adding a name here is what
 * adds the screen, and a screen cannot be left without one.
 */
export const OP_PHARMACY_LABELS = {
  upload: 'Pharmacy Uploads',
  results: 'Pharmacy Results',
  'accounts-department': 'Ph-Accounts',
  config: 'Ph-Configuration',
};
export const OP_PHARMACY_SCREENS = Object.keys(OP_PHARMACY_LABELS);

export function opPharmacyPath(screen) {
  return `${OP_PHARMACY_BASE}${SCREEN_ROUTES[screen]}`;
}

/**
 * Where to send an account that has landed somewhere it may not go.
 *
 * The first screen it does have, in the order above; `/login` when it has none,
 * which is the honest destination for an account nobody has ticked anything for
 * yet -- there is no page it could usefully be shown.
 */
export function firstScreenPath(screens = []) {
  const found = Object.keys(SCREEN_ROUTES).find((key) => screens.includes(key));
  return found ? SCREEN_ROUTES[found] : '/no-access';
}
