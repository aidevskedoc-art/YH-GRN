import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import Sheet from '../components/Sheet.jsx';
import { IconPencil, IconPlus, IconTrash } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import { OP_PHARMACY_LABELS } from '../services/screens.js';

/**
 * Pharmacy branches, as configured: the Configuration screen (pages/Config.jsx)
 * for OP Pharmacy.
 *
 * The same four names and the same tick box, against the pharmacies' own
 * reports -- each column's caption says which system the name comes from, and
 * FIELDS below says which column of which file:
 *
 *   Branch code (Focus)   the Vendor Age report's DivisionCode        PSE
 *   Unit name (HIS)       the GRN Purchase report's Unit Name          Secunderabad
 *   Location (BPAD)       the BPAD current bill status's Location      SBD1
 *   Account number        the account its bank statement is for        99995542441111
 *
 * The tick box works as the hospital screen's does: it says which branches the
 * pharmacy figures are narrowed to, for everyone, and touches no upload.
 *
 * The three names do more here than on the hospital screen: they are how the
 * three reports are tied to one another. A GRN is matched to a Vendor Age row
 * only when the row's DivisionCode and the GRN's Unit Name are one branch's
 * Branch code and Unit name here, and to a BPAD row only when the row's
 * Location is that branch's Location (BPAD) too. A unit that is not listed
 * has its GRNs matched to neither report, and one listed without a Location
 * (BPAD) has them matched to no BPAD row -- see server/src/routes/phBatches.js.
 * The lead paragraph says so, because a blank that stops a file from matching
 * is worth knowing about before the upload rather than after.
 *
 * Saving a branch therefore changes what is matched, and the server re-matches
 * the GRNs already uploaded to the Vendor Age rows as it saves (see
 * server/src/routes/phConfig.js) -- which is why adding or correcting a branch
 * can take a moment longer than a tick. The BPAD file is matched as it is
 * read, so that side follows a change only when the file is uploaded again.
 *
 * The unit name travels as `location`, the hospital screen's name for the same
 * field: the two screens send and receive the same shapes (see
 * server/src/routes/phConfig.js).
 */

/** Each field's caption, an example to type, and where its value is found. */
const FIELDS = {
  branchCode: {
    label: 'Branch code (Focus)',
    placeholder: 'PSE',
    source: 'DivisionCode in the Vendor Age report',
  },
  location: {
    label: 'Unit name (HIS)',
    placeholder: 'Secunderabad',
    source: 'Unit Name in the GRN Purchase report',
  },
  bpadLocation: {
    label: 'Location (BPAD)',
    placeholder: 'SBD1',
    source: 'Location in the BPAD current bill status',
  },
  accountNo: {
    label: 'Account number',
    placeholder: '99995542441111',
    source: 'Account No in the bank statement',
  },
};

const BLANK = {
  id: null,
  branchCode: '',
  location: '',
  bpadLocation: '',
  accountNo: '',
  isSelected: false,
};

/** The add/edit panel. The source of each field is its tooltip. */
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
        </div>

        <div className="sheet__body">
          {error && <div className="alert alert--error">{error}</div>}

          <div className="form-grid">
            <label className="field" title={FIELDS.branchCode.source}>
              <span className="field__label">{FIELDS.branchCode.label}</span>
              <input
                className="field__input"
                value={form.branchCode}
                onChange={(e) => set({ branchCode: e.target.value })}
                placeholder={FIELDS.branchCode.placeholder}
                autoComplete="off"
                required
              />
            </label>

            <label className="field" title={FIELDS.location.source}>
              <span className="field__label">{FIELDS.location.label}</span>
              <input
                className="field__input"
                value={form.location}
                onChange={(e) => set({ location: e.target.value })}
                placeholder={FIELDS.location.placeholder}
                autoComplete="off"
                required
              />
            </label>
          </div>

          <div className="form-grid">
            <label className="field" title={FIELDS.bpadLocation.source}>
              <span className="field__label">{FIELDS.bpadLocation.label}</span>
              <input
                className="field__input"
                value={form.bpadLocation ?? ''}
                onChange={(e) => set({ bpadLocation: e.target.value })}
                placeholder={FIELDS.bpadLocation.placeholder}
                autoComplete="off"
              />
            </label>

            <label className="field" title={FIELDS.accountNo.source}>
              <span className="field__label">{FIELDS.accountNo.label}</span>
              <input
                className="field__input"
                value={form.accountNo ?? ''}
                onChange={(e) => set({ accountNo: e.target.value })}
                placeholder={FIELDS.accountNo.placeholder}
                autoComplete="off"
                inputMode="numeric"
              />
            </label>
          </div>
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

