import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import FileDrop from '../components/FileDrop.jsx';
import { IconAlert, IconArrowRight } from '../components/icons.jsx';

export default function Upload() {
  const navigate = useNavigate();

  // All three optional, and every one works uploaded on its own: a GRN report
  // with no ageing report reconciles as every row PENDING, an ageing report
  // with no GRN report has nothing to reconcile yet but is still stored for
  // the month -- uploading the GRN report later is what reconciles it -- and
  // a bank statement is stored and ready for its cheques to be matched
  // against whatever ageing rows exist, now or later. At least one of the
  // three is required; see the check below.
  const [grnFile, setGrnFile] = useState(null);
  const [ageingFile, setAgeingFile] = useState(null);
  const [bankFile, setBankFile] = useState(null);
  // The BPAD register, and optional like the two beside it. Unlike them it is
  // the whole group's file rather than this installation's: only the rows
  // naming a GRN this upload is about are kept -- matched on the vendor code
  // and the GRN number together -- and the several hundred thousand others are
  // read past. Which GRNs those are depends on the slot beside it: the GRN
  // report's own rows when one is included, and every GRN ever uploaded when
  // one is not, so the register still works uploaded on its own.
  const [bpadFile, setBpadFile] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = [grnFile, ageingFile].filter(Boolean).length;

  function pick(setter) {
    return (file) => {
      setError('');
      setter(file);
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    if (!grnFile && !ageingFile && !bankFile && !bpadFile) {
      setError('Please choose at least one file: the GRN report, the Vendor Ageing report, the bank statement, or the BPAD register.');
      return;
    }

    const formData = new FormData();
    if (grnFile) formData.append('grnFile', grnFile);
    if (ageingFile) formData.append('ageingFile', ageingFile);
    if (bankFile) formData.append('bankFile', bankFile);
    if (bpadFile) formData.append('bpadFile', bpadFile);

    setBusy(true);
    try {
      await api.uploadBatch(formData);
      // The results page reports on every upload at once, so there is no
      // batch to point it at -- the one just made is already included.
      navigate('/results');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* The shell's top bar already names the page, so this is the lead only. */}
      <div className="page__head">
        <p className="page__lead">
          {/* Upload the GRN report, the Vendor Ageing report, or both -- either works on its own. Every
          GRN transaction is matched against the ageing report by its GRN number to work out which have
          reached the accounts department and which are still pending: without the ageing report every
          GRN shows as pending, and without the GRN report the ageing rows are stored with nothing yet to
          reconcile them against. The bank statement is optional too: only its transaction table is read,
          and it is stored rather than reconciled. */}
        </p>
      </div>

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
            file={grnFile}
            onSelect={pick(setGrnFile)}
            onReject={setError}
          />
          <FileDrop
            step={2}
            label="Vendor Ageing Report"
            hint="The month's ageing export. Without it, every GRN shows as pending."
            example="02. Vendor ageing report _ Apr'26.xlsx"
            file={ageingFile}
            onSelect={pick(setAgeingFile)}
            onReject={setError}
          />
          <FileDrop
            step={3}
            label="Bank Statement — optional"
            hint="Only the transaction table is read. Works uploaded on its own too."
            example="06. HDFC - 9911_Apr'26.xls"
            file={bankFile}
            onSelect={pick(setBankFile)}
            onReject={setError}
          />
          {/* Sat beside the GRN report because that is what it is read
              against: only the register's rows whose vendor code AND GRN
              number match a GRN already on file are kept, and those become the
              BPAD tab on the results page. .xlsx only -- the register is
              exported from a system that writes nothing else, and it is far
              too large to be a BIFF8 .xls. */}
          <FileDrop
            step={4}
            label="BPAD Register — optional"
            hint="Matched to the GRN report's rows by vendor code and GRN number; the rest of the register is read past."
            example="BPAD.xlsx"
            accept=".xlsx"
            file={bpadFile}
            onSelect={pick(setBpadFile)}
            onReject={setError}
          />
        </div>

        {error && (
          <div className="alert alert--error alert--icon" role="alert">
            <IconAlert size={16} />
            <span>{error}</span>
          </div>
        )}

        <div className="upload__foot">
          <p className="upload__ready">
            <span className={`readydots readydots--${ready}`} aria-hidden="true">
              <i />
              <i />
            </span>
            {ready === 2
              ? 'Both reports ready'
              : grnFile
                ? 'GRN report ready — ageing report not included'
                : ageingFile
                  ? 'Ageing report ready — GRN report not included, so nothing reconciles yet'
                  : bankFile
                    ? 'Bank statement ready — no report included, so nothing reconciles yet'
                    : bpadFile
                      ? // On its own it still has something to match
                        // against: every GRN uploaded before now. It is the
                        // one slot that never needs a report beside it -- but
                        // with one, that report is what it narrows to.
                        'BPAD register ready — no GRN report included, so it matches against every GRN already uploaded'
                      : 'Choose the GRN report, the ageing report, the bank statement or the BPAD register'}
            {bankFile && ready > 0 && ' — bank statement included'}
            {bpadFile && ready > 0 && ' — BPAD register included'}
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
              {bpadFile
                ? // The register is several hundred thousand rows and fifty
                  // megabytes, and it is read whole before it is narrowed --
                  // half a minute, not the few seconds the other three take.
                  // Saying so is what keeps a wait from reading as a hang.
                  'Reading the workbooks. The BPAD register is a large file, so this takes up to a minute.'
                : `Reading the workbook${ready === 2 ? 's' : ''} and matching several thousand rows. This usually takes a few seconds.`}
            </p>
          </div>
        )}
      </form>
    </>
  );
}
