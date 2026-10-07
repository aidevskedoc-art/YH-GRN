import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import FileDrop, { readableSize } from '../components/FileDrop.jsx';
import { IconAlert, IconArrowRight, IconCheck } from '../components/icons.jsx';
import { OP_PHARMACY_LABELS, opPharmacyPath } from '../services/screens.js';

/** "GRN report" for one file, "3 GRN reports" for several. */
function several(files, noun) {
  return files.length > 1 ? `${files.length} ${noun}s` : noun;
}

/** 12542 -> "12,542", grouped the way the reports themselves write a figure. */
function count(n) {
  return Number(n ?? 0).toLocaleString('en-IN');
}

/**
 * What an upload stored, a sentence per file it brought.
 *
 * The hospital upload goes straight to its results screen. This one stays put
 * and says what it stored first, with the way on to Pharmacy Results beside
 * it: an upload here can leave GRNs unmatched for want of a branch on
 * Ph-Configuration, and the results screen would show those as plain pending
 * with nothing to say why. The figures are also what say the right files went
 * into the right boxes.
 */
function storedLines(done) {
  const lines = [];
  const { linked } = done;
  const touched = linked.MATCHED + linked.MATCHED_WITH_DIFF + linked.PENDING;

  if (done.grnRowCount > 0) lines.push(`GRN Purchase report: ${count(done.grnRowCount)} GRNs.`);
  if (done.ageingRowCount > 0) lines.push(`Vendor Age report: ${count(done.ageingRowCount)} rows.`);
  // Either report can touch a GRN -- an ageing report on its own reconciles
  // the GRNs already on file -- so this is not tied to the GRN report's line.
  // Worded as what was found in the report, not as "in accounts": a GRN the
  // report lists is in Accounts only while the BPAD bill status has its bill
  // at Accounts' desk -- BPAD is matched first (see BEFORE_ACCOUNTS in
  // server/src/routes/phResults.js) -- and where each GRN stands is Pharmacy
  // Results' to say.
  if (touched > 0) {
    lines.push(
      `${count(touched)} GRNs compared with the Vendor Age report: ${count(linked.MATCHED)} found, ` +
        `${count(linked.MATCHED_WITH_DIFF)} found under a different bill number, ` +
        `${count(linked.PENDING)} not found.`,
    );
  } else if (done.ageingRowCount > 0) {
    // Not "no GRN report is on file": there may be one, about other GRNs.
    lines.push('None of the GRNs this report names is on file yet, so nothing was reconciled.');
  }
  if (done.bpadRowCount > 0) {
    // Both figures as the server counted them -- the kept rows once per GRN
    // however many files named it. Subtracting stored from matched here is
    // only right for a single file.
    const noEntry = done.bpadNoEntryCount ?? 0;
    lines.push(
      `BPAD bill status: ${count(done.bpadRowCount)} rows read, ${count(done.bpadMatchedCount)} matched to a GRN` +
        (noEntry > 0
          ? `; ${count(noEntry)} GRNs have no entry in it, and are pending at the GRN store until it has them.`
          : '.') +
        ' Only the bills it has at Accounts are compared with the Vendor Age report for the Accounts section.' +
        (done.bpadOtherBranchCount > 0
          ? ` ${count(done.bpadOtherBranchCount)} rows named another branch's Location and were left out.`
          : ''),
    );
  }
  // What Ph-Configuration could not place. A GRN is matched to the other two
  // reports only through a configured branch, so each of these is something
  // stored that will read as unmatched until the branch is put right -- worth
  // saying beside the figures, or "pending" would be taken at its word.
  //
  // First the GRNs that look to have a Vendor Age row and be pending only for
  // want of a branch pairing the row's DivisionCode with their Unit Name. The
  // server reads this off what is stored, so it covers a GRN uploaded earlier
  // and a pair of branches entered with their codes crossed, which the two
  // counts after it cannot see.
  //
  // "Look to", and worded as a question: a GRN number is shared between units,
  // so a row under the number is this GRN's only if that division IS this
  // unit. The server leaves out the rows another unit's GRN is matched to, and
  // what is left is for whoever knows the branches to say.
  const unpaired = done.unpaired ?? { grnCount: 0, pairs: [] };
  if (unpaired.grnCount > 0) {
    const pairs = unpaired.pairs
      .slice(0, 3)
      .map((p) => `DivisionCode ${p.divisionCode || '(blank)'} with Unit Name ${p.unitName || '(blank)'}`)
      .join('; ');
    lines.push(
      `${count(unpaired.grnCount)} of the pending GRNs have a Vendor Age row under their GRN number that no ` +
        `branch on Ph-Configuration pairs with their unit: ${pairs}. If that division is that unit, add or ` +
        'correct the branch and they are matched at once.',
    );
  }
  // Said beside the line above, not instead of it: the two are different GRNs
  // as often as not -- a unit with no branch has its GRNs here whether or not
  // the Vendor Age report carries them.
  if (done.grnUnconfiguredCount > 0) {
    const names = done.grnUnconfiguredUnits ?? [];
    const units = names.map((u) => u || '(blank)').join(', ');
    lines.push(
      `${count(done.grnUnconfiguredCount)} GRNs have a Unit Name (${units}) with no branch on Ph-Configuration, ` +
        'so they stay pending until one is added.' +
        // A branch cannot be given a blank unit, so that promise is not theirs.
        (names.some((u) => !u) ? ' The ones with no Unit Name at all have no branch to be given, and stay pending.' : ''),
    );
  }
  if (done.ageingUnconfiguredRowCount > 0) {
    const codes = (done.ageingUnconfiguredDivisions ?? []).map((d) => d || '(blank)').join(', ');
    lines.push(
      `${count(done.ageingUnconfiguredRowCount)} Vendor Age rows have a DivisionCode (${codes}) with no branch on ` +
        'Ph-Configuration, so they are matched to no GRN until one is added.',
    );
  }
  // GRNs the BPAD file could not be matched for at all, because their Unit
  // Name has no Location (BPAD) on Ph-Configuration. Said whether or not any
  // row was passed over: what matters is that these GRNs have no BPAD answer.
  if (done.bpadUnconfiguredGrnCount > 0) {
    const units = (done.bpadUnconfiguredUnits ?? []).map((u) => u || '(blank)').join(', ');
    lines.push(
      `${count(done.bpadUnconfiguredGrnCount)} GRNs were not matched to the BPAD file: their Unit Name (${units}) ` +
        'has no branch with a Location (BPAD) on Ph-Configuration.',
    );
  }
  // GRNs of units the BPAD file does not cover at all -- it carries no row
  // under their Location. Left exactly as they were, which is worth saying:
  // "no entry" is an answer, and this is the absence of one.
  if (done.bpadNotCoveredGrnCount > 0) {
    const units = (done.bpadNotCoveredUnits ?? []).map((u) => u || '(blank)').join(', ');
    lines.push(
      `The BPAD file has no row under the Location of ${units}, so its ${count(done.bpadNotCoveredGrnCount)} GRNs ` +
        'were left as they were.',
    );
  }
  // GRNs from earlier uploads that this BPAD file does not list. It came with
  // a GRN Purchase report, so it says "no entry" for that report's GRNs only:
  // a file for one period is silent about another's bills, not denying them.
  if (done.bpadUnlistedGrnCount > 0) {
    lines.push(
      `${count(done.bpadUnlistedGrnCount)} GRNs from earlier uploads are not in this BPAD file, and were left as ` +
        'they were. To bring them up to date, upload the BPAD bill status that lists them — on its own, or with ' +
        'their GRN Purchase report.',
    );
  }
  // The others it does not list, whose unit had no BPAD status on file until
  // this upload: nothing was stored for them either, but BPAD is matched first
  // for their unit from now on -- so they are held at the GRN store, and "left
  // as they were" would not be true of them.
  if (done.bpadUnlistedNewlyHeldGrnCount > 0) {
    lines.push(
      `${count(done.bpadUnlistedNewlyHeldGrnCount)} GRNs from earlier uploads are not in this BPAD file, and it is ` +
        'the first BPAD bill status stored for their unit: with no BPAD entry on file they now read as pending at ' +
        'the GRN store, whatever the Vendor Age report says of them. To place them, upload the BPAD bill status ' +
        'that lists them — on its own, or with their GRN Purchase report.',
    );
  }
  // GRNs CSD had rejected that this upload carries again: taken back off the
  // CSD queue, as on the hospital side, so they can be sent round afresh.
  if (done.reopenedRejections > 0) {
    const n = done.reopenedRejections;
    lines.push(
      `${count(n)} GRN${n === 1 ? '' : 's'} CSD had rejected ${n === 1 ? 'is' : 'are'} in this upload again, and ` +
        `${n === 1 ? 'has' : 'have'} come back off the CSD queue to be sent afresh.`,
    );
  }
  if (done.bankRowCount > 0) {
    // Every statement's account, not the first one's beside the total of all.
    const accounts = [...new Set((done.bankAccountNos ?? [done.bankAccountNo]).filter(Boolean))];
    const statements = done.bankStatementCount ?? 1;
    lines.push(
      `${statements > 1 ? `${count(statements)} bank statements` : 'Bank statement'}: ` +
        `${count(done.bankRowCount)} transactions` +
        (accounts.length > 0 ? `, account${accounts.length > 1 ? 's' : ''} ${accounts.join(', ')}.` : '.'),
    );
  }
  return lines;
}

