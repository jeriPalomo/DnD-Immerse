import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui.js';
import { api } from '../../lib/api.js';

interface Campaign {
  id: string;
  name: string;
  role: 'dm' | 'player';
}

/**
 * Brings a character to a table.
 *
 * Characters belong to the player, not to a campaign, so this is the step that
 * puts one in front of a DM. Without it a new player could build a sheet and
 * then find no way to actually use it — the seed data hid that, because its
 * characters were assigned already.
 */
export function CampaignAssign({
  actorId,
  assigned,
  onChanged,
}: {
  actorId: string;
  assigned: { id: string; name: string }[];
  onChanged: () => void;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ campaigns: Campaign[] }>('/api/campaigns');
      setCampaigns(res.campaigns);
    } catch {
      // A failure here just means the picker stays empty.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(campaignId: string, join: boolean) {
    setBusy(campaignId);
    setError(null);
    try {
      if (join) await api.post(`/api/actors/${actorId}/campaigns/${campaignId}`);
      else await api.delete(`/api/actors/${actorId}/campaigns/${campaignId}`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusy(null);
    }
  }

  if (campaigns.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        You are not in any campaigns yet. Join one with an invite code, then bring this character
        to it.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-red-400">{error}</p>}

      <ul className="space-y-1.5">
        {campaigns.map((campaign) => {
          const isIn = assigned.some((a) => a.id === campaign.id);

          return (
            <li key={campaign.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-ink-200">
                {campaign.name}
                {campaign.role === 'dm' && (
                  <span className="ml-1.5 text-[10px] text-ember-400">you run this</span>
                )}
              </span>
              <Button
                size="sm"
                variant={isIn ? 'ghost' : 'secondary'}
                loading={busy === campaign.id}
                onClick={() => void toggle(campaign.id, !isIn)}
              >
                {isIn ? 'Remove' : 'Bring to table'}
              </Button>
            </li>
          );
        })}
      </ul>

      {assigned.length === 0 && (
        <p className="text-[11px] text-ink-600">
          Until a character is at a table, the DM cannot see it or place a token for it.
        </p>
      )}
    </div>
  );
}
