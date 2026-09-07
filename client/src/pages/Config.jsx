import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import Sheet from '../components/Sheet.jsx';
import { IconPencil, IconPlus, IconTrash } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';

/**
 * Branches, as configured.
 *
 * A branch is one place that three files each call something different, and
 * this screen is where the three names are written down side by side:
 *
 *   Branch code   the ageing report's DivisionCode        SE1
 *   Location      part of the GRN report's Location        SECUNDERABAD
 *   Account no.   the account its bank statement is for    59219911199911
 *
 * The tick box is the point of the screen. Ticking a branch narrows the results
 * and CS Department screens to its rows; untick everything and they show
 * everything, which is what they did before this screen existed.
 *
 * Two things this screen deliberately does not do. It does not touch an upload:
 * every row of every file is still stored and reconciled whatever is ticked, so
 * a branch can be ticked and unticked all day and nothing is lost. And the ticks
 * are not personal -- they are settings for the installation, so two people
 * looking at the same figures are looking at the same rows. The lead paragraph
 * says so, because a tick box that quietly changes somebody else's screen is
 * one worth warning about.
 */

const BLANK = { id: null, branchCode: '', location: '', accountNo: '', isSelected: false };

/**
 * The add/edit panel.
 *
 * The three fields carry examples rather than descriptions. "DivisionCode from
 * the ageing report" tells somebody who already knows; "SE1" tells somebody
 * looking at the file.
 */