/**
 * Pharmacy Uploads: the New uploads screen (pages/Upload.jsx) for OP
 * Pharmacy's four files.
 *
 * The same four slots, in the same places, taking the same number of files
 * under the same caps, and every one optional in the same way. What differs is
 * which reports they are -- the pharmacy system's GRN Purchase report rather
 * than the GRN report, and the pharmacies' own ageing export, BPAD status and
 * statement -- and where they go: POST /api/op-pharmacy/batches stores them in
 * the pharmacies' own tables, so nothing uploaded here mixes with a hospital
 * upload.
 */
export default function PharmacyUpload() {
  const navigate = useNavigate();
  const { can } = useAuth();

  // All optional, and every one works uploaded on its own -- see Upload.jsx.
  // Each slot is a list: several months' reports go up in one upload.
  const [grnFiles, setGrnFiles] = useState([]);
  const [ageingFiles, setAgeingFiles] = useState([]);
  const [bankFiles, setBankFiles] = useState([]);
  const [bpadFiles, setBpadFiles] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The last upload's answer, shown until the next files are picked.
  const [done, setDone] = useState(null);
  // The server's caps, so a file it would refuse is refused as it is picked.
  // Null until they arrive, or if they never do.
  const [limits, setLimits] = useState(null);

  useEffect(() => {
    let live = true;
    api
      .phUploadLimits()
      .then((l) => live && setLimits(l))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Filled slots, not files: the dots are "GRN report in, ageing report in".
  const ready = [grnFiles, ageingFiles].filter((f) => f.length > 0).length;
  const total = grnFiles.length + ageingFiles.length + bankFiles.length + bpadFiles.length;

  const totalBytes = [...grnFiles, ...ageingFiles, ...bankFiles, ...bpadFiles].reduce(
    (sum, f) => sum + f.size,
    0,
  );
  const oversize =
    limits && totalBytes > limits.maxTotalBytes
      ? `These files come to ${readableSize(totalBytes)}, and one upload can carry at most ${readableSize(limits.maxTotalBytes)}. Remove some and upload them in a second go.`
      : '';
  const shownError = error || oversize;

  function pick(setter) {
    return (files) => {
      setError('');
      // A new pick is the start of the next upload; the last one's figures
      // beside it would read as though they were about these files.
      if (files.length > 0) setDone(null);
      setter(files);
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    if (total === 0) {
      setError(
        'Please choose at least one file: the GRN Purchase report, the Vendor Age report, the bank statement, or the BPAD bill status.',
      );
      return;
    }
    // Already on screen; sending it would only have the server say it again.
    if (oversize) return;

    // In the order each slot lists them, which the server reads as oldest
    // first: where two files carry the same GRN, the later one's rows are kept.
    const formData = new FormData();
    for (const f of grnFiles) formData.append('grnFile', f);
    for (const f of ageingFiles) formData.append('ageingFile', f);
    for (const f of bankFiles) formData.append('bankFile', f);
    for (const f of bpadFiles) formData.append('bpadFile', f);

    setBusy(true);
    setDone(null);
    try {
      const result = await api.phUploadBatch(formData);
      // Stored: the slots go back to empty, ready for the next files, and the
      // figures say what went in.
      setGrnFiles([]);
      setAgeingFiles([]);
      setBankFiles([]);
      setBpadFiles([]);
      setDone(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    /* The whole page on one screen, as the hospital upload is -- see
       .upload-page in styles.css. */
    <div className="upload-page">
      <form className="card upload" onSubmit={handleSubmit}>
        <div className="upload__rule">
          <span>The pharmacy reports</span>
        </div>

        {/* In the hospital screen's order, slot for slot: the GRN report and
            the BPAD file read against it, then the ageing report and the
            statement. */}
        <div className="drops">
          <FileDrop
            step={1}
            label="Pharmacy GRN Purchase Report"
            hint="The pharmacy purchase register. Without it, ageing rows have nothing to reconcile against yet."
            example="01. GRN Purchase.xlsx"
            multiple
            maxBytes={limits?.maxFileBytes}
            maxFiles={limits?.maxFilesPerSlot}
            files={grnFiles}
            onSelect={pick(setGrnFiles)}
            onReject={setError}
          />
          {/* .xls as well as .xlsx, unlike the hospitals' register: the
              pharmacies' status is a few megabytes and is exported as .xls. */}
          <FileDrop
            step={4}
            label="Pharmacy BPAD Bill Status — optional"
            hint="Matched to the GRN Purchase report by vendor code and GRN number, under the Location of the GRN's own unit on Ph-Configuration."
            example="02. BPAd current bill status.xls"
            multiple
            maxBytes={limits?.maxFileBytes}
            maxFiles={limits?.maxBpadFiles}
            files={bpadFiles}
            onSelect={pick(setBpadFiles)}
            onReject={setError}
          />

          <FileDrop
            step={2}
            label="Pharmacy Vendor Age Report"
            hint="The pharmacies' ageing export. Without it, every GRN shows as pending."
            example="00. Vendor Age report - Pharmacies.xlsx"
            multiple
            maxBytes={limits?.maxFileBytes}
            maxFiles={limits?.maxFilesPerSlot}
            files={ageingFiles}
            onSelect={pick(setAgeingFiles)}
            onReject={setError}
          />
          <FileDrop
            step={3}
            label="Pharmacy Bank Statement — optional"
            hint="Only the transaction table is read. Works uploaded on its own too."
            example="03. Bank Statement.xls"
            multiple
            maxBytes={limits?.maxFileBytes}
            maxFiles={limits?.maxFilesPerSlot}
            files={bankFiles}
            onSelect={pick(setBankFiles)}
            onReject={setError}
          />
        </div>

        {shownError && (
          <div className="alert alert--error alert--icon" role="alert">
            <IconAlert size={16} />
            <span>{shownError}</span>
          </div>
        )}

        {done && !shownError && (
          <div className="alert alert--info alert--icon" role="status">
            <IconCheck size={16} />
            <span>
              <strong>Stored.</strong> {storedLines(done).join(' ')}{' '}
              {can('results') && (
                <button type="button" className="ghost ghost--sm" onClick={() => navigate(opPharmacyPath('results'))}>
                  Open {OP_PHARMACY_LABELS.results} <IconArrowRight size={13} />
                </button>
              )}
            </span>
          </div>
        )}

        <div className="upload__foot">
          <p className="upload__ready">
            <span className={`readydots readydots--${ready}`} aria-hidden="true">
              <i />
              <i />
            </span>
            {ready === 2
              ? grnFiles.length === 1 && ageingFiles.length === 1
                ? 'Both reports ready'
                : `${several(grnFiles, 'GRN report')} and ${several(ageingFiles, 'ageing report')} ready`
              : grnFiles.length > 0
                ? `${several(grnFiles, 'GRN report')} ready — ageing report not included`
                : ageingFiles.length > 0
                  ? `${several(ageingFiles, 'Ageing report')} ready — GRN report not included, so it reconciles against the GRNs already uploaded`
                  : bankFiles.length > 0
                    ? `${several(bankFiles, 'Bank statement')} ready — no report included, so nothing reconciles yet`
                    : bpadFiles.length > 0
                      ? `${several(bpadFiles, 'BPAD status file')} ready — no GRN report included, so it matches against every GRN already uploaded`
                      : 'Choose the GRN Purchase report, the Vendor Age report, the bank statement or the BPAD bill status'}
            {bankFiles.length > 0 && ready > 0 && ` — ${several(bankFiles, 'bank statement')} included`}
            {bpadFiles.length > 0 && ready > 0 && ` — ${several(bpadFiles, 'BPAD status file')} included`}
          </p>

          {/* Live with a slot still empty, as on the hospital screen: a dead
              control cannot say why it is dead. */}
          <button className="primary upload__go" type="submit" disabled={busy}>
            {busy ? 'Reconciling…' : 'Upload and reconcile'}
            {!busy && <IconArrowRight size={16} />}
          </button>
        </div>

        {busy && (
          <div className="progress" role="status">
            <span className="progress__bar" />
            <p className="upload__note">
              {`Reading the workbook${total > 1 ? 's' : ''} and storing several thousand rows. This can take up to a minute.`}
            </p>
          </div>
        )}
      </form>
    </div>
  );
}
