import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import Sheet from '../components/Sheet.jsx';
import Loading from '../components/Loading.jsx';
import { IconPencil, IconPlus, IconTrash } from '../components/icons.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import { useAuth } from '../context/AuthContext.jsx';

/**
 * Branches, as configured.
 *
 * A branch is one place that each file calls something different, and this
 * screen is where those names are written down side by side:
 *
 *   Branch code       the ageing report's DivisionCode        SE1
 *   Location          part of the GRN report's Location        SECUNDERABAD
 *   Location (BPAD)   the BPAD register's Location             SBD
 *   Account no.       the account its bank statement is for    59219911199911
 *
 * The tick box is the point of the screen. Ticking a branch narrows the results
 * and CS Department screens to its rows; untick everything and they show
 * everything, which is what they did before this screen existed.
 *
 * Location (BPAD) is the one field that acts on an upload rather than on what
 * is shown: filled in, a BPAD register uploaded afterwards keeps a row for one
 * of this branch's GRNs only when the row's Location is this -- so another
 * branch's bill carrying the same GRN number and vendor stays out. Left blank,
 * the register is matched on vendor code and GRN number alone, as before.
 *
 * Two things this screen deliberately does not do. The ticks do not touch an
 * upload: every row of every file is still stored and reconciled whatever is
 * ticked, so a branch can be ticked and unticked all day and nothing is lost.
 * And the ticks
 * are not personal -- they are settings for the installation, so two people
 * looking at the same figures are looking at the same rows. The lead paragraph
 * says so, because a tick box that quietly changes somebody else's screen is
 * one worth warning about.
 *
 * One setting here is not about a branch: the CSD steps switch in the page
 * head. It says whether a GRN the hospitals send to CSD still goes through the
 * CSD department's own stages before Accounts can mark it Received. Like the
 * ticks it is a setting for the installation rather than for one screen, and
 * it is the hospitals' alone -- OP Pharmacy has its own, on its own screen.
 * What it changes is the server's to say: services/csdSteps.js there.
 */

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

/** 1 -> "1 GRN", 12542 -> "12,542 GRNs". */
function grns(n) {
  return `${count(n)} GRN${n === 1 ? '' : 's'}`;
}

/**
 * The CSD steps switch on this screen is the hospitals'. What that comes to in
 * names: the side as the session knows it (csdOn in context/AuthContext.jsx),
 * their queue as the CS Department screen lists it, and the two screens
 * Accounts mark a GRN Received on.
 */
const CSD_SIDE = 'hospital';
const CSD_QUEUE = 'Hospital CSD';
const ACCOUNTS_SCREENS = 'Results and Accounts';

/**
 * What is asked before the CSD steps are switched off, as useConfirm takes it.
 *
 * `inFlight` is the server's count of the handovers standing at each point,
 * read as the question is put. Two figures get a paragraph each, and each is
 * left out when it would be about no GRN at all: the ones still with CSD --
 * sent, and not yet handed back, wherever CSD had got to with them -- which
 * Accounts can receive as they stand once the steps are off, and the ones CSD
 * turned down, which switching off does not hand to Accounts. A GRN CSD have
 * already handed back is in neither: Accounts can receive that one today.
 */
function switchOffQuestion({ queued, received, approved, rejected }) {
  const partWay = queued + received + approved;
  return {
    title: 'Switch the CSD steps off?',
    message: [
      'This applies to everyone using this installation, not only to this screen. ' +
        `The ${CSD_QUEUE} queue will be hidden, and CSD stages can no longer be recorded.`,
      partWay > 0 &&
        `${grns(partWay)} ${partWay === 1 ? 'is' : 'are'} with CSD right now. ` +
          `Accounts will be able to mark ${partWay === 1 ? 'it' : 'them'} Received directly.`,
      rejected > 0 &&
        `${grns(rejected)} that CSD rejected ${rejected === 1 ? 'stays' : 'stay'} rejected until an ` +
          `upload carries ${rejected === 1 ? 'it' : 'them'} again.`,
      'Nothing is deleted, and the steps can be switched on again.',
    ].filter(Boolean),
    confirmLabel: 'Switch off',
  };
}

