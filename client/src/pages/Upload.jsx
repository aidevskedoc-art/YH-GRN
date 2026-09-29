import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import FileDrop, { readableSize } from '../components/FileDrop.jsx';
import { IconAlert, IconArrowRight } from '../components/icons.jsx';

/** "GRN report" for one file, "3 GRN reports" for several. */
function several(files, noun) {
  return files.length > 1 ? `${files.length} ${noun}s` : noun;
}

export default function Upload() {
  const navigate = useNavigate();

  // All three optional, and every one works uploaded on its own: a GRN report
  // with no ageing report reconciles as every row PENDING, an ageing report
  // with no GRN report has nothing to reconcile yet but is still stored for
  // the month -- uploading the GRN report later is what reconciles it -- and
  // a bank statement is stored and ready for its cheques to be matched
  // against whatever ageing rows exist, now or later. At least one of the
  // three is required; see the check below.
  //
  // Each slot is a list: several months' reports, or several banks'
  // statements, go up in one upload. The server merges each slot's files into
  // one set of rows, and stores every bank statement after the first as an
  // upload of its own -- see POST /api/batches.
  const [grnFiles, setGrnFiles] = useState([]);
  const [ageingFiles, setAgeingFiles] = useState([]);
  const [bankFiles, setBankFiles] = useState([]);
  // The BPAD register, and optional like the two beside it. Unlike them it is
  // the whole group's file rather than this installation's: only the rows
  // naming a GRN this upload is about are kept -- matched on the vendor code
  // and the GRN number together -- and the several hundred thousand others are
  // read past. Which GRNs those are depends on the slot beside it: the GRN
  // report's own rows when one is included, and every GRN ever uploaded when
  // one is not, so the register still works uploaded on its own.
  const [bpadFiles, setBpadFiles] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The server's caps (GET /api/batches/limits), so a file it would refuse is
  // refused as it is picked rather than after it has been sent. Null until
  // they arrive, or if they never do -- then nothing is checked here and the
  // server's own refusal is what the page shows.
  const [limits, setLimits] = useState(null);

  useEffect(() => {
    let live = true;
    api
      .uploadLimits()
      .then((l) => live && setLimits(l))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Filled slots, not files: the dots are "GRN report in, ageing report in".
  const ready = [grnFiles, ageingFiles].filter((f) => f.length > 0).length;
  const total = grnFiles.length + ageingFiles.length + bankFiles.length + bpadFiles.length;

  // The whole upload's size, against the one cap no single slot can check.
  // Derived rather than stored, so it clears itself the moment a file is
  // removed -- and shown as soon as it applies, not only once the button is
  // pressed.
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
      setter(files);
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    if (total === 0) {
      setError('Please choose at least one file: the GRN report, the Vendor Ageing report, the bank statement, or the BPAD register.');
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
    try {
      const { reopenedRejections = 0 } = await api.uploadBatch(formData);
      // The results page reports on every upload at once, so there is no
      // batch to point it at -- the one just made is already included.
      //
      // The one thing worth carrying over is how many GRNs this upload took
      // back off the CSD queue by naming a bill CSD had rejected. Those rows
      // have just changed from rejected to unsent and somebody has to send
      // them again, so the results page says so rather than leaving it to be
      // noticed.
      navigate('/results', reopenedRejections ? { state: { reopenedRejections } } : undefined);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    /* The whole page on one screen -- see .upload-page in styles.css: the card
       is held to the window's height and the drop boxes give way inside it, so
       the button is never below the fold.

       The top bar already names the page, and the lead paragraph that used to
       sit here was left empty, so there is no head row: an empty one was 22px
       of margin that the drop boxes can use. Its text, kept for whenever a
       lead comes back: Upload the GRN report, the Vendor Ageing report, or both
       -- either works on its own. Every GRN transaction is matched against the
       ageing report by its GRN number to work out which have reached the
       accounts department and which are still pending: without the ageing
       report every GRN shows as pending, and without the GRN report the ageing
       rows are stored with nothing yet to reconcile them against. The bank
       statement is optional too: only its transaction table is read, and it
       is stored rather than reconciled. */
    <div className="upload-page">
      <form className="card upload" onSubmit={handleSubmit}>
        <div className="upload__rule">
          <span>The reports</span>
        </div>

        <div className="drops">
          <FileDrop
            step={1}
            label="GRN Report"
            hint="The daily GRN summary. Without it, ageing rows have nothing to reconcile against yet."
            example="01. GRN Report _ Apr'26.xls"
            multiple
            maxBytes={limits?.maxFileBytes}
            maxFiles={limits?.maxFilesPerSlot}
            files={grnFiles}
            onSelect={pick(setGrnFiles)}
            onReject={setError}
          />
         <FileDrop
            step={4}
            label="BPAD Register — optional"
            hint="Matched to the GRN report's rows by vendor code and GRN number; the rest of the register is read past."
            example="BPAD.xlsx"
            accept=".xlsx"
            multiple
            maxBytes={limits?.maxFileBytes}
            maxFiles={limits?.maxBpadFiles}
            files={bpadFiles}
            onSelect={pick(setBpadFiles)}
            onReject={setError}
          />

          <FileDrop
            step={2}
            label="Vendor Ageing Report"
            hint="The month's ageing export. Without it, every GRN shows as pending."
            example="02. Vendor ageing report _ Apr'26.xlsx"
            multiple
            maxBytes={limits?.maxFileBytes}
            maxFiles={limits?.maxFilesPerSlot}
            files={ageingFiles}
            onSelect={pick(setAgeingFiles)}
            onReject={setError}
          />
          <FileDrop
            step={3}
            label="Bank Statement — optional"
            hint="Only the transaction table is read. Works uploaded on its own too."
            example="06. HDFC - 9911_Apr'26.xls"
            multiple
            maxBytes={limits?.maxFileBytes}
            maxFiles={limits?.maxFilesPerSlot}
            files={bankFiles}
            onSelect={pick(setBankFiles)}
            onReject={setError}
          />
          {/* Sat beside the GRN report because that is what it is read
              against: only the register's rows whose vendor code AND GRN
              number match a GRN already on file are kept, and those become the
              BPAD tab on the results page. .xlsx only -- the register is
              exported from a system that writes nothing else, and it is far
              too large to be a BIFF8 .xls. */}

        </div>

        {shownError && (
          <div className="alert alert--error alert--icon" role="alert">
            <IconAlert size={16} />
            <span>{shownError}</span>
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
                  ? `${several(ageingFiles, 'Ageing report')} ready — GRN report not included, so nothing reconciles yet`
                  : bankFiles.length > 0
                    ? `${several(bankFiles, 'Bank statement')} ready — no report included, so nothing reconciles yet`
                    : bpadFiles.length > 0
                      ? // On its own it still has something to match
                        // against: every GRN uploaded before now. It is the
                        // one slot that never needs a report beside it -- but
                        // with one, that report is what it narrows to.
                        `${several(bpadFiles, 'BPAD register')} ready — no GRN report included, so it matches against every GRN already uploaded`
                      : 'Choose the GRN report, the ageing report, the bank statement or the BPAD register'}
            {bankFiles.length > 0 && ready > 0 && ` — ${several(bankFiles, 'bank statement')} included`}
            {bpadFiles.length > 0 && ready > 0 && ` — ${several(bpadFiles, 'BPAD register')} included`}
          </p>

          {/* The button stays live with a slot still empty: a dead control
              cannot say why it is dead, and the submit handler already names
              the missing report. */}
          <button className="primary upload__go" type="submit" disabled={busy}>
            {busy ? 'Reconciling…' : 'Upload and reconcile'}
            {!busy && <IconArrowRight size={16} />}
          </button>
        </div>

        {busy && (
          <div className="progress" role="status">
            <span className="progress__bar" />
            <p className="upload__note">
              {bpadFiles.length > 1
                ? 'Reading the workbooks. The BPAD registers are large files, so this takes a minute or more.'
                : bpadFiles.length === 1
                  ? // The register is several hundred thousand rows and fifty
                    // megabytes, and it is read whole before it is narrowed --
                    // half a minute, not the few seconds the other three take.
                    // Saying so is what keeps a wait from reading as a hang.
                    'Reading the workbooks. The BPAD register is a large file, so this takes up to a minute.'
                  : `Reading the workbook${total > 1 ? 's' : ''} and matching several thousand rows. This usually takes a few seconds.`}
            </p>
          </div>
        )}
      </form>
    </div>
  );
}
