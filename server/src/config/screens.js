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
 */
/*
 * In the sidebar's order and under the sidebar's names, so the Screen access
 * tick boxes on User management read as a list of the menu an account will see.
 */
export const SCREENS = [
  {
    key: 'upload',
    label: 'New uploads',
    hint: 'Upload the monthly reports and run a reconciliation.',
  },
  {
    key: 'results',
    label: 'Results',
    hint: 'Pending, Valid GRNs and the GRNS SPAN turnaround report.',
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
  },
  {
    key: 'csd',
    label: 'CS Department',
    hint: 'The handover queue and its stages.',
  },
  {
    key: 'config',
    label: 'Configuration',
    hint: 'Branch codes, locations and bank accounts, and which branches are in scope.',
  },
  {
    // What has been uploaded, file by file. Its own grant now rather than
    // coming with `upload`; deleting an upload or a file stays administrator-only.
    key: 'uploads',
    label: 'Uploaded files',
    hint: 'Every upload and its files. Deleting them stays with administrators.',
  },
  {
    // Account management. A standard user given this can create and edit
    // standard accounts, but cannot create, change or delete an administrator
    // -- see the guards in routes/users.js.
    key: 'users',
    label: 'User management',
    hint: 'Create and edit standard accounts. Administrator accounts stay with administrators.',
  },
  {
    key: 'logs',
    label: 'Activity logs',
    hint: 'Who did what and when, including deletions. Read-only.',
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
