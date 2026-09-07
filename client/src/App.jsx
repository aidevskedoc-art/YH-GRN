import { Navigate, Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import AppShell from './AppShell.jsx';
import Login from './pages/Login.jsx';
import NoAccess from './pages/NoAccess.jsx';
import Upload from './pages/Upload.jsx';
import Results from './pages/Results.jsx';
import Csd from './pages/Csd.jsx';
import Users from './pages/Users.jsx';
import Config from './pages/Config.jsx';

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
        {/* Managing accounts is the administrator's own screen rather than a
            grantable one -- it is where the grants are handed out. */}
        <Route
          path="/users"
          element={
            <ProtectedRoute adminOnly>
              <Users />
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
