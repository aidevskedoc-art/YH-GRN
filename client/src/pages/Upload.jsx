import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import FileDrop from '../components/FileDrop.jsx';
import { IconAlert, IconArrowRight } from '../components/icons.jsx';

/**
 * Suggest a name for the upload: the previous month is what is normally
 * reconciled, so it is a sensible starting point. It is only a suggestion --
 * the name is free text and is what the upload is listed under afterwards.
 */
function suggestedName() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.toLocaleString('en-GB', { month: 'long' })} reconciliation`;
}

export default function Upload() {
  const navigate = useNavigate();

  const [name, setName] = useState(suggestedName);
  // Both optional, and either works on its own: a GRN report with no ageing
  // report reconciles as every row PENDING, and an ageing report with no GRN
  // report has nothing to reconcile yet but is still stored for the month --
  // uploading the GRN report later is what reconciles it. At least one of the
  // two is required; see the check below.
  const [grnFile, setGrnFile] = useState(null);
  const [ageingFile, setAgeingFile] = useState(null);
  // Optional. The reconciliation runs on the two reports; the statement is
  // stored alongside them and matched to nothing yet.
  const [bankFile, setBankFile] = useState(null);
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

    if (!name.trim()) {
      setError('Please give this upload a name.');
      return;
    }

    if (!grnFile && !ageingFile) {
      setError('Please choose the GRN report, the Vendor Ageing report, or both.');
      return;
    }

    const formData = new FormData();
    formData.append('name', name.trim());
    if (grnFile) formData.append('grnFile', grnFile);
    if (ageingFile) formData.append('ageingFile', ageingFile);
    if (bankFile) formData.append('bankFile', bankFile);

    setBusy(true);
    try {
      const { batchId } = await api.uploadBatch(formData);
      navigate(`/results/${batchId}`);
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
        <div className="field">
          <label className="field__label" htmlFor="batch-name">
            Name this upload
          </label>
          <input
            id="batch-name"
            className="field__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="April reconciliation"
            maxLength={120}
            required
          />
        </div>

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
            hint="Only the transaction table is read"
            example="06. HDFC - 9911_Apr'26.xls"
            file={bankFile}
            onSelect={pick(setBankFile)}
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
                  : 'Choose the GRN report, the ageing report, or both'}
            {bankFile && ' — bank statement included'}
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
              Reading the workbook{ready === 2 ? 's' : ''} and matching several thousand rows. This usually takes a few seconds.
            </p>
          </div>
        )}
      </form>
    </>
  );
}