export default function PharmacyConfig() {
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
      .phListBranches()
      .then(({ branches: list }) => setBranches(list))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  /**
   * Tick or untick one branch. Updated in place rather than by reloading: the
   * list is ordered ticked-first, so a reload would make the row jump out from
   * under the pointer at the moment it was clicked.
   */
  async function toggle(row) {
    setBusy(row.id);
    setError('');
    try {
      const { branch } = await api.phUpdateBranch(row.id, { isSelected: !row.isSelected });
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
        await api.phCreateBranch({
          branchCode: values.branchCode,
          location: values.location,
          bpadLocation: values.bpadLocation,
          accountNo: values.accountNo,
          isSelected: values.isSelected,
        });
      } else {
        await api.phUpdateBranch(values.id, {
          branchCode: values.branchCode,
          location: values.location,
          bpadLocation: values.bpadLocation,
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
      await api.phDeleteBranch(row.id);
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
          <h2 className="page__title">{OP_PHARMACY_LABELS.config}</h2>
          <p className="page__lead">
            What each pharmacy branch is called in each report, and which branches the pharmacy
            figures are narrowed to. These ticks apply to everyone — they are settings for this
            installation, not for your own screen. A GRN is matched to the Vendor Age report and
            the BPAD file only through a branch here: its Unit name must go with the report&rsquo;s
            DivisionCode as Branch code, and with the BPAD row&rsquo;s Location as Location (BPAD).
            Adding or correcting a branch re-matches the GRNs already uploaded; the BPAD file has to
            be uploaded again.
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

      {/* What the ticks currently mean, said in words. */}
      <div className="alert alert--info">
        {branches.length === 0 ? (
          <>
            <strong>No branches configured.</strong> The pharmacy figures cover every row. Add a
            branch to be able to narrow them.
          </>
        ) : selected.length === 0 ? (
          <>
            <strong>Nothing is ticked.</strong> The pharmacy figures cover every row, whichever
            branch it belongs to.
          </>
        ) : (
          <>
            <strong>In scope: {selected.map((b) => b.branchCode).join(', ')} only.</strong> The
            pharmacy figures are narrowed to {selected.length === 1 ? 'this branch' : 'these branches'}.
            Nothing has been deleted — untick to see everything again.
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
                <th title={FIELDS.branchCode.source}>{FIELDS.branchCode.label}</th>
                <th title={FIELDS.location.source}>{FIELDS.location.label}</th>
                <th title={FIELDS.bpadLocation.source}>{FIELDS.bpadLocation.label}</th>
                <th title={FIELDS.accountNo.source}>{FIELDS.accountNo.label}</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {branches.length === 0 && (
                <tr>
                  <td className="table__empty" colSpan={6}>
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
                    {row.bpadLocation || <span className="table__miss">&mdash;</span>}
                  </td>
                  <td className="table__mono">
                    {row.accountNo || <span className="table__miss">&mdash;</span>}
                  </td>
                  <td>
                    <div className="row-actions row-actions--inline">
                      <button
                        type="button"
                        className="ghost ghost--sm"
                        onClick={() =>
                          setForm({
                            ...row,
                            accountNo: row.accountNo ?? '',
                            bpadLocation: row.bpadLocation ?? '',
                          })
                        }
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
