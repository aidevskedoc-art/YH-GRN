import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { OP_PHARMACY_LABELS, SCREEN_LABELS, SCREEN_ROUTES, opPharmacyPath } from '../services/screens.js';

/**
 * An OP Pharmacy screen that has its place in the menu and is not built yet.
 *
 * The pharmacies' reports are uploaded on Pharmacy Uploads and kept in their
 * own tables (see pages/PharmacyUpload.jsx), apart from the hospitals'. The
 * screens that show them -- Pharmacy Results and Ph-Accounts -- are still to
 * come, and until they do, each address says so plainly rather than showing
 * the hospital screen again under a pharmacy heading: that would put the
 * hospitals' figures on a page titled for the pharmacies.
 *
 * `screen` is the grant key of the hospital screen this one is the twin of;
 * the route is behind that same grant, so the hospital screen it offers is
 * always one this account may open.
 */
export default function OpPharmacy({ screen }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  // The way back names the hospital screen as the Hospitals sub-menu does.
  const label = SCREEN_LABELS[screen];

  return (
    <div className="empty empty--page">
      <h2>{OP_PHARMACY_LABELS[screen]}</h2>
      <p>
        This screen is not set up yet. The pharmacy reports are uploaded and reconciled on{' '}
        {OP_PHARMACY_LABELS.upload}; showing them here is still to come. The reconciliation under Hospitals is
        unaffected.
      </p>
      {/* Side by side, centred by the page's own text alignment; the space
          between them is the gap. */}
      {can('upload') && (
        <button className="primary" type="button" onClick={() => navigate(opPharmacyPath('upload'))}>
          Go to {OP_PHARMACY_LABELS.upload}
        </button>
      )}{' '}
      {/* <button className="ghost" type="button" onClick={() => navigate(SCREEN_ROUTES[screen])}>
        Go to Hospitals: {label}
      </button> */}
    </div>
  );
}
