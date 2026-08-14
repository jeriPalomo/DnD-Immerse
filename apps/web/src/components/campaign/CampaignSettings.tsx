import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Field, Input, Textarea } from '../ui.js';
import { AvatarUpload } from '../AvatarUpload.js';
import { api } from '../../lib/api.js';
import type { Campaign, Member } from '../../store/campaigns.js';

/**
 * Everything about a campaign that only the DM may change.
 *
 * Gathered behind the gear so the campaign page can be a read-only overview.
 * Name and description live here because until now they were set once at
 * creation and could never be edited again.
 */
export function CampaignSettings({
  campaign,
  members,
  onChange,
  onMembersChanged,
  onClose,
}: {
  campaign: Campaign;
  members: Member[];
  onChange: (campaign: Campaign) => void;
  onMembersChanged: () => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [code, setCode] = useState(campaign.inviteCode ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Escape closes, like every other overlay on the board.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Debounced, like the recap: a name is typed, not submitted. */
  function patch(fields: Partial<Campaign>, immediate = false) {
    onChange({ ...campaign, ...fields });
    setSaving(true);

    if (timer.current) clearTimeout(timer.current);
    const send = async () => {
      try {
        const res = await api.patch<{ campaign: Campaign }>(
          `/api/campaigns/${campaign.id}`,
          fields,
        );
        onChange(res.campaign);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save');
      } finally {
        setSaving(false);
      }
    };

    if (immediate) void send();
    else timer.current = setTimeout(() => void send(), 600);
  }

  async function rotate() {
    setBusy(true);
    try {
      const res = await api.post<{ inviteCode: string }>(
        `/api/campaigns/${campaign.id}/invite/rotate`,
      );
      setCode(res.inviteCode);
      onChange({ ...campaign, inviteCode: res.inviteCode });
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string, name: string) {
    if (!confirm(`Remove ${name} from this campaign?`)) return;
    await api.delete(`/api/campaigns/${campaign.id}/members/${userId}`);
    onMembersChanged();
  }

  async function destroy() {
    if (!confirm(`Delete "${campaign.name}"? Scenes, tokens and journal go with it.`)) return;
    await api.delete(`/api/campaigns/${campaign.id}`);
    navigate('/campaigns');
  }

  const players = members.filter((member) => member.role !== 'dm');

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-12 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-ink-800 px-5 py-3">
          <h2 className="font-display text-lg text-ink-100">Campaign settings</h2>
          <span className="text-xs text-ink-600">{saving ? 'Saving…' : 'Saved'}</span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {error && <Alert>{error}</Alert>}

          <Field label="Name">
            <Input
              maxLength={80}
              value={campaign.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>

          <Field label="Description">
            <Textarea
              rows={3}
              maxLength={5000}
              value={campaign.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>

          <Field label="Rules edition">
            <select
              value={campaign.ruleset ?? '2014'}
              aria-label="Rules edition"
              onChange={(e) => patch({ ruleset: e.target.value as '2014' | '2024' }, true)}
              className="w-full rounded-lg border border-ink-600 bg-ink-850 px-3 py-2.5 text-ink-100 focus:border-arcane-400 focus:outline-none"
            >
              <option value="2014">2014 rules (SRD 5.1)</option>
              <option value="2024">2024 rules (SRD 5.2)</option>
            </select>
          </Field>

          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink-200">Campaign banner</span>
            <AvatarUpload
              url={campaign.bannerUrl}
              endpoint={`/api/campaigns/${campaign.id}/banner`}
              field="bannerUrl"
              label="Campaign banner"
              shape="banner"
              onUploaded={(bannerUrl) => onChange({ ...campaign, bannerUrl })}
            />
          </div>

          {code && (
            <div>
              <span className="mb-1.5 block text-sm font-medium text-ink-200">Invite code</span>
              <div className="flex flex-wrap items-center gap-3">
                <code className="rounded-lg border border-ink-600 bg-ink-950 px-4 py-2.5 font-mono text-lg tracking-[0.3em] text-ember-300">
                  {code}
                </code>
                <Button variant="ghost" size="sm" onClick={() => void rotate()} loading={busy}>
                  Rotate
                </Button>
              </div>
              <p className="mt-1.5 text-sm text-ink-400">
                Rotating revokes any code you have already sent out.
              </p>
            </div>
          )}

          <div>
            <span className="mb-1.5 block text-sm font-medium text-ink-200">Players</span>
            {players.length === 0 ? (
              <p className="text-sm text-ink-500">Nobody has joined yet.</p>
            ) : (
              <ul className="divide-y divide-ink-800 rounded-lg border border-ink-800">
                {players.map((player) => (
                  <li key={player.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-sm text-ink-200">
                      {player.displayName}
                    </span>
                    <button
                      onClick={() => void remove(player.id, player.displayName)}
                      className="text-xs text-ink-600 hover:text-red-400"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-ink-800 pt-4">
            <Button variant="danger" size="sm" onClick={() => void destroy()}>
              Delete campaign
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
