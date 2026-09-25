import { Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import AppShell from './AppShell.jsx';
import Login from './pages/Login.jsx';
import NoAccess from './pages/NoAccess.jsx';
import Upload from './pages/Upload.jsx';
import Results from './pages/Results.jsx';
import Csd from './pages/Csd.jsx';
import AccountsDepartment from './pages/AccountsDepartment.jsx';
import Users from './pages/Users.jsx';
import Config from './pages/Config.jsx';
import Logs from './pages/Logs.jsx';
import MsmeReco from './pages/MsmeReco.jsx';
import VendorMaster from './pages/VendorMaster.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Outside the shell deliberately: the shell's navigation is built from
          the screens an account holds, and this is where an account with none
          of them lands. It cannot sit behind the guard that sends people here. */}
      <Route path="/no-access" element={<NoAccess />} />

      {/* Everything inside the shell is behind auth, so the sidebar and top bar
          are only ever rendered for a signed-in user.

          Each route additionally names the screen it needs. The outer guard
          answers "are you signed in"; the inner ones answer "were you given
          this", so an account that has only Results cannot reach Upload by
          typing the address. The API enforces the same grants -- see
          requireScreen in server/src/middleware/auth.js -- and these guards
          only keep the browser from opening a screen it cannot fill. */}
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route
          path="/upload"
          element={
            <ProtectedRoute screen="upload">
              <Upload />
            </ProtectedRoute>
          }
        />
        {/* No Uploaded files screen: the results screens show every GRN once,
            from its latest upload, so there are no uploads to list or delete
            one by one. Its old address lands on Results. */}
        <Route path="/uploads" element={<Navigate to="/results" replace />} />
        <Route
          path="/results"
          element={
            <ProtectedRoute screen="results">
              <Results />
            </ProtectedRoute>
          }
        />
        <Route
          path="/results/:batchId"
          element={
            <ProtectedRoute screen="results">
              <Results />
            </ProtectedRoute>
          }
        />
        {/* Not under /results/:batchId: the queue spans every upload, and
            outlives any one of them. */}
        <Route
          path="/csd"
          element={
            <ProtectedRoute screen="csd">
              <Csd />
            </ProtectedRoute>
          }
        />
        {/* The results screen's Accounts and PR-to-Bank views, and nothing
            else. Its own screen grant rather than a filter on `results`: what
            it leaves out is the point, so an account given this one must not
            also be given the screen it is a narrowing of -- see
            pages/AccountsDepartment.jsx. */}
        <Route
          path="/accounts-department"
          element={
            <ProtectedRoute screen="accounts-department">
              <AccountsDepartment />
            </ProtectedRoute>
          }
        />
        {/* The screen's old address, so bookmarks and links still land. */}
        <Route path="/accounts-depot" element={<Navigate to="/accounts-department" replace />} />
        {/* Branch definitions, and which branches the figures are narrowed to.
            A grantable screen rather than an admin one: the people who know
            which branch a DivisionCode belongs to are not necessarily the
            people who hand out accounts. */}
        <Route
          path="/config"
          element={
            <ProtectedRoute screen="config">
              <Config />
            </ProtectedRoute>
          }
        />
        {/* Every vendor the HIS vendor master has ever listed, once each, with
            its latest details -- filled by each HIS vs FOCUS Reco. The Vendor
            Reco dropdown's first screen, read-only, with its own grant (see
            server/src/routes/vendorMaster.js). */}
        <Route
          path="/vendor-master"
          element={
            <ProtectedRoute screen="vendor-master">
              <VendorMaster />
            </ProtectedRoute>
          }
        />
        {/* The HIS vendor master against the Accounts vendor list, with its
            own grant (see server/src/routes/msmeReco.js). */}
        <Route
          path="/msme-reco"
          element={
            <ProtectedRoute screen="msme-reco">
              <MsmeReco />
            </ProtectedRoute>
          }
        />
        {/* Account management. A grantable screen: a standard user given it
            manages standard accounts only -- see routes/users.js. */}
        <Route
          path="/users"
          element={
            <ProtectedRoute screen="users">
              <Users />
            </ProtectedRoute>
          }
        />
        {/* Who did what -- the monitoring screen, grantable like the rest. */}
        <Route
          path="/logs"
          element={
            <ProtectedRoute screen="logs">
              <Logs />
            </ProtectedRoute>
          }
        />
      </Route>

      {/* An unknown address goes to Results, and the guard above forwards from
          there to whatever this account does hold. */}
      <Route path="*" element={<Navigate to="/results" replace />} />
    </Routes>
  );
}
