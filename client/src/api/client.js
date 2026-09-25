const TOKEN_KEY = 'yh_grn_token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing - the session simply will not persist across reloads */
  }
}

/** Raised for any non-2xx response, carrying the server's message. */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

/**
 * What a status code means to someone who is not going to look it up. Only
 * used when the server sent no `error` string of its own -- most routes do,
 * and that wording wins every time (see `request` below) -- so this is the
 * net under an unhandled crash or a proxy/gateway response with no JSON body.
 */
function fallbackMessage(status) {
  if (status === 400) return 'That request was not valid.';
  if (status === 403) return 'You do not have access to do that.';
  if (status === 404) return 'That could not be found.';
  if (status === 409) return 'That conflicts with something already there.';
  if (status === 413) return 'File is too large.';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return 'Something went wrong on our end. Please try again.';
  return 'Something went wrong. Please try again.';
}

/**
 * `isSignIn` marks the one call made without a session: the login attempt. A
 * 401 there is the server refusing the credentials, not a session running out,
 * so it must be allowed through to the normal path and reach the form with the
 * server's own wording -- otherwise every rejected sign-in reads as "your
 * session has expired", which is the one thing it cannot be.
 */
async function request(path, { method = 'GET', body, isForm = false, isSignIn = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !isForm) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // The request never reached the server -- offline, DNS, a dropped VPN.
    // The browser's own wording here ("Failed to fetch") names its API, not
    // the user's problem.
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }

  if (response.status === 401 && !isSignIn) {
    setToken(null);
    onUnauthorized();
    // The session is over either way, but why it is over is worth repeating:
    // an account switched off underneath a signed-in user is told so, and only
    // a token that has genuinely run out falls back to the general wording.
    const reason = await response.json().catch(() => ({}));
    throw new ApiError(reason.error || 'Your session has expired. Please sign in again.', 401);
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(payload.error || fallbackMessage(response.status), response.status);
  }
  return payload;
}

