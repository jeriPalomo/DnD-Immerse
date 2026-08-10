import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Alert, Button, Card, Field, Input } from '../components/ui.js';
import { ApiError } from '../lib/api.js';
import { useAuth } from '../store/auth.js';

export default function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { user, loading, login, register } = useAuth();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  if (!loading && user) {
    const to = (location.state as { from?: string } | null)?.from ?? '/campaigns';
    return <Navigate to={to} replace />;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (isRegister) await register(email, displayName, password);
      else await login(email, password);
    } catch (err) {
      // Surface the first field-level issue when the server sent one; it is
      // more useful than the generic "Invalid request".
      const issue = err instanceof ApiError ? err.issues?.[0]?.message : null;
      setError(issue ?? (err instanceof Error ? err.message : 'Something went wrong'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-vellum flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="font-display text-3xl font-bold tracking-tight text-ink-100">
            DnD <span className="text-ember-400">Immerse</span>
          </h1>
          <p className="mt-2 text-sm text-ink-400">
            {isRegister ? 'Create an account to join the table.' : 'Welcome back, adventurer.'}
          </p>
        </div>

        <Card className="p-6">
          <form onSubmit={onSubmit} className="space-y-4">
            {error && <Alert>{error}</Alert>}

            <Field label="Email">
              <Input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>

            {isRegister && (
              <Field label="Display name" hint="How your friends will see you at the table.">
                <Input
                  required
                  minLength={2}
                  maxLength={40}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Jeri"
                />
              </Field>
            )}

            <Field label="Password" hint={isRegister ? 'At least 8 characters.' : undefined}>
              <Input
                type="password"
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                required
                minLength={isRegister ? 8 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </Field>

            <Button type="submit" loading={busy} className="w-full">
              {isRegister ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </Card>

        <p className="mt-6 text-center text-sm text-ink-400">
          {isRegister ? 'Already have an account? ' : "Don't have an account? "}
          <Link
            to={isRegister ? '/login' : '/register'}
            className="text-ember-400 underline-offset-4 hover:underline"
          >
            {isRegister ? 'Sign in' : 'Create one'}
          </Link>
        </p>
      </div>
    </div>
  );
}
