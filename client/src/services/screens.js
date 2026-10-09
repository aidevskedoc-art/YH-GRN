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
  // The screen's own name, as the nav has it. On User management its two
  // queues are a tick box each -- Hospital CSD and OP Pharmacy CSD.
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
 * the hospital screen's address under /op-pharmacy, behind a grant of its own
 * (opPharmacyGrant below). One list, read by the router and the sidebar both,
 * so a link cannot be drawn for an address the router does not know.
 *
 * CS Department is in neither: it is a link of the GRN Reco dropdown itself,
 * so there is one of it and no OP Pharmacy twin. It is one screen showing two
 * queues, though, and each queue is its own grant -- see CSD_GRANTS below.
 *
 * Deliberately not in SCREEN_ROUTES: that list has no OP Pharmacy screen in
 * it, and its GRN screens are what an account is forwarded through first when
 * it lands somewhere it may not go -- holding a screen and its twin, it should
 * arrive on the hospital one. An account holding only OP Pharmacy's is
 * forwarded to those next: see firstScreenPath.
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
 * The grant an OP Pharmacy screen is behind, from the hospital screen it is the
 * twin of: the same key under `ph-`, as the server's catalogue has it.
 *
 * Its own grant, not the hospital screen's: Pharmacy Results and Results are
 * two tick boxes on User management, and holding one says nothing of the
 * other. Everything else here stays keyed on the hospital screen -- the label,
 * the address, the page -- and this turns that key into what `can` is asked.
 */
export function opPharmacyGrant(screen) {
  return `ph-${screen}`;
}

/**
 * The CS Department screen's grants: one for each queue it shows, the
 * hospitals' and OP Pharmacy's. One screen and one link in the sidebar, open to
 * an account holding either; which queues it then offers is the page's to say
 * (SOURCES in pages/Csd.jsx, whose two `grant`s these are).
 */
export const CSD_GRANTS = ['csd', opPharmacyGrant('csd')];

/**
 * The CS Department screen as it opens on OP Pharmacy's queue: its one address
 * with the queue named, which is how the page keeps its choice (`?source=` in
 * pages/Csd.jsx, whose PHARMACY this spells out). Bare, the address opens on
 * the hospitals' queue -- so an account holding only OP Pharmacy's is sent
 * here instead, by the sidebar's link and by firstScreenPath, and arrives on
 * the address the screen rests on rather than being put right to it each time.
 */
export const PHARMACY_CSD_PATH = `${SCREEN_ROUTES.csd}?source=pharmacy`;

/** The hospitals' GRN screens, CS Department among them, in SCREEN_ROUTES' order. */
const HOSPITAL_GRN = Object.keys(SCREEN_ROUTES).filter(
  (key) => key === 'csd' || OP_PHARMACY_SCREENS.includes(key),
);

/** The same screens, in the order OP Pharmacy's twins are forwarded through: Results leading. */
const PHARMACY_GRN = ['results', ...HOSPITAL_GRN.filter((key) => key !== 'results')];

/**
 * Every grant with the address it opens, in the order an account is forwarded
 * through them.
 *
 * The hospitals' GRN screens first, as SCREEN_ROUTES has them, so an account
 * holding a screen and its OP Pharmacy twin arrives on the hospital one. Then
 * OP Pharmacy's in the same order, so an account holding only those arrives
 * on one of them rather than on /no-access -- but with Pharmacy Results
 * leading, since Results is where signing in aims a hospital account -- and
 * its CSD grant at the CS Department screen opened on OP Pharmacy's queue.
 * Then the rest, as they follow the GRN screens in the sidebar.
 */
const FORWARD_ROUTES = [
  ...HOSPITAL_GRN.map((key) => [key, SCREEN_ROUTES[key]]),
  ...PHARMACY_GRN.map((key) => [
    opPharmacyGrant(key),
    key === 'csd' ? PHARMACY_CSD_PATH : opPharmacyPath(key),
  ]),
  ...Object.entries(SCREEN_ROUTES).filter(([key]) => !HOSPITAL_GRN.includes(key)),
];

/**
 * Where to send an account that has landed somewhere it may not go.
 *
 * The first screen it does have, in FORWARD_ROUTES' order; /no-access when it
 * has none, which is the honest destination for an account nobody has ticked
 * anything for yet -- there is no page it could usefully be shown.
 */
export function firstScreenPath(screens = []) {
  const found = FORWARD_ROUTES.find(([key]) => screens.includes(key));
  return found ? found[1] : '/no-access';
}
