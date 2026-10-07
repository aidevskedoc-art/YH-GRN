import PharmacyResults from './PharmacyResults.jsx';

/**
 * Ph-Accounts: the hospitals' Accounts Department (pages/AccountsDepartment.jsx)
 * for the pharmacy uploads.
 *
 * Pharmacy Results with the Accounts views only -- Accounts, Cheque Not
 * Prepared and the GRN age view -- opening on Accounts. The same rows, cards
 * and actions as that page shows on those views, which is why it is that page
 * and not a copy of it: see DESKS there.
 */
export default function PharmacyAccounts() {
  return <PharmacyResults desk="accounts" />;
}
