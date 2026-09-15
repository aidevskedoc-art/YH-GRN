/**
 * User management.
 *
 * Who has an account, what role it carries, and which screens it may open.
 * Behind the User management screen grant, which administrators hold by
 * default. A standard user given it manages standard accounts only: the server
 * refuses them administrator accounts (see routes/users.js), and those rows'
 * controls are disabled here.
 *
 * The screen and role catalogues come down with the accounts on GET /api/users,
 * from server/src/config/screens.js, so the tick boxes on this page and the
 * validation on the way back are one list. Departments are the exception and
 * are held here -- see DEPARTMENTS below for why.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import Sheet from '../components/Sheet.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { IconKey, IconPencil, IconPlus, IconShield, IconTrash, IconUsers } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import { initials } from '../theme.js';

/** dd-MM-yyyy from a timestamptz, in the browser's own zone. */
function formatCreated(value) {
  if (!value) return '—';
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toLocaleDateString('en-GB') : '—';
}

/**
 * The departments, held here rather than read off the API response.
 *
 * Two fixed labels that do not change with the data, so the dropdown should not
 * be able to come up empty because a payload was missing a key -- a select with
 * nothing in it gives no clue that anything is wrong.
 *
 * The server keeps its own copy in config/screens.js and validates every write
 * against it. That one is the authority: this list decides what is OFFERED, and
 * the server decides what is ACCEPTED, so a key added here alone is refused
 * rather than quietly stored.
 */
const DEPARTMENTS = [
  { key: 'CSD', label: 'CSD' },
  { key: 'ACCOUNTS', label: 'Accounts' },
];

/**
 * A blank account, as the form starts.
 *
 * A new account is a standard user with nothing ticked: access is something an
 * administrator decides row by row, and defaulting it to "everything" would
 * make the screen a formality rather than a control.
 */
const BLANK = {
  id: null,
  username: '',
  fullName: '',
  password: '',
  role: 'USER',
  screens: [],
  department: '',
  // Every branch, which is what an account has until somebody narrows it. The
  // opposite default would confine each new account to whichever branch
  // happened to be first in the list, which is a decision nobody made.
  branchLocation: '',
  isActive: true,
};

/**
 * The create/edit form, as a panel over the page.
 *
 * One component for both jobs, because they differ in exactly one place: the
 * password is required when creating and absent when editing -- resetting one
 * is its own control on the row.
 */
