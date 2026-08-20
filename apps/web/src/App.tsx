import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Button, Spinner } from './components/ui.js';
import { ConfirmProvider } from './components/Confirm.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ProfileSettings } from './components/ProfileSettings.js';
import AuthPage from './pages/AuthPage.js';
import CampaignDetail from './pages/CampaignDetail.js';
import CampaignList from './pages/CampaignList.js';
import CampaignTable from './pages/CampaignTable.js';
import CharacterList from './pages/CharacterList.js';
import NpcList from './pages/NpcList.js';
import CharacterSheet from './pages/CharacterSheet.js';
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
    // Above the routes, so a page that asks a question keeps working while it
    // navigates away from the thing it asked about.
    <ConfirmProvider>
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
      <Route
        path="/campaigns/:id/table"
        element={
          <RequireAuth>
            <Shell>
              <CampaignTable />
            </Shell>
          </RequireAuth>
        }
      />
      <Route
        path="/characters"
        element={
          <RequireAuth>
            <Shell>
              <CharacterList />
            </Shell>
          </RequireAuth>
        }
      />
      <Route
        path="/npcs"
        element={
          <RequireAuth>
            <Shell>
              <NpcList />
            </Shell>
          </RequireAuth>
        }
      />
      <Route
        path="/characters/:id"
        element={
          <RequireAuth>
            <Shell>
              <CharacterSheet />
            </Shell>
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/campaigns" replace />} />
    </Routes>
    </ConfirmProvider>
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

function NavLink({ to, children }: { to: string; children: ReactNode }) {
  const location = useLocation();
  const active = location.pathname.startsWith(to);
  return (
    <Link
      to={to}
      className={active ? 'text-ink-100' : 'text-ink-400 transition-colors hover:text-ink-200'}
    >
      {children}
    </Link>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const [profileOpen, setProfileOpen] = useState(false);

  return (
    <div className="bg-vellum min-h-full">
      <header className="border-b border-ink-800 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <Link to="/campaigns" className="font-display text-lg font-bold text-ink-100">
              DnD <span className="text-ember-400">Immerse</span>
            </Link>
            <nav className="flex gap-4 text-sm">
              <NavLink to="/campaigns">Campaigns</NavLink>
              <NavLink to="/characters">Characters</NavLink>
              {/* Only a DM can create an NPC, so for everyone else this is a
                  link to a shelf that can never fill. */}
              {user?.dmOfAny && <NavLink to="/npcs">NPCs</NavLink>}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {/* Your name is where people look for their own settings. */}
            <button
              onClick={() => setProfileOpen(true)}
              title="Your profile"
              aria-label="Your profile"
              className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-ink-400 transition-colors hover:bg-ink-850 hover:text-ink-100"
            >
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="size-6 rounded-full object-cover" />
              ) : (
                <span className="flex size-6 items-center justify-center rounded-full bg-ink-700 text-[10px] font-semibold text-ink-200">
                  {(user?.displayName ?? '?').slice(0, 2).toUpperCase()}
                </span>
              )}
              <span className="hidden sm:inline">{user?.displayName}</span>
            </button>
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main>
        <ErrorBoundary label="This page" variant="page">
          {children}
        </ErrorBoundary>
      </main>

      {profileOpen && <ProfileSettings onClose={() => setProfileOpen(false)} />}
    </div>
  );
}
