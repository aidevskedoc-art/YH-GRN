/**
 * The screens a user can be given access to, and the roles that exist.
 *
 * One list, held here rather than in each route, because three separate things
 * read it and they must not drift: the users API validates what an admin ticks
 * against it, `requireScreen` enforces it per request, and the client renders
 * the same keys as checkboxes and as navigation.
 *
 * A screen key is the route it guards, minus the slash. That is deliberate --
 * the client decides what to show from the same string the server decides what
 * to serve from, so a screen cannot be visible in the nav but closed at the API.
 * An OP Pharmacy key is its hospital twin's under `ph-`, guarding that screen's
 * address under /op-pharmacy; `ph-csd` guards no address of its own but the
 * second queue at /csd.
 */

/**
 * The headings the Screen access tick boxes stand under on User management:
 * the two sub-menus of the sidebar's GRN Reco, its Vendor Reco dropdown, and
 * one for the two links that administer the tool, which the sidebar draws
 * below those under no heading. Each queue of CS Department stands under the
 * side it belongs to. Each screen below names one as its `group`, and a
 * group's screens stand together in the list.
 */
const HOSPITALS = 'Hospitals';
const OP_PHARMACY = 'OP Pharmacy';
const VENDOR_RECO = 'Vendor Reco';
const ADMINISTRATION = 'Administration';

/*
 * In the sidebar's order and under the sidebar's names, so the Screen access
 * tick boxes on User management read as a list of the menu an account will
 * see: the Hospitals sub-menu's screens, then OP Pharmacy's, then the rest. CS
 * Department is the one screen that is two entries here -- a tick box for each
 * of its queues, named as the screen's own dropdown names them.
 */
export const SCREENS = [
  {
    key: 'upload',
    label: 'New uploads',
    hint: 'Upload the monthly reports and run a reconciliation.',
    group: HOSPITALS,
  },
  {
    key: 'results',
    label: 'Results',
    hint: 'Pending, Valid GRNs and the GRNS SPAN turnaround report.',
    group: HOSPITALS,
  },
  {
    // The results screen narrowed to the two views Accounts works from: the
    // GRNs the ageing report has picked up, and how long each step of the
    // journey to the bank took. A screen of its own rather than a filter on
    // `results`, because what it leaves out is the point -- an account given
    // this one never sees the pending half, the whole-population count or the
    // BPAD register, so the desk that only chases bills already in accounts
    // opens a page with nothing on it to rule out first.
    //
    // It reads exactly what the results screen reads, so every route behind
    // that screen admits this key as well -- see requireScreen('results',
    // 'accounts-department') in routes/results.js. That is the reason it is not
    // simply granted alongside `results`: holding both would put the full
    // screen back in the navigation, which is what this one exists to avoid.
    key: 'accounts-department',
    label: 'Accounts Department',
    hint: 'Accounts and the PR-to-Bank ageing, without the pending half.',
    group: HOSPITALS,
  },
  {
    // The hospitals' queue on the CS Department screen. That screen shows two
    // queues -- this one and OP Pharmacy's (`ph-csd` below) -- from separate
    // tables behind separate endpoints, and each is its own grant: an account
    // sees the screen if it holds either, and on it only the queues it holds.
    // The key is the one the screen has always had, so every account that was
    // given CS Department still holds this queue.
    key: 'csd',
    label: 'Hospital CSD',
    hint: 'The hospital handover queue and its stages, on the CS Department screen.',
    group: HOSPITALS,
  },
  {
    key: 'config',
    label: 'Configuration',
    hint: 'Branch codes, locations and bank accounts, and which branches are in scope.',
    group: HOSPITALS,
  },
  /*
   * OP Pharmacy's copy of the five screens above, each its own grant: the
   * hospital screen's key under `ph-`, as the pharmacies' tables are the
   * hospitals' under `ph_`. Their own keys rather than the hospital screens'
   * doing for both, which is how they began -- so that an account can be given
   * Pharmacy Results without Results, or the other way round. Every
   * /api/op-pharmacy router asks for these and for none of the hospital keys.
   *
   * In the hospital screens' order and after all five, so the list above reads
   * as the Hospitals sub-menu and this as OP Pharmacy's. Placed without moving
   * a key that was already here: an account's screens are stored in this order
   * (cleanScreens in routes/users.js) and the activity log compares them as
   * stored, so moving one would show as a change to every account holding it.
   *
   * Accounts holding a hospital screen when these arrived were given its twin
   * once, by `npm run migrate` -- see 'ph-screen-grants' in db/schema.sql,
   * which lists the keys as this catalogue stood when it ran.
   */
  {
    key: 'ph-upload',
    label: 'Pharmacy Uploads',
    hint: 'Upload the pharmacy reports and run their reconciliation.',
    group: OP_PHARMACY,
  },
  {
    key: 'ph-results',
    label: 'Pharmacy Results',
    hint: 'Total GRNS, BPAD, Accounts, Pending GRNS and the GRN age report.',
    group: OP_PHARMACY,
  },
  {
    key: 'ph-accounts-department',
    label: 'Ph-Accounts',
    hint: 'Accounts and the GRN age report, without the pending half.',
    group: OP_PHARMACY,
  },
  {
    key: 'ph-csd',
    label: 'OP Pharmacy CSD',
    hint: 'The OP Pharmacy handover queue and its stages, on the CS Department screen.',
    group: OP_PHARMACY,
  },
  {
    key: 'ph-config',
    label: 'Ph-Configuration',
    hint: 'Branch codes, unit names, BPAD locations and bank accounts, and which branches are in scope.',
    group: OP_PHARMACY,
  },
  {
    // Every vendor the HIS vendor master -- the correct data -- has ever
    // listed, with its latest details, filled by each HIS vs FOCUS Reco; first
    // under the Vendor Reco dropdown. Read-only, and its own grant: someone
    // can be given the master to look vendors up in without the reco, or the
    // other way round.
    key: 'vendor-master',
    label: 'Vendor Master',
    hint: 'Every HIS vendor with its latest details, kept up to date by each HIS vs FOCUS Reco. Read-only.',
    group: VENDOR_RECO,
  },
  {
    // The HIS vendor master against the Accounts vendor list. Its own grant
    // and its own dropdown in the sidebar: it reads neither report the GRN
    // screens do, so holding it says nothing about them, or they about it.
    // A run cannot be deleted: the Vendor Master it fills keeps one row per
    // vendor, so uploading again only updates what changed.
    key: 'msme-reco',
    label: 'HIS vs FOCUS Reco',
    hint: 'HIS vendor master against the FOCUS (Accounts) vendor list: PAN, GST, drug licence, MSME and bank details.',
    group: VENDOR_RECO,
  },
  {
    // Account management. A standard user given this can create and edit
    // standard accounts, but cannot create, change or delete an administrator
    // -- see the guards in routes/users.js.
    key: 'users',
    label: 'User management',
    hint: 'Create and edit standard accounts. Administrator accounts stay with administrators.',
    group: ADMINISTRATION,
  },
  {
    key: 'logs',
    label: 'Activity logs',
    hint: 'Who did what and when, including deletions. Read-only.',
    group: ADMINISTRATION,
  },
];