export const api = {
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password }, isSignIn: true }),
  me: () => request('/auth/me'),

  /* --- Accounts -----------------------------------------------------------
     Administrator-only, every one of them. A standard user reaching these gets
     a 403 carrying the server's wording, which is what the screen shows. */

  /** Every account, plus the screen and role catalogues the form is built from. */
  listUsers: () => request('/users'),

  /** Create one. `screens` is an array of screen keys: upload, results, csd. */
  createUser: (body) => request('/users', { method: 'POST', body }),

  /**
   * Change fullName, role, screens or isActive. Anything left out is untouched,
   * so a single toggle sends a single field.
   */
  updateUser: (id, body) => request(`/users/${id}`, { method: 'PATCH', body }),

  /** Set a new password for someone who has been locked out. */
  resetUserPassword: (id, password) =>
    request(`/users/${id}/password`, { method: 'PATCH', body: { password } }),

  /** Remove the account. What it uploaded or sent stays, with the name dropped. */
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  /* --- Activity log -------------------------------------------------------
     Administrator-only. Who did what and when, newest first, with the counts,
     action catalogue and people the screen's cards and filters are built from.
     `all` drops the pagination, for the export. */
  listLogs: ({ page = 1, pageSize = 20, q, category, action, userId, from, to, deleted, all } = {}) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q) params.set('q', q);
    // Only tracked deletions: uploads and files, users, branches.
    if (deleted) params.set('deleted', '1');
    if (category) params.set('category', category);
    if (action) params.set('action', action);
    if (userId) params.set('userId', String(userId));
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (all) params.set('all', '1');
    return request(`/logs?${params}`);
  },

  listBatches: () => request('/batches'),
  uploadBatch: (formData) => request('/batches', { method: 'POST', body: formData, isForm: true }),

  /** `q` is the search box: vendor name, GRN number or bill number, either side. */
  summary: (id, { q, location, msme } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (location) params.set('location', location);
    // 'MSME' or 'NON_MSME' -- the MSME dropdown, a scope like Location. See
    // MsmeFilter.jsx.
    if (msme) params.set('msme', msme);
    return request(`/batches/${id}/summary?${params}`);
  },
  /**
   * `progress` is what the cards and the Status dropdown set: one of the cheque
   * three, one of the four CSD stages, or one of the two Accounts cards' keys
   * (see PROGRESS in routes/results.js).
   *
   * `action` is the Action filter: where the row has got to, narrowing on top of
   * `progress` rather than replacing it -- Cheque Prepared on the card, then
   * CSD received here. `actionCounts` asks for the counts beside that
   * dropdown's options to come back with the rows, as `actionCounts`.
   *
   * `location` is one configured branch, by the name the configuration screen
   * gives it. It narrows every figure on the page together -- rows, cards and
   * the counts beside the filter options -- because it is a scope rather than a
   * question about a row.
   */
  results: (
    id,
    { status, page = 1, pageSize = 50, q, progress, action, actionCounts, location, msme, dept, chequeNo, view } = {},
  ) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    if (progress) params.set('progress', progress);
    if (action) params.set('action', action);
    if (actionCounts) params.set('actionCounts', '1');
    if (location) params.set('location', location);
    if (msme) params.set('msme', msme);
    // One BPAD desk, set by the breakdown cards under the Pending view -- the
    // register's answer for where each pending bill stopped. Spelled the same
    // as the BPAD tab's own `dept` below, because it is the same column.
    if (dept) params.set('dept', dept);
    // One cheque's bills, matched exactly rather than searched for. The Action
    // column asks for this before it acts, so that a send moves the whole
    // cheque and not just the bill on screen -- see chequeGroup in
    // ResultsTable.jsx.
    if (chequeNo) params.set('chequeNo', chequeNo);
    // 'cheque' for the Accounts Department's Cheque view: one row per cheque, with
    // its bills' PayableAmount summed into `chequeAmount`.
    if (view) params.set('view', view);
    return request(`/batches/${id}/results?${params}`);
  },

  /**
   * The BPAD register's rows for the GRNs in scope -- the BPAD tab.
   *
   * No `status` or `progress`: every row on this tab is in the register
   * because it matched a GRN on file, and the register's own verdict on a bill
   * is a column of it rather than something this system decided.
   *
   * `dept` is that column -- Pending With Dept. -- narrowed to one of the
   * desks a bill can be sitting at. The response carries the full list of them
   * back as `departments`, so the dropdown is built from the register itself.
   *
   * `register` narrows the other column the tab has of its own: 'missing' for
   * the GRNs the register had no entry for, which is what the Not in BPAD card
   * asks for.
   */
  bpad: (id, { page = 1, pageSize = 50, q, location, msme, dept, register } = {}) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q) params.set('q', q);
    if (location) params.set('location', location);
    if (msme) params.set('msme', msme);
    if (dept) params.set('dept', dept);
    if (register) params.set('register', register);
    return request(`/batches/${id}/bpad?${params}`);
  },

  /** Per-stage day counts for the Turnaround tab. Statistics cover every row in
   *  scope; only `rows` is paginated. */
  turnaround: (id, { page = 1, pageSize = 50, q, location, msme } = {}) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q) params.set('q', q);
    if (location) params.set('location', location);
    if (msme) params.set('msme', msme);
    return request(`/batches/${id}/turnaround?${params}`);
  },

  /**
   * Correct one or more of a row's seven stage dates. Each value is yyyy-MM-dd,
   * or null to clear it; fields left out are not touched. The day counts are
   * derived on read, so nothing else has to be told about the change.
   */
  updateAgeingDates: (id, dates) =>
    request(`/ageing/${id}/dates`, { method: 'PATCH', body: dates }),

  /* --- The CSD queue ------------------------------------------------------
     A handover is its own record, not part of a batch: it keeps its own copy of
     the GRN's details so it still reads correctly once the upload it came from
     has been deleted or replaced by the next month's. */

  /**
   * The queue, newest handover first, plus the five stage counts the cards read.
   * Those counts follow `q` but not `stage` -- they are how a stage is picked.
   * `all` drops the pagination, for export.
   */
  listCsd: ({ page = 1, pageSize = 20, q, stage, location, msme, all, chequeNo, view } = {}) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q) params.set('q', q);
    if (stage) params.set('stage', stage);
    // Like `q` and unlike `stage`, these two narrow the counts as well: see the
    // note on LOCATION_FILTER in routes/csd.js.
    if (location) params.set('location', location);
    if (msme) params.set('msme', msme);
    if (all) params.set('all', '1');
    // One cheque's handovers, matched exactly rather than searched for. The
    // Action column asks for this before it moves anything, so that a stage
    // move carries the whole cheque -- see chequeGroup in Csd.jsx.
    if (chequeNo) params.set('chequeNo', chequeNo);
    // 'cheque' for the Cheque view: one row per cheque -- see chequeDispatches.
    if (view) params.set('view', view);
    return request(`/csd?${params}`);
  },

  /**
   * Hand one Valid GRNs row to CSD. The whole row is sent; the server keeps the
   * fields the queue holds and ignores the rest. Sending a GRN that is already
   * queued refreshes its snapshot rather than failing.
   */
  sendToCsd: (row) => request('/csd', { method: 'POST', body: row }),

  /**
   * Move one handover to a CSD stage: QUEUED, RECEIVED, APPROVED or REJECTED.
   * Any direction -- a stage set by mistake has to be settable back.
   */
  /**
   * Move one handover to a CSD stage. `remarks` is CSD's reason, required by
   * the server when the stage is REJECTED and ignored for every other one.
   */
  setCsdStage: (id, stage, remarks) =>
    request(`/csd/${id}/stage`, {
      method: 'PATCH',
      body: remarks ? { stage, remarks } : { stage },
    }),

  /**
   * Correct one or more of a handover's CSD stamps. Each value is yyyy-MM-dd.
   * Only a stamp the row already carries can be changed -- the status dropdown
   * is what advances a GRN to a stage; this only fixes the date it landed on.
   */
  updateCsdDates: (id, dates) => request(`/csd/${id}/dates`, { method: 'PATCH', body: dates }),

  /** Take a GRN back off the queue, by dispatch id. Refused once CSD have
   *  ruled on it -- deleteCsdRecord below is what reaches those. */
  removeFromCsd: (id) => request(`/csd/${id}`, { method: 'DELETE' }),

  /**
   * Delete a handover whatever stage it reached -- including one CSD have
   * approved, rejected or handed back to Accounts, which removeFromCsd above
   * refuses.
   *
   * A correction to the data rather than a move in the process, so it is
   * administrator-only at the API. The GRN returns to Accounts as one that was
   * never handed over, the same as a take-back.
   */
  deleteCsdRecord: (id) => request(`/csd/${id}/record`, { method: 'DELETE' }),

  /**
   * File one Valid GRNs row to Records -- the other destination on that row.
   *
   * Same call shape as sendToCsd, so the two read alike at the call site, but
   * Records is a note rather than a queue: it has no screen and no stages, and
   * nothing comes back from it but the fact that the GRN went.
   */
  sendToRecords: (row) => request('/records', { method: 'POST', body: row }),

  /**
   * Acknowledge one GRN CSD marked Moved to accounts, by its CSD dispatch id
   * -- the results table's own Action column offers this once csdStage
   * reaches MOVED_TO_ACCOUNTS, rather than a queue screen of its own.
   */
  receiveAccountsReturn: (id) => request(`/accounts-returns/${id}/receive`, { method: 'PATCH' }),

  /**
   * Accounts' last move on a GRN: where it goes on to. `body` is
   * `{ to: 'BANK' | 'VENDOR' | 'OTHERS' | 'COURIER' }`, plus `route` when `to`
   * is 'VENDOR', `name`/`mobile`/`date` when `to` is 'VENDOR' or 'OTHERS',
   * `remarks` when `to` is 'OTHERS', and `courierName`/`docketNo`/`date` when
   * `to` is 'COURIER' -- Bank needs nothing further.
   */
  forwardAccountsReturn: (id, body) =>
    request(`/accounts-returns/${id}/forward`, { method: 'PATCH', body }),

  /* --- Branches ------------------------------------------------------------
     What a branch is called in each of the three files, and which branches are
     in scope. Reading is open to any signed-in account, because every screen
     showing figures has to be able to say what it is showing; writing needs the
     Configuration screen. */

  /** Every configured branch, ticked ones first. */
  listBranches: () => request('/config/branches'),

  /** Body: branchCode, location, accountNo, isSelected. */
  createBranch: (body) => request('/config/branches', { method: 'POST', body }),

  /** Any subset of the same fields. The tick box sends only isSelected. */
  updateBranch: (id, body) => request(`/config/branches/${id}`, { method: 'PATCH', body }),

  deleteBranch: (id) => request(`/config/branches/${id}`, { method: 'DELETE' }),

  /* --- MSME reco -----------------------------------------------------------
     The HIS vendor master against the Accounts vendor list. A run is both
     files reconciled and stored; the screen shows every vendor once, from the
     latest run that had it, read from the API rather than from the files. */

  /** Upload both masters (`vendorFile`, `accountFile`) and store the reco. */
  runMsmeReco: (formData) => request('/msme-reco/runs', { method: 'POST', body: formData, isForm: true }),

  /**
   * Every HIS vendor once, from the latest reco that had it, with the latest
   * reco itself (`latestRun`, null before the first) and how many there have
   * been (`runCount`). Accounts-only codes are counted on each run, not
   * stored. `view` is a card: ALL (the default), MATCHED, MISMATCH or
   * NOT_IN_ACCOUNTS; `field` narrows to the rows whose `field` pair disagrees;
   * `q` is the search box. `all` drops the paging, for the export.
   */
  msmeRows: ({ view, field, q, page = 1, pageSize = 20, all } = {}) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (view) params.set('view', view);
    if (field) params.set('field', field);
    if (q) params.set('q', q);
    if (all) params.set('all', '1');
    return request(`/msme-reco/rows?${params}`);
  },

  /* --- Vendor Master -------------------------------------------------------
     Every vendor the HIS vendor master -- the correct data -- has ever listed,
     once each, with its latest details. Each reco run above adds its new
     vendors and updates the rest; Supply Type and Inter are set here. */

  /**
   * The master in vendor code order, each row as its `cells` in the order of
   * `headers` with its `supplyType` and `inter`, and `lastApply` the last
   * vendor master file applied to it (null before any). `view` is a card: ALL
   * (the default), NO_STATUS, or a STATUS value; `q` searches every column
   * shown. `all` drops the paging, for the export.
   */
  vendorMasterRows: ({ view, q, page = 1, pageSize = 20, all } = {}) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (view) params.set('view', view);
    if (q) params.set('q', q);
    if (all) params.set('all', '1');
    return request(`/vendor-master/rows?${params}`);
  },

  /**
   * Set a vendor's picked details: `{ supplyType }` ('REGULAR' or 'STENTS')
   * and/or `{ inter }` ('NO' or 'YES').
   */
  updateVendor: (id, changes) => request(`/vendor-master/${id}`, { method: 'PATCH', body: changes }),

  /**
   * Every row for one sheet, unpaginated -- the input to
   * services/exporter.js.
   *
   * `status` is which view's rows; the rest are the narrowings the cards on a
   * view set, so that a section's workbook can ask for one card's rows per
   * sheet. `progress` is the Status column's own filter (the CSD stages and
   * the cheque pair), `dept` one BPAD desk, `register` the 'missing' rows.
   * Anything left out narrows nothing.
   */
  exportRows: (id, status, { q, progress, location, msme, dept, register, view } = {}) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    // 'cheque' for the Accounts view's Cheque view sheet -- see chequeRows.
    if (view) params.set('view', view);
    if (q) params.set('q', q);
    if (progress) params.set('progress', progress);
    if (location) params.set('location', location);
    if (msme) params.set('msme', msme);
    if (dept) params.set('dept', dept);
    if (register) params.set('register', register);
    return request(`/batches/${id}/export?${params}`);
  },
};
