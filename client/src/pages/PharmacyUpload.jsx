import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import FileDrop, { readableSize } from '../components/FileDrop.jsx';
import { IconAlert, IconArrowRight, IconCheck } from '../components/icons.jsx';

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
 * The hospital upload goes straight to its results screen, which is where its
 * outcome is read. Pharmacy Results is not built yet, so this is the only
 * place the outcome of a pharmacy upload can be shown -- and "it went through"
 * is not enough of one: the figures are what say the right files went into the
 * right boxes.
 */
function storedLines(done) {
  const lines = [];
  const { linked } = done;
  const touched = linked.MATCHED + linked.MATCHED_WITH_DIFF + linked.PENDING;

  if (done.grnRowCount > 0) lines.push(`GRN Purchase report: ${count(done.grnRowCount)} GRNs.`);
  if (done.ageingRowCount > 0) lines.push(`Vendor Age report: ${count(done.ageingRowCount)} rows.`);
  // Either report can touch a GRN -- an ageing report on its own reconciles
  // the GRNs already on file -- so this is not tied to the GRN report's line.
  if (touched > 0) {
    lines.push(
      `${count(touched)} GRNs reconciled: ${count(linked.MATCHED)} in accounts, ` +
        `${count(linked.MATCHED_WITH_DIFF)} in accounts under a different bill number, ` +
        `${count(linked.PENDING)} pending.`,
    );
  } else if (done.ageingRowCount > 0) {
    lines.push('No GRN Purchase report is on file yet, so nothing was reconciled.');
  }
  if (done.bpadRowCount > 0) {
    const missing = done.bpadStoredCount - done.bpadMatchedCount;
    lines.push(
      `BPAD bill status: ${count(done.bpadMatchedCount)} of ${count(done.bpadRowCount)} rows matched a GRN` +
        (missing > 0 ? `; ${count(missing)} GRNs have no entry in it.` : '.') +
        (done.bpadOtherBranchCount > 0
          ? ` ${count(done.bpadOtherBranchCount)} rows named another branch's Location and were left out.`
          : ''),
    );
  }
  // What Ph-Configuration could not place. A GRN is matched to the other two
  // reports only through a configured branch, so each of these is something
  // stored that will read as unmatched until the branch is added -- worth
  // saying beside the figures, or "pending" would be taken at its word.
  if (done.grnUnconfiguredCount > 0) {
    const units = (done.grnUnconfiguredUnits ?? []).map((u) => u || '(blank)').join(', ');
    lines.push(
      `${count(done.grnUnconfiguredCount)} GRNs have a Unit Name (${units}) with no branch on Ph-Configuration, ` +
        'so they stay pending until one is added.',
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
  if (done.bankRowCount > 0) {
    lines.push(
      `Bank statement: ${count(done.bankRowCount)} transactions` +
        (done.bankAccountNo ? `, account ${done.bankAccountNo}.` : '.'),
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
            hint="Matched to the GRN Purchase report by vendor code, GRN number, and the branch's unit and location on Ph-Configuration."
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
              <strong>Stored.</strong> {storedLines(done).join(' ')}
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