export const SCREEN_KEYS = SCREENS.map((s) => s.key);
const SCREEN_SET = new Set(SCREEN_KEYS);

/**
 * The two roles.
 *
 * ADMIN is not a screen grant: it is the account that manages other accounts,
 * reaches every screen without being given them one by one, and is the only
 * role allowed to correct a date on the GRNS SPAN tab. USER reaches exactly the
 * screens it has been ticked for, and reads dates without changing them.
 */
export const ROLES = [
  { key: 'ADMIN', label: 'Administrator', hint: 'Every screen, manages users, can correct dates.' },
  { key: 'USER', label: 'Standard user', hint: 'Only the screens ticked below. Dates are read-only.' },
];

export const ROLE_KEYS = ROLES.map((r) => r.key);

/**
 * The departments an account can belong to.
 *
 * A label on the person, not a permission. What someone may open is decided by
 * the role and the screen grants above and nowhere else -- an account in the
 * CSD department with only Results ticked still sees only Results. Keeping the
 * two apart means a reorganisation is a relabelling rather than a re-grant.
 *
 * Nullable: the seeded administrator predates the field, and an account whose
 * department nobody has stated should say so rather than be filed under a guess.
 */
export const DEPARTMENTS = [
  { key: 'HOSPITAL', label: 'Hospital' },
  { key: 'OP_PHARMACY', label: 'OP Pharmacy' },
  { key: 'CSD', label: 'CSD' },
  { key: 'ACCOUNTS', label: 'Accounts' },
];

export const DEPARTMENT_KEYS = DEPARTMENTS.map((d) => d.key);
const DEPARTMENT_SET = new Set(DEPARTMENT_KEYS);

export function isDepartment(key) {
  return DEPARTMENT_SET.has(key);
}

export function isScreen(key) {
  return SCREEN_SET.has(key);
}

/**
 * The screens an account actually reaches.
 *
 * An admin reaches all of them whatever is stored against the row, so nobody
 * can lock the administrator out of a screen by unticking it.
 */
export function screensFor(user) {
  if (!user) return [];
  if (user.role === 'ADMIN') return [...SCREEN_KEYS];
  return (user.screens || []).filter(isScreen);
}

/**
 * The one branch an account may see, or null for every branch.
 *
 * The companion to screensFor, and it answers the same shape of question: the
 * stored column says what was granted, this says what actually applies. An
 * admin is unrestricted whatever the row holds, so nobody can be shut out of
 * the data by the same screen they hand access out from -- and, more to the
 * point, so the last administrator cannot be narrowed to a branch that is later
 * deleted and left able to see nothing.
 *
 * Every query behind the results and CSD screens carries this. It is a
 * permission, not a preference: the Location dropdown on those screens chooses
 * within what this allows and can never widen it.
 */
export function branchFor(user) {
  if (!user) return null;
  if (user.role === 'ADMIN') return null;
  const location = String(user.branch_location ?? '').trim();
  return location === '' ? null : location;
}
