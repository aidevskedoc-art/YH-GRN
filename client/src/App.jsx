import { Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import AppShell from './AppShell.jsx';
import Login from './pages/Login.jsx';
import NoAccess from './pages/NoAccess.jsx';
import Upload from './pages/Upload.jsx';
import Uploads from './pages/Uploads.jsx';
import Results from './pages/Results.jsx';
import Csd from './pages/Csd.jsx';
import AccountsDepartment from './pages/AccountsDepartment.jsx';
import Users from './pages/Users.jsx';
import Config from './pages/Config.jsx';
import Logs from './pages/Logs.jsx';

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
          this", so an account that has only Results cannot reach Uploads by
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
        {/* What has been uploaded, and the only place a file can be taken
            back out. Behind the same grant as the upload form rather than a
            new one: it is the same screen's other half, and deleting is
            gated on the role instead -- requireAdmin on the route that does
            it, see server/src/routes/batches.js. */}
        <Route
          path="/uploads"
          element={
            <ProtectedRoute screen="uploads">
              <Uploads />
            </ProtectedRoute>
          }
        />
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
