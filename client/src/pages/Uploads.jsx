/**
 * Uploaded files.
 *
 * The other half of the upload screen: that one puts workbooks in, this one
 * says what is in there and takes one back out.
 *
 * A row here is one FILE, not one upload. An upload is up to four workbooks
 * that happened to be sent together, and they are independent the moment they
 * land -- a bank statement is matched against every ageing row on file, a BPAD
 * register against every GRN, neither of them against the report they arrived
 * beside. So the wrong bank statement should cost the bank statement, not the
 * GRN report that was uploaded with it. Removing the last file an upload
 * carries removes the upload itself, because a batch naming no file is not a
 * batch of anything -- the table enforces the same rule.
 *
 * Deleting is an administrator's act, like deleting a whole upload: it takes
 * stored rows out from under a results screen other people are reading. A
 * standard user sees the list and no buttons, and the API refuses the call
 * either way -- the hidden button is a courtesy, not the guard.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useConfirm } from '../components/ConfirmDialog.jsx';
import { IconSheet, IconTrash, IconUpload } from '../components/icons.jsx';

/**
 * The four slots an upload can carry, in the order the upload form offers
 * them, and how to read one off a batch.
 *
 * `kind` is the string the delete route takes -- the same four the upload form
 * posts, minus the "File" suffix -- so the row a person is looking at and the
 * request that removes it name the file identically.
 *
 * `count` is what the file actually put in the database, which is the figure
 * worth showing: a file name alone says something was uploaded, a row count
 * says whether it carried anything. `note` is the one extra fact a slot has of
 * its own, where it has one.
 */
const FILE_SLOTS = [
  {
    kind: 'grn',
    label: 'GRN report',
    name: (b) => b.grnFileName,
    count: (b) => b.grnRowCount,
    unit: 'GRN rows',
  },
  {
    kind: 'ageing',
    label: 'Vendor Ageing report',
    name: (b) => b.ageingFileName,
    count: (b) => b.ageingRowCount,
    unit: 'ageing rows',
  },
  {
    kind: 'bank',
    label: 'Bank statement',
    name: (b) => b.bankFileName,
    count: (b) => b.bankRowCount,
    unit: 'transactions',
    // Read off the statement's own letterhead at upload time. Which account a
    // statement is for is what decides whose cheques it clears, so it belongs
    // beside the file name rather than buried.
    note: (b) => (b.bankAccountNo ? `Account ${b.bankAccountNo}` : null),
  },
  {
    kind: 'bpad',
    label: 'BPAD register',
    name: (b) => b.bpadFileName,
    // What was KEPT, not what was uploaded: the register is the whole group's
    // and only the rows naming a GRN on file are stored. The note below gives
    // the other figure, so a small number never reads like a file that
    // half-failed.
    count: (b) => b.bpadMatchedCount,
    unit: 'matched rows',
    note: (b) => (b.bpadRowCount ? `${b.bpadRowCount.toLocaleString('en-IN')} rows read` : null),
  },
];

/** dd-MM-yyyy HH:mm from a timestamptz, in the browser's own zone. */
function formatUploadedAt(value) {
  if (!value) return '—';
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return '—';
  return `${at.toLocaleDateString('en-GB')} ${at.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/** One row per file actually present, newest upload first (the API's order). */
function filesOf(batches) {
  const rows = [];
  for (const batch of batches) {
    for (const slot of FILE_SLOTS) {
      const fileName = slot.name(batch);
      if (!fileName) continue;
      rows.push({
        id: `${batch.id}:${slot.kind}`,
        batchId: batch.id,
        kind: slot.kind,
        label: slot.label,
        fileName,
        count: slot.count(batch) ?? 0,
        unit: slot.unit,
        note: slot.note?.(batch) ?? null,
        uploadedAt: batch.uploadedAt,
        uploadedBy: batch.uploadedBy,
        // How many files this upload is still carrying, so the confirmation can
        // say when deleting one deletes the upload with it.
        siblings: FILE_SLOTS.filter((s) => s.name(batch)).length,
      });
    }
  }
  return rows;
}

export default function Uploads() {
  const { isAdmin } = useAuth();
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Which file's delete is in flight, so only its own row goes quiet.
  const [busy, setBusy] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(() => {
    setLoading(true);
    api
      .listBatches()
      .then(({ batches: list }) => setBatches(list))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function remove(row) {
    const last = row.siblings === 1;
    const ok = await confirm({
      title: `Delete this ${row.label}?`,
      // Two short lines: what goes, and the one thing that is not obvious --
      // that the last file takes its upload with it.
      message: [
        `${row.fileName} and its ${row.count.toLocaleString('en-IN')} ${row.unit} will be deleted. This cannot be undone.`,
        last ? 'It is this upload’s only file, so the upload goes too.' : null,
      ].filter(Boolean),
      confirmLabel: 'Delete file',
    });
    if (!ok) return;

    setBusy(row.id);
    setError('');
    setNotice('');
    try {
      const result = await api.deleteBatchFile(row.batchId, row.kind);
      setNotice(
        `${row.fileName} deleted — ${(result?.rowsDeleted ?? 0).toLocaleString('en-IN')} ${row.unit} removed${
          result?.batchDeleted ? ', and the upload with it' : ''
        }.`,
      );
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  const files = filesOf(batches);

  return (
    <>
      {confirmDialog}

      <div className="page__head">
        <h2 className="page__title">Uploaded files</h2>
        <p className="page__lead">
          Every workbook that has been uploaded, newest first, and what each one stored. Deleting a
          file removes its rows from the database and leaves the files uploaded alongside it alone.
        </p>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--info">{notice}</div>}

      {!isAdmin && files.length > 0 && (
        <div className="alert alert--info">
          <strong>Read-only.</strong> Deleting an uploaded file is an administrator&rsquo;s action
          &mdash; it takes rows out from under the results screen for everyone.
        </div>
      )}

      {loading && files.length === 0 ? (
        <div className="loading">Loading&hellip;</div>
      ) : files.length === 0 ? (
        <div className="empty">
          <p>Nothing has been uploaded yet.</p>
          <p className="page__lead">
            <IconUpload size={15} /> Use <strong>New uploads</strong> to add the GRN report, the
            Vendor Ageing report, a bank statement or the BPAD register.
          </p>
        </div>
      ) : (
        <div className="table-wrap table-wrap--sticky">
          <table className="table">
            <thead>
              <tr>
                <th>File</th>
                <th>Type</th>
                <th>Stored</th>
                <th>Uploaded</th>
                <th>By</th>
                {isAdmin && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {files.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="row-actions row-actions--inline">
                      <IconSheet size={15} />
                      <span className="table__mono">{row.fileName}</span>
                    </div>
                  </td>
                  <td>{row.label}</td>
                  <td>
                    {row.count.toLocaleString('en-IN')} {row.unit}
                    {row.note && (
                      <>
                        <br />
                        <span className="table__miss">{row.note}</span>
                      </>
                    )}
                  </td>
                  <td>{formatUploadedAt(row.uploadedAt)}</td>
                  <td>{row.uploadedBy || <span className="table__miss">&mdash;</span>}</td>
                  {isAdmin && (
                    <td>
                      <button
                        type="button"
                        className="ghost ghost--sm danger"
                        disabled={busy === row.id}
                        onClick={() => remove(row)}
                        title={`Delete ${row.fileName}`}
                      >
                        <IconTrash size={13} /> {busy === row.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
