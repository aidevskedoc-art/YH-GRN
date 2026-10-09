import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { OP_PHARMACY_LABELS, opPharmacyGrant, opPharmacyPath } from '../services/screens.js';

/**
 * An OP Pharmacy screen that has its place in the menu and is not built yet.
 *
 * The pharmacies' reports are uploaded on Pharmacy Uploads, kept in their own
 * tables apart from the hospitals', and shown on Pharmacy Results. Ph-Accounts
 * -- the hospitals' Accounts Department screen for the pharmacies -- is still
 * to come, and until it does its address says so plainly rather than showing
 * the hospital screen again under a pharmacy heading: that would put the
 * hospitals' figures on a page titled for the pharmacies.
 *
 * `screen` is the key of the hospital screen this one is the twin of -- what
 * the label and the address are keyed on, not the grant it is behind
 * (opPharmacyGrant).
 */
export default function OpPharmacy({ screen }) {
  const navigate = useNavigate();
  const { can } = useAuth();

  return (
    <div className="empty empty--page">
      <h2>{OP_PHARMACY_LABELS[screen]}</h2>
      <p>
        This screen is not set up yet. The pharmacy reports are uploaded on {OP_PHARMACY_LABELS.upload}, and what
        they came to — each GRN, its cheque and the bank statement&rsquo;s answer on it — is on{' '}
        {OP_PHARMACY_LABELS.results}. The reconciliation under Hospitals is unaffected.
      </p>
      {/* Side by side, centred by the page's own text alignment; the space
          between them is the gap. */}
      {can(opPharmacyGrant('results')) && (
        <button className="primary" type="button" onClick={() => navigate(opPharmacyPath('results'))}>
          Go to {OP_PHARMACY_LABELS.results}
        </button>
      )}{' '}
      {can(opPharmacyGrant('upload')) && (
        <button className="ghost" type="button" onClick={() => navigate(opPharmacyPath('upload'))}>
          Go to {OP_PHARMACY_LABELS.upload}
        </button>
      )}
    </div>
  );
}