/**
 * What is asked before the CSD steps are switched back on.
 *
 * The one figure here is the handovers CSD have not finished with: sent, not
 * rejected, not yet moved to accounts. Off, Accounts could receive those as
 * they stood; on, they wait in the queue for CSD's stages again. A GRN CSD
 * have already handed back is not among them -- it waits on Accounts either
 * way.
 */
function switchOnQuestion({ queued, received, approved }) {
  const waiting = queued + received + approved;
  return {
    title: 'Switch the CSD steps on?',
    message: [
      'This applies to everyone using this installation, not only to this screen. ' +
        `The ${CSD_QUEUE} queue comes back, and a GRN sent to CSD must again be Received, Approved ` +
        'and Moved to accounts by CSD before Accounts can receive it.',
      waiting > 0 &&
        `${grns(waiting)} sent to CSD and not yet received by Accounts will be waiting in the CSD queue.`,
      'GRNs already received by Accounts are unaffected.',
    ].filter(Boolean),
    confirmLabel: 'Switch on',
  };
}

/**
 * The add/edit panel.
 *
 * The four fields carry examples rather than descriptions. "DivisionCode from
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
            What this branch is called in each report. The code and the location are how its rows
            are recognised; the account number is how its bank statement is; the BPAD location is
            which register rows are its own.
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

          <div className="form-grid">
            <label className="field">
              <span className="field__label">Location (BPAD)</span>
              <input
                className="field__input"
                value={form.bpadLocation ?? ''}
                onChange={(e) => set({ bpadLocation: e.target.value })}
                placeholder="SBD"
                autoComplete="off"
              />
              {/* <span className="field__hint">
                Optional. The BPAD register&rsquo;s <strong>Location</strong> for this branch. Filled
                in, a register row is kept only when this matches too, not just the GRN number and
                vendor. Applies to registers uploaded from now on.
              </span> */}
            </label>

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
  // The CSD steps switch as the server last said it -- `{ enabled, inFlight }`,
  // null until it has answered -- and whether a change to it is in flight.
  const [csdSteps, setCsdSteps] = useState(null);
  const [csdBusy, setCsdBusy] = useState(false);
  // Whether a reading of the switch has failed. Until one succeeds the box is
  // left pressable for that reason alone: pressing it asks again, and switches
  // nothing -- see switchCsdSteps.
  const [csdUnread, setCsdUnread] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const { csdOn, refresh, noteCsdSteps } = useAuth();

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
   * Read the switch from the server: whether the steps are on, and how many
   * handovers stand where. The page opens with this, and asks again before a
   * change is put to the user, so the counts in that question are current.
   *
   * The session is told what came back -- see noteCsdSteps in
   * context/AuthContext.jsx. The sidebar goes by the session, and this is how
   * it hears of a switch somebody else threw while this tab stayed open. The
   * session is only asked for again where the two disagree.
   */
  async function readCsdSteps() {
    const answer = await api.csdSteps();
    setCsdSteps(answer);
    noteCsdSteps(CSD_SIDE, answer.enabled);
    return answer;
  }

  // As the page opens -- and on its own rather than with the branches: if the
  // switch cannot be read, the page's error says why, the rest of the page
  // works as it did, and pressing the box asks for it again.
  //
  // And again whenever the session's view of the switch changes. Somebody else
  // may throw it while this page is open; the session hears of that when the
  // tab is next looked at, and the box and the sentence under it should not go
  // on saying what was true before. It costs one more read after a change made
  // here, which brings the same answer.
  const sessionStepsOn = csdOn[CSD_SIDE];
  useEffect(() => {
    readCsdSteps()
      .then(() => setCsdUnread(false))
      .catch((err) => {
        setError(err.message);
        setCsdUnread(true);
      });
  }, [sessionStepsOn]);

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
          bpadLocation: values.bpadLocation,
          accountNo: values.accountNo,
          isSelected: values.isSelected,
        });
      } else {
        await api.updateBranch(values.id, {
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
      await api.deleteBranch(row.id);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  /**
   * Switch the CSD steps on or off.
   *
   * Asked first, in both directions. A branch tick changes what people see;
   * this changes what they can do with a GRN, on other screens and for
   * everyone, so it is not something to throw with a stray click.
   *
   * The box is never ahead of the server: it shows what was last answered, so
   * a refusal, or a change of mind at the question, leaves it where it was.
   */
  async function switchCsdSteps() {
    // Not read yet: the reading failed, and the box was left pressable so it
    // could be asked for again. That is all this press does -- nothing is
    // switched by somebody who has not been shown how it stands.
    if (!csdSteps) {
      setCsdBusy(true);
      setError('');
      try {
        await readCsdSteps();
        setCsdUnread(false);
      } catch (err) {
        setError(err.message);
      } finally {
        setCsdBusy(false);
      }
      return;
    }

    // The other way from how the box stood when it was pressed. Worked out
    // before the switch is read again, because that reading may differ.
    const enabled = !csdSteps.enabled;
    setCsdBusy(true);
    setError('');
    try {
      const current = await readCsdSteps();
      // Somebody else has thrown it since this page last read it. The box says
      // so now, and there is nothing left to ask.
      if (current.enabled === enabled) return;

      const ok = await confirm(
        enabled ? switchOnQuestion(current.inFlight) : switchOffQuestion(current.inFlight),
      );
      if (!ok) return;

      setCsdSteps(await api.setCsdSteps(enabled));
      // The session again, so the sidebar's CS Department link follows now
      // rather than when the tab is next looked at.
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setCsdBusy(false);
    }
  }

  const selected = branches.filter((b) => b.isSelected);
  // What the switch's box shows: the switch as read, and until it has been,
  // the session's word for it -- which is what the sidebar is going by.
  const stepsOn = csdSteps ? csdSteps.enabled : csdOn[CSD_SIDE];

  return (
    <>
      {confirmDialog}
      <div className="page__head page__head--row">
        <div>
          <h2 className="page__title">Configuration</h2>
        {/*  <p className="page__lead">
            What each branch is called in each report, and which branches the figures are
            narrowed to. These ticks apply to everyone — they are settings for this installation,
            not for your own screen.
          </p> */}
        </div>
        <div className="page__actions">
          {/* The CSD steps switch: ticked is on. The box shows what the server
              last said -- pressing it asks first and waits for the answer, see
              switchCsdSteps -- and is quiet until the switch has been read and
              while a change to it is in flight. Where the reading failed it is
              left pressable, and pressing it reads again. */}
          <label
            className="tick"
            title={
              !csdSteps && csdUnread
                ? 'The CSD steps switch could not be read — press to try again'
                : `Whether a GRN sent to CSD goes through the ${CSD_QUEUE} queue before Accounts can mark it ` +
                  'Received — applies to everyone, and asks before it changes'
            }
          >
            <input
              type="checkbox"
              checked={stepsOn}
              disabled={csdBusy || (!csdSteps && !csdUnread)}
              onChange={switchCsdSteps}
            />
            <span className="tick__text">{stepsOn ? 'CSD steps on' : 'CSD steps off'}</span>
          </label>
          <button className="primary" type="button" onClick={() => setForm(BLANK)}>
            <span className="csd__icon">
              <IconPlus size={15} />
            </span>
            New branch
          </button>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {/* What the CSD steps switch means as it stands, said in words -- once it
          has been read. As with the ticks below: the box is the setting, and
          this is its effect. */}
      {csdSteps && (
        <div className="alert alert--info">
          {csdSteps.enabled ? (
            <>
              <strong>CSD steps are on.</strong> A GRN sent to CSD goes through the CS Department
              queue — Received, Approved or Rejected, Moved to accounts — before Accounts can mark it
              Received.
            </>
          ) : (
            <>
              <strong>CSD steps are off.</strong> The {CSD_QUEUE} queue is hidden and CSD stages are
              not recorded. After Send to CSD, Accounts mark a GRN Received directly on the{' '}
              {ACCOUNTS_SCREENS} screens. Nothing has been deleted — switch the steps on to bring the
              queue back.
            </>
          )}
        </div>
      )}

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
        <Loading />
      ) : (
        <div className="table-wrap table-wrap--sticky">
          <table className="table">
            <thead>
              <tr>
                <th>In scope</th>
                <th>Branch code</th>
                <th>Location</th>
                <th>Location (BPAD)</th>
                <th>Account number</th>
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
