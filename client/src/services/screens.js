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
  uploads: '/uploads',
  // After the GRN screens, as it is in the sidebar: an account holding both
  // lands on a GRN screen, and one holding only this lands here.
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
  uploads: 'Uploaded files',
  'msme-reco': 'HIS vs FOCUS Reco',
  users: 'User management',
  logs: 'Activity logs',
};

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
