import { useEffect, useRef, useState } from 'react';
import { useConfirm } from '../Confirm.js';
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
  const ask = useConfirm();
  const [code, setCode] = useState(campaign.inviteCode ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Fields typed since the last save, so a second edit cannot cancel the first. */
  const pending = useRef<Partial<Campaign>>({});

  // A save in flight when the panel closes should still land; a timer that has
  // not fired yet should fire now rather than be thrown away.
  useEffect(() => {
    const flush = () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      const body = pending.current;
      pending.current = {};
      if (Object.keys(body).length > 0) void api.patch(`/api/campaigns/${campaign.id}`, body);
    };
    return flush;
  }, [campaign.id]);

  // Escape closes, like every other overlay on the board.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Debounced, like the recap: a name is typed, not submitted.
   *
   * Edits ACCUMULATE into `pending` rather than replacing it. One shared timer
   * with only the latest field meant typing a name and then tabbing to the
   * description within the debounce window cancelled the name's save - and the
   * response, carrying the server's older name, was then written back over the
   * box you had just typed into. Creating a campaign drops you straight into
   * this panel, so that is the first thing anyone does here.
   */
  function patch(fields: Partial<Campaign>, immediate = false) {
    onChange({ ...campaign, ...fields });
    pending.current = { ...pending.current, ...fields };
    setSaving(true);

    if (timer.current) clearTimeout(timer.current);
    const send = async () => {
      const body = pending.current;
      pending.current = {};
      if (Object.keys(body).length === 0) return;

      try {
        await api.patch<{ campaign: Campaign }>(`/api/campaigns/${campaign.id}`, body);
        setError(null);
      } catch (err) {
        // The optimistic value stays on screen with the error beside it rather
        // than being silently reverted to something the user did not type.
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
    const ok = await ask({
      title: `Remove ${name}?`,
      body: 'They lose access to this campaign. Their characters are theirs and stay.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await api.delete(`/api/campaigns/${campaign.id}/members/${userId}`);
    onMembersChanged();
  }

  async function destroy() {
    const ok = await ask({
      title: `Delete "${campaign.name}"?`,
      body: 'Scenes, tokens, walls and the journal go with it. This cannot be undone.',
      confirmLabel: 'Delete campaign',
      danger: true,
    });
    if (!ok) return;
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

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={campaign.playersSeeEnemyStats ?? true}
              onChange={(e) => patch({ playersSeeEnemyStats: e.target.checked }, true)}
              className="mt-0.5 size-4 shrink-0 accent-arcane-500"
            />
            <span>
              <span className="block text-sm font-medium text-ink-200">
                Players can read enemy stat blocks
              </span>
              <span className="mt-0.5 block text-xs text-ink-500">
                Abilities, speed, actions and conditions for creatures they do not control.
                Hit points are never included — those stay yours to narrate. Turn a single
                creature off with “Hide stats” on its token.
              </span>
            </span>
          </label>

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