function UserForm({
  initial,
  screens,
  roles,
  departments,
  locations,
  isSelf,
  saving,
  error,
  onSave,
  onClose,
}) {
  const [form, setForm] = useState(initial);
  const editing = initial.id !== null;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const toggleScreen = (key) =>
    setForm((f) => ({
      ...f,
      screens: f.screens.includes(key)
        ? f.screens.filter((s) => s !== key)
        : // Kept in catalogue order rather than click order, so the row's
          // summary reads the same however the boxes were ticked.
          screens.map((s) => s.key).filter((k) => k === key || f.screens.includes(k)),
    }));

  const isAdminRole = form.role === 'ADMIN';

  return (
    <Sheet label={editing ? 'Edit account' : 'New account'} onClose={onClose}>
      <form
        className="sheet__form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(form);
        }}
      >
        <div className="sheet__head">
          <h2>{editing ? `Edit ${initial.username}` : 'New account'}</h2>
          {/* <p className="sheet__lead">
            {editing
              ? 'Changing the username changes what this person signs in with. Their past uploads and handovers follow the account, not the name.'
              : 'The person signs in with this username and password. Both are case-sensitive apart from the username, which is not.'}
          </p> */}
        </div>

        <div className="sheet__body">
          {error && <div className="alert alert--error">{error}</div>}

          <div className="form-grid">
            <label className="field">
              <span className="field__label">Username</span>
              <input
                className="field__input"
                value={form.username}
                onChange={(e) => set({ username: e.target.value })}
                autoComplete="off"
                required
              />
              {editing && form.username.trim() !== initial.username && (
                // Said once the name has actually been changed, not standing
                // over the field the whole time: it is a consequence of the
                // edit, and a warning about something nobody is doing is noise.
                <span className="field__hint">
                  {initial.username} will sign in as{' '}
                  <strong>{form.username.trim()}</strong> from now on. Tell them.
                </span>
              )}
            </label>

            <label className="field">
              <span className="field__label">Full name</span>
              <input
                className="field__input"
                value={form.fullName ?? ''}
                onChange={(e) => set({ fullName: e.target.value })}
                placeholder="Shown in the sidebar and against uploads"
                autoComplete="off"
              />
            </label>
          </div>

          {/* A label on the person, so it sits with the name rather than with the
              role and the screen grants -- what an account may open is decided
              by those two and not by this. Blank is a real answer: an account
              whose department nobody has stated should say so. */}
          <label className="field">
            <span className="field__label">Department</span>
            <select
              className="field__input"
              value={form.department ?? ''}
              onChange={(e) => set({ department: e.target.value })}
            >
              <option value="">Select Department</option>
              {departments.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          {/* Which branch's figures this account may see, and unlike Department
              above it IS a permission: it is applied to every query behind the
              results and CSD screens, not offered as a filter the person can
              clear. Blank is the normal answer -- most people are not confined
              to one branch -- and the options are the branches configured on
              the configuration screen, so this offers what the installation
              actually has. */}
          <label className="field">
            <span className="field__label">Branch access</span>
            <select
              className="field__input"
              value={form.branchLocation ?? ''}
              onChange={(e) => set({ branchLocation: e.target.value })}
              disabled={isAdminRole || locations.length === 0}
            >
              <option value="">All locations</option>
              {locations.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              {/* The branch this account was given before it was deleted from
                  the configuration. Kept selectable so the form does not
                  silently rewrite a grant it cannot show. */}
              {form.branchLocation && !locations.includes(form.branchLocation) && (
                <option value={form.branchLocation}>{form.branchLocation} (not configured)</option>
              )}
            </select>
            <span className="field__hint">
              {isAdminRole
                ? 'An administrator sees every branch, the same way they reach every screen.'
                : locations.length === 0
                  ? 'No branches configured yet — add them on the Configuration screen, then this account can be tied to one.'
                  : form.branchLocation
                    ? `This account will see ${form.branchLocation} rows only, on the results and CSD screens and in their exports.`
                    : 'Every branch. Choose one to confine this account to it.'}
            </span>
          </label>

          {!editing && (
            <label className="field">
              <span className="field__label">Password</span>
              <input
                className="field__input"
                type="password"
                value={form.password}
                onChange={(e) => set({ password: e.target.value })}
                autoComplete="new-password"
                minLength={6}
                required
              />
              <span className="field__hint">At least 6 characters. It can be reset later.</span>
            </label>
          )}

          <div className="field">
            <span className="field__label">Role</span>
            <div className="choices">
              {roles.map((r) => (
                <label
                  key={r.key}
                  className={`choice${form.role === r.key ? ' is-on' : ''}${
                    isSelf ? ' is-locked' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="role"
                    value={r.key}
                    checked={form.role === r.key}
                    disabled={isSelf}
                    onChange={() => set({ role: r.key })}
                  />
                  <span className="choice__text">
                    <span className="choice__label">{r.label}</span>
                    <span className="choice__hint">{r.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {isSelf && (
              <span className="field__hint">
                You cannot change your own role — another administrator has to do it.
              </span>
            )}
          </div>

          <div className="field">
            <span className="field__label">Screen access</span>
            <div className="choices">
              {screens.map((s) => {
                const on = isAdminRole || form.screens.includes(s.key);
                return (
                  <label
                    key={s.key}
                    className={`choice${on ? ' is-on' : ''}${isAdminRole ? ' is-locked' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      // An administrator holds every screen whatever is stored,
                      // so the boxes are shown ticked and left alone. The ticks
                      // underneath are kept, and come back if the account is
                      // later made a standard user.
                      disabled={isAdminRole}
                      onChange={() => toggleScreen(s.key)}
                    />
                    <span className="choice__text">
                      <span className="choice__label">{s.label}</span>
                      <span className="choice__hint">{s.hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            <span className="field__hint">
              {isAdminRole
                ? 'An administrator reaches every screen, and is the only role that can correct a date on the GRNS SPAN tab.'
                : 'A standard user sees only the screens ticked here, and reads the GRNS SPAN dates without changing them.'}
            </span>
          </div>

          {editing && (
            <label className={`choice choice--wide${form.isActive ? ' is-on' : ''}${isSelf ? ' is-locked' : ''}`}>
              <input
                type="checkbox"
                checked={form.isActive}
                disabled={isSelf}
                onChange={(e) => set({ isActive: e.target.checked })}
              />
              <span className="choice__text">
                <span className="choice__label">Active</span>
                <span className="choice__hint">
                  {isSelf
                    ? 'You cannot deactivate the account you are signed in as.'
                    : 'Unticked, the account is refused at sign-in and on every request it has open.'}
                </span>
              </span>
            </label>
          )}
        </div>

        <div className="sheet__foot">
          <button type="button" className="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create account'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** The password reset panel: one field, and the account it belongs to. */
function PasswordForm({ user, saving, error, onSave, onClose }) {
  const [password, setPassword] = useState('');

  return (
    <Sheet label={`Reset the password for ${user.username}`} narrow onClose={onClose}>
      <form
        className="sheet__form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(password);
        }}
      >
        <div className="sheet__head">
          <h2>Reset password</h2>
          <p className="sheet__lead">
            A new password for <strong>{user.username}</strong>. They are not told — pass it on
            yourself.
          </p>
        </div>

        <div className="sheet__body">
          {error && <div className="alert alert--error">{error}</div>}
          <label className="field">
            <span className="field__label">New password</span>
            <input
              className="field__input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={6}
              required
              autoFocus
            />
            <span className="field__hint">At least 6 characters.</span>
          </label>
          <p className="field__hint">
            Any session they already have open keeps working until its token expires. To cut one
            short, deactivate the account and activate it again.
          </p>
        </div>

        <div className="sheet__foot">
          <button type="button" className="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Set password'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export default function Users() {
  const { user: me } = useAuth();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Which panel is open: a form (create or edit), or a password reset.
  const [form, setForm] = useState(null);
  const [resetting, setResetting] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Which row has a request in flight, so its own controls go quiet rather than
  // the whole table.
  const [busy, setBusy] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(() => {
    setLoading(true);
    api
      .listUsers()
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const screens = data?.screens ?? [];
  const roles = data?.roles ?? [];
  const departments = DEPARTMENTS;
  // From the API, unlike the departments above: branches are data somebody
  // configured rather than two fixed labels, so there is nothing to hold here.
  const locations = data?.locations ?? [];
  const users = data?.users ?? [];

  /** Screen keys to their labels, for the summary in each row. */
  const screenLabels = useMemo(
    () => Object.fromEntries(screens.map((s) => [s.key, s.label])),
    [screens],
  );

  /** Department keys to their labels, for the column. */
  const departmentLabels = useMemo(
    () => Object.fromEntries(departments.map((d) => [d.key, d.label])),
    [departments],
  );

  const adminCount = users.filter((u) => u.role === 'ADMIN' && u.isActive).length;
  // A standard user given this screen manages standard accounts only; the
  // server refuses them administrator accounts, and these rows say so up front.
  const canManageAdmins = data?.canManageAdmins ?? me?.role === 'ADMIN';
  const ADMIN_LOCKED = 'Only an administrator can change an administrator account.';

  async function saveUser(values) {
    setSaving(true);
    setFormError('');
    try {
      if (values.id === null) {
        await api.createUser({
          username: values.username,
          password: values.password,
          fullName: values.fullName,
          role: values.role,
          screens: values.screens,
          department: values.department,
          branchLocation: values.branchLocation,
        });
      } else {
        // Everything goes together, so one save is one request whatever was
        // touched.
        await api.updateUser(values.id, {
          username: values.username,
          fullName: values.fullName,
          role: values.role,
          screens: values.screens,
          department: values.department,
          branchLocation: values.branchLocation,
          isActive: values.isActive,
        });
      }
      setForm(null);
      load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function savePassword(password) {
    setSaving(true);
    setFormError('');
    try {
      await api.resetUserPassword(resetting.id, password);
      setResetting(null);
      load();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Turn an account on or off from its row.
   *
   * The common case by far -- somebody has left, or is back -- so it is a
   * single click here rather than a trip through the form. It sends only
   * `isActive`, which is why the rest of the account cannot be disturbed by it.
   */
  async function toggleActive(row) {
    setBusy(row.id);
    setError('');
    try {
      await api.updateUser(row.id, { isActive: !row.isActive });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function removeUser(row) {
    const ok = await confirm({
      title: 'Delete this account?',
      message: `Are you sure you want to delete ${row.username}?`,
      confirmLabel: 'Delete account',
    });
    if (!ok) return;

    setBusy(row.id);
    setError('');
    try {
      await api.deleteUser(row.id);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data) return <div className="loading">Loading…</div>;

  return (
    <>
      {confirmDialog}
      <div className="page__head page__head--row">
        <div>
          <h2 className="page__title">Accounts</h2>
          <p className="page__lead">
            {users.length.toLocaleString('en-IN')} account{users.length === 1 ? '' : 's'},{' '}
            {adminCount} administrator{adminCount === 1 ? '' : 's'}. An administrator reaches every
            screen and is the only role that can correct a date on the GRNS SPAN tab; everyone else
            sees the screens ticked for them and reads those dates as they stand.
          </p>
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="primary"
            onClick={() => {
              setFormError('');
              setForm(BLANK);
            }}
          >
            <IconPlus size={16} />
            <span className="btn-label">New account</span>
          </button>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Department</th>
              <th>Branch</th>
              <th>Role</th>
              <th>Screen access</th>
              <th>GRNS SPAN dates</th>
              <th className="table__num">Uploads</th>
              <th>Created</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td className="table__empty" colSpan={10}>
                  No accounts yet
                </td>
              </tr>
            )}
            {users.map((row) => {
              const isSelf = row.id === me?.id;
              const isAdminRow = row.role === 'ADMIN';
              const locked = isAdminRow && !canManageAdmins;
              const granted = isAdminRow ? screens.map((s) => s.key) : row.screens;

              return (
                <tr key={row.id} className={row.isActive ? undefined : 'is-muted'}>
                  <td>
                    <div className="user-cell">
                      {/* The same initials the sidebar draws for the signed-in
                          account, so a row and the chip read as one person. */}
                      <span className="avatar avatar--sm">
                        {initials(row.fullName || row.username)}
                      </span>
                      <span>
                        {row.fullName || row.username}
                        <div className="table__sub">
                          {row.username}
                          {isSelf && ' — you'}
                        </div>
                      </span>
                    </div>
                  </td>

                  <td>
                    {row.department ? (
                      departmentLabels[row.department] ?? row.department
                    ) : (
                      <span className="table__miss">Not stated</span>
                    )}
                  </td>

                  {/* What the account may see, not where the person sits. An
                      administrator's stored branch is ignored, so the column
                      says so rather than reporting a grant that does nothing. */}
                  <td>
                    {isAdminRow ? (
                      <span className="table__miss">Every branch</span>
                    ) : row.branchLocation ? (
                      <span className="tag">{row.branchLocation}</span>
                    ) : (
                      <span className="table__miss">Every branch</span>
                    )}
                  </td>

                  <td>
                    <span className={`pill ${isAdminRow ? 'pill--admin' : 'pill--user'}`}>
                      {isAdminRow && <IconShield size={12} />}
                      {isAdminRow ? 'Administrator' : 'Standard user'}
                    </span>
                  </td>

                  <td>
                    {granted.length === 0 ? (
                      <span className="table__miss">No screens</span>
                    ) : (
                      <div className="tag-row">
                        {granted.map((key) => (
                          <span key={key} className="tag">
                            {screenLabels[key] ?? key}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>

                  {/* The permission this screen exists to spell out. It is not a
                      grant that can be ticked -- it follows the role -- so it is
                      reported rather than edited. */}
                  <td>
                    <span className={`pill ${isAdminRow ? 'pill--approved' : 'pill--unsent'}`}>
                      {isAdminRow ? 'Can edit' : 'Read only'}
                    </span>
                  </td>

                  <td className="table__num">{row.uploadCount.toLocaleString('en-IN')}</td>
                  <td>{formatCreated(row.createdAt)}</td>

                  <td>
                    <span className={`pill ${row.isActive ? 'pill--approved' : 'pill--rejected'}`}>
                      {row.isActive ? 'Active' : 'Deactivated'}
                    </span>
                  </td>

                  <td>
                    <div className="row-actions row-actions--inline">
                      <button
                        type="button"
                        className="icon-btn ghost"
                        title={locked ? ADMIN_LOCKED : `Edit ${row.username}`}
                        aria-label={`Edit ${row.username}`}
                        disabled={busy === row.id || locked}
                        onClick={() => {
                          setFormError('');
                          setForm({ ...row, password: '' });
                        }}
                      >
                        <IconPencil size={16} />
                      </button>

                      <button
                        type="button"
                        className="icon-btn ghost"
                        title={locked ? ADMIN_LOCKED : `Reset the password for ${row.username}`}
                        aria-label={`Reset the password for ${row.username}`}
                        disabled={busy === row.id || locked}
                        onClick={() => {
                          setFormError('');
                          setResetting(row);
                        }}
                      >
                        <IconKey size={16} />
                      </button>

                      <button
                        type="button"
                        className="ghost ghost--sm"
                        disabled={busy === row.id || isSelf || locked}
                        title={
                          locked
                            ? ADMIN_LOCKED
                            : isSelf
                            ? 'You cannot deactivate the account you are signed in as.'
                            : row.isActive
                              ? `Stop ${row.username} signing in`
                              : `Let ${row.username} sign in again`
                        }
                        onClick={() => toggleActive(row)}
                      >
                        {row.isActive ? 'Deactivate' : 'Activate'}
                      </button>

                      <button
                        type="button"
                        className="icon-btn ghost icon-btn--danger"
                        title={
                          locked
                            ? ADMIN_LOCKED
                            : isSelf
                              ? 'You cannot delete the account you are signed in as.'
                              : `Delete ${row.username}`
                        }
                        aria-label={`Delete ${row.username}`}
                        disabled={busy === row.id || isSelf || locked}
                        onClick={() => removeUser(row)}
                      >
                        <IconTrash size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="table__note">
        <IconUsers size={14} /> Deactivating is checked on every request, not only at sign-in, so an
        account that is switched off stops working immediately rather than when its token expires.
      </p>

      {form && (
        <UserForm
          // Remounts the form when a different row is opened, so it starts from
          // that account's values rather than the previous one's.
          key={form.id ?? 'new'}
          initial={form}
          screens={screens}
          roles={roles}
          departments={departments}
          locations={locations}
          isSelf={form.id === me?.id}
          saving={saving}
          error={formError}
          onSave={saveUser}
          onClose={() => setForm(null)}
        />
      )}

      {resetting && (
        <PasswordForm
          user={resetting}
          saving={saving}
          error={formError}
          onSave={savePassword}
          onClose={() => setResetting(null)}
        />
      )}
    </>
  );
}