function BranchForm({ initial, saving, error, onSave, onClose }) {
  const [form, setForm] = useState(initial);
  const editing = initial.id !== null;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Sheet label={editing ? 'Edit branch' : 'New branch'} onClose={onClose}>
      <form
        className="sheet__form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(form);
        }}
      >
        <div className="sheet__head">
          <h2>{editing ? `Edit ${initial.branchCode}` : 'New branch'}</h2>
          {/* <p className="sheet__lead">
            What this branch is called in each of the three reports. The code and the location are
            how its rows are recognised; the account number is how its bank statement is.
          </p> */}
        </div>

        <div className="sheet__body">
          {error && <div className="alert alert--error">{error}</div>}

          <div className="form-grid">
            <label className="field">
              <span className="field__label">Branch code</span>
              <input
                className="field__input"
                value={form.branchCode}
                onChange={(e) => set({ branchCode: e.target.value })}
                placeholder="SE1"
                autoComplete="off"
                required
              />
              {/* <span className="field__hint">
                The ageing report&rsquo;s <strong>DivisionCode</strong>, matched exactly.
              </span> */}
            </label>

            <label className="field">
              <span className="field__label">Location</span>
              <input
                className="field__input"
                value={form.location}
                onChange={(e) => set({ location: e.target.value })}
                placeholder="SECUNDERABAD"
                autoComplete="off"
                required
              />
              {/* <span className="field__hint">
                Enough of the GRN report&rsquo;s <strong>Location</strong> to identify this branch.
                A row matches when its Location contains this.
              </span> */}
            </label>
          </div>

          <label className="field">
            <span className="field__label">Account number</span>
            <input
              className="field__input"
              value={form.accountNo ?? ''}
              onChange={(e) => set({ accountNo: e.target.value })}
              placeholder="59219911199911"
              autoComplete="off"
              inputMode="numeric"
            />
            {/* <span className="field__hint">
              Optional. Read from the bank statement&rsquo;s letterhead. Filled in, only that
              account&rsquo;s statements decide whether this branch&rsquo;s cheques cleared; left
              blank, every uploaded statement counts, as before.
            </span> */}
          </label>
        </div>

        <div className="sheet__foot">
          <button type="button" className="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add branch'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export default function Config() {
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  // Which branch's tick box is in flight, so only its own row goes quiet.
  const [busy, setBusy] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(() => {
    setLoading(true);
    api
      .listBranches()
      .then(({ branches: list }) => setBranches(list))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  /**
   * Tick or untick one branch.
   *
   * The row is updated in place rather than by reloading the list: the list is
   * ordered ticked-first, so a reload would make the row jump out from under
   * the pointer at the moment it was clicked.
   */
  async function toggle(row) {
    setBusy(row.id);
    setError('');
    try {
      const { branch } = await api.updateBranch(row.id, { isSelected: !row.isSelected });
      setBranches((list) => list.map((b) => (b.id === branch.id ? branch : b)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function save(values) {
    setSaving(true);
    setFormError('');
    try {
      if (values.id === null) {
        await api.createBranch({
          branchCode: values.branchCode,
          location: values.location,
          accountNo: values.accountNo,
          isSelected: values.isSelected,
        });
      } else {
        await api.updateBranch(values.id, {
          branchCode: values.branchCode,
          location: values.location,
          accountNo: values.accountNo,
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

  async function remove(row) {
    const ok = await confirm({
      title: 'Remove this branch?',
      message: `Are you sure you want to remove ${row.branchCode}?`,
      confirmLabel: 'Remove branch',
    });
    if (!ok) return;
    setError('');
    try {
      await api.deleteBranch(row.id);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const selected = branches.filter((b) => b.isSelected);

  return (
    <>
      {confirmDialog}
      <div className="page__head page__head--row">
        <div>
          <h2 className="page__title">Configuration</h2>
          <p className="page__lead">
            What each branch is called in the three reports, and which branches the figures are
            narrowed to. These ticks apply to everyone — they are settings for this installation,
            not for your own screen.
          </p>
        </div>
        <div className="page__actions">
          <button className="primary" type="button" onClick={() => setForm(BLANK)}>
            <span className="csd__icon">
              <IconPlus size={15} />
            </span>
            New branch
          </button>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {/* What the ticks currently mean, said in words. A row of tick boxes is
          the setting; this is its effect, which is the part worth reading. */}
      <div className="alert alert--info">
        {branches.length === 0 ? (
          <>
            <strong>No branches configured.</strong> The results and CS Department screens show
            every row. Add a branch to be able to narrow them.
          </>
        ) : selected.length === 0 ? (
          <>
            <strong>Nothing is ticked.</strong> The results and CS Department screens show every
            row, whichever branch it belongs to.
          </>
        ) : (
          <>
            <strong>
              Showing {selected.map((b) => b.branchCode).join(', ')} only.
            </strong>{' '}
            The results and CS Department screens are narrowed to{' '}
            {selected.length === 1 ? 'this branch' : 'these branches'}. Nothing has been deleted —
            untick to see everything again.
          </>
        )}
      </div>

      {loading && branches.length === 0 ? (
        <div className="loading">Loading…</div>
      ) : (
        <div className="table-wrap table-wrap--sticky">
          <table className="table">
            <thead>
              <tr>
                <th>In scope</th>
                <th>Branch code</th>
                <th>Location</th>
                <th>Account number</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {branches.length === 0 && (
                <tr>
                  <td className="table__empty" colSpan={5}>
                    No branches yet
                  </td>
                </tr>
              )}
              {branches.map((row) => (
                <tr key={row.id} className={row.isSelected ? 'is-scoped' : undefined}>
                  <td>
                    <label className="tick">
                      <input
                        type="checkbox"
                        checked={row.isSelected}
                        disabled={busy === row.id}
                        onChange={() => toggle(row)}
                      />
                      <span className="tick__text">{row.isSelected ? 'In scope' : 'Not applied'}</span>
                    </label>
                  </td>
                  <td className="table__mono">{row.branchCode}</td>
                  <td>{row.location}</td>
                  <td className="table__mono">
                    {row.accountNo || <span className="table__miss">&mdash;</span>}
                  </td>
                  <td>
                    <div className="row-actions row-actions--inline">
                      <button
                        type="button"
                        className="ghost ghost--sm"
                        onClick={() => setForm({ ...row, accountNo: row.accountNo ?? '' })}
                        title={`Edit ${row.branchCode}`}
                      >
                        <IconPencil size={13} /> Edit
                      </button>
                      <button
                        type="button"
                        className="ghost ghost--sm danger"
                        onClick={() => remove(row)}
                        title={`Remove ${row.branchCode}`}
                      >
                        <IconTrash size={13} /> Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form && (
        <BranchForm
          initial={form}
          saving={saving}
          error={formError}
          onSave={save}
          onClose={() => {
            setForm(null);
            setFormError('');
          }}
        />
      )}
    </>
  );
}
