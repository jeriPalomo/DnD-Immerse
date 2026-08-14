import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Field, Input } from './ui.js';
import { AvatarUpload } from './AvatarUpload.js';
import { api } from '../lib/api.js';
import { useAuth } from '../store/auth.js';

/**
 * Your own account: picture, name, password.
 *
 * `PATCH /api/auth/me` has existed since accounts were built and had no caller,
 * so a display name typed once at registration could never be changed. The
 * avatar was reachable, but only from the corner of the campaigns list, where
 * nothing said it was yours.
 */
export function ProfileSettings({ onClose }: { onClose: () => void }) {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounced, like every other name field here.
  function rename(value: string) {
    setName(value);
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (value.trim().length < 2) return;
      setSaving(true);
      try {
        await api.patch('/api/auth/me', { displayName: value.trim() });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save your name');
      } finally {
        setSaving(false);
      }
    }, 600);
  }

  async function changePassword() {
    setPwBusy(true);
    setPwError(null);
    setPwDone(false);
    try {
      await api.post('/api/auth/me/password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setPwDone(true);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Could not change your password');
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-12 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-ink-800 px-5 py-3">
          <h2 className="font-display text-lg text-ink-100">Your profile</h2>
          <span className="text-xs text-ink-600">{saving ? 'Saving…' : ''}</span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            aria-label="Close profile"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {error && <Alert>{error}</Alert>}

          <div className="flex items-center gap-4">
            <AvatarUpload
              url={user?.avatarUrl ?? null}
              endpoint="/api/auth/me/avatar"
              field="avatarUrl"
              label="Your picture"
              onUploaded={() => void refresh()}
            />
            <div className="min-w-0 flex-1">
              <Field label="Display name">
                <Input
                  value={name}
                  maxLength={40}
                  onChange={(e) => rename(e.target.value)}
                  placeholder="What the table calls you"
                />
              </Field>
            </div>
          </div>

          <p className="text-sm text-ink-500">
            Signed in as {user?.email}
          </p>

          <div className="space-y-3 border-t border-ink-800 pt-4">
            <h3 className="text-sm font-medium text-ink-200">Change password</h3>
            {pwError && <Alert>{pwError}</Alert>}
            {pwDone && <p className="text-sm text-emerald-400">Password changed.</p>}
            <Field label="Current password">
              <Input
                type="password"
                value={current}
                autoComplete="current-password"
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field label="New password" hint="At least eight characters.">
              <Input
                type="password"
                value={next}
                autoComplete="new-password"
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            <Button
              size="sm"
              loading={pwBusy}
              disabled={!current || next.length < 8}
              onClick={() => void changePassword()}
            >
              Change password
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
