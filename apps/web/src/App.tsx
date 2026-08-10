import { useEffect } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Button, Spinner } from './components/ui.js';
import AuthPage from './pages/AuthPage.js';
import CampaignDetail from './pages/CampaignDetail.js';
import CampaignList from './pages/CampaignList.js';
import { useAuth } from './store/auth.js';
import type { ReactNode } from 'react';

export default function App() {
  const { loading, refresh } = useAuth();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Block the first paint until the session is resolved, so a signed-in user
  // never sees a flash of the login page on refresh.
  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route
        path="/campaigns"
        element={
          <RequireAuth>
            <Shell>
              <CampaignList />
            </Shell>
          </RequireAuth>
        }
      />
      <Route
        path="/campaigns/:id"
        element={
          <RequireAuth>
            <Shell>
              <CampaignDetail />
            </Shell>
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/campaigns" replace />} />
    </Routes>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="bg-vellum min-h-full">
      <header className="border-b border-ink-800 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/campaigns" className="font-display text-lg font-bold text-ink-100">
            DnD <span className="text-ember-400">Immerse</span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-ink-400 sm:inline">{user?.displayName}</span>
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
