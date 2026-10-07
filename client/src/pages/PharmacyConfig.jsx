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

/** 12542 -> "12,542". */
function count(n) {
  return Number(n ?? 0).toLocaleString('en-IN');
}

/**
 * What saving or removing a branch did to the GRNs already uploaded, as the
 * server reports it (`relinked`) -- or '' when it re-matched nothing because
 * the change could not affect a match, or because nothing is on file.
 *
 * Said on the page rather than left to be discovered: a branch is what ties a
 * GRN to its Vendor Age row, so correcting one can move every GRN on file from
 * pending to matched, and removing one can move them all back.
 */
function rematchNotice(relinked) {
  if (!relinked) return '';
  const { MATCHED = 0, MATCHED_WITH_DIFF = 0, PENDING = 0 } = relinked.linked ?? {};
  const total = MATCHED + MATCHED_WITH_DIFF + PENDING;
  if (total === 0) return '';
  const what =
    relinked.changed > 0
      ? `${count(relinked.changed)} of the ${count(total)} GRNs on file were re-matched to the Vendor Age report.`
      : `The ${count(total)} GRNs on file are matched as they were.`;
  // What the Vendor Age report has, not "in accounts": a GRN is in Accounts
  // only while the BPAD bill status also has its bill at Accounts' desk, which
  // is Pharmacy Results' to say (BEFORE_ACCOUNTS in routes/phResults.js).
  return (
    `${what} Now: ${count(MATCHED)} found in it, ${count(MATCHED_WITH_DIFF)} found under a different ` +
    `bill number, ${count(PENDING)} not found.`
  );
}

/** The add/edit panel. The source of each field is its tooltip. */
function BranchForm({ initial, saving, error, onSave, onClose }) {
  const [form, setForm] = useState(initial);
  const editing = initial.id !== null;
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  return (
    /* Escape does nothing while a save is in flight, as the Cancel button does
       nothing: a save here can wait on an upload and take a while, and a panel
       closed under it would leave its answer -- or its error -- to land on
       whatever was opened next. */
    <Sheet label={editing ? 'Edit branch' : 'New branch'} onClose={saving ? () => {} : onClose}>
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
  // Whether the list has ever arrived. Until it has, an empty list is not "no
  // branches configured" -- it is not known yet, or the request failed.
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  // The branches whose tick box or removal is in flight, so each one's own row
  // goes quiet -- and cannot be acted on a second time while the first is
  // waiting. A set: two rows can be in flight at once, and the first to answer
  // must not wake the other.
  const [busy, setBusy] = useState(() => new Set());
  // What the last save or removal did to the GRNs on file -- see rematchNotice.
  const [notice, setNotice] = useState('');
  const [confirm, confirmDialog] = useConfirm();

  const markBusy = (id, on) =>
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const load = useCallback(() => {
    setLoading(true);
    api
      .phListBranches()
      .then(({ branches: list }) => {
        setBranches(list);
        setLoaded(true);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  /** Open the add/edit panel clean: the last panel's error is not this one's. */
  function openForm(values) {
    setFormError('');
    setForm(values);
  }

  /**
   * Tick or untick one branch. Updated in place rather than by reloading: the
   * list is ordered ticked-first, so a reload would make the row jump out from
   * under the pointer at the moment it was clicked.
   */
  async function toggle(row) {
    markBusy(row.id, true);
    setError('');
    setNotice('');
    try {
      const { branch } = await api.phUpdateBranch(row.id, { isSelected: !row.isSelected });
      setBranches((list) => list.map((b) => (b.id === branch.id ? branch : b)));
    } catch (err) {
      setError(err.message);
    } finally {
      markBusy(row.id, false);
    }
  }

  async function save(values) {
    setSaving(true);
    setFormError('');
    try {
      const answer =
        values.id === null
          ? await api.phCreateBranch({
              branchCode: values.branchCode,
              location: values.location,
              bpadLocation: values.bpadLocation,
              accountNo: values.accountNo,
              isSelected: values.isSelected,
            })
          : await api.phUpdateBranch(values.id, {
              branchCode: values.branchCode,
              location: values.location,
              bpadLocation: values.bpadLocation,
              accountNo: values.accountNo,
            });
      setForm(null);
      // The page's own error is about an earlier action, and this one worked.
      setError('');
      setNotice(rematchNotice(answer?.relinked));
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
      // The second paragraph is what removing one does here and not on the
      // hospital screen: it is what the GRNs were matched through.
      message: [
        `Are you sure you want to remove ${row.branchCode}?`,
        'GRNs matched to the Vendor Age report through this branch go back to pending. Nothing uploaded is deleted, and adding the branch again matches them again.',
      ],
      confirmLabel: 'Remove branch',
    });
    if (!ok) return;
    markBusy(row.id, true);
    setError('');
    setNotice('');
    try {
      const answer = await api.phDeleteBranch(row.id);
      setNotice(rematchNotice(answer?.relinked));
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      markBusy(row.id, false);
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
          <button className="primary" type="button" onClick={() => openForm(BLANK)}>
            <span className="csd__icon">
              <IconPlus size={15} />
            </span>
            New branch
          </button>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--info">{notice}</div>}

      {/* What the ticks currently mean, said in words -- once the list is in. */}
      {loaded && (
        <div className="alert alert--info">
          {branches.length === 0 ? (
            /* Not the hospital screen's "shows every row": with no branch here,
               nothing is matched at all. */
            <>
              <strong>No branches configured.</strong> No GRN can be matched to the Vendor Age
              report or the BPAD file until a branch is added, and an upload carrying either is
              refused.
            </>
          ) : selected.length === 0 ? (
            <>
              <strong>Nothing is ticked.</strong> The pharmacy figures cover every row, whichever
              branch it belongs to.
            </>
          ) : (
            <>
              <strong>In scope: {selected.map((b) => b.branchCode).join(', ')} only.</strong> The
              pharmacy figures are narrowed to{' '}
              {selected.length === 1 ? 'this branch' : 'these branches'}. Nothing has been deleted —
              untick to see everything again.
            </>
          )}
        </div>
      )}

      {!loaded ? (
        /* Not an empty table: the list has not arrived, or could not be read --
           and the error above says which. */
        loading && <div className="loading">Loading…</div>
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
                        disabled={busy.has(row.id)}
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
                        disabled={busy.has(row.id)}
                        onClick={() =>
                          openForm({
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
                        disabled={busy.has(row.id)}
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
