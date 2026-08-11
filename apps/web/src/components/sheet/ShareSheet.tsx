import { useEffect, useState } from 'react';
import { OWNERSHIP, type OwnershipLevel } from '@dnd/shared';
import { api } from '../../lib/api.js';

interface Member {
  id: string;
  displayName: string;
  role: 'dm' | 'player';
}

/**
 * Who else can read this sheet.
 *
 * Without this the ownership levels were unreachable: every other player saw
 * "Sheet not shared" with no way to change it. Levels rather than a checkbox,
 * because "can see my HP on the party list" and "can read my backstory" are
 * genuinely different things to hand out.
 */
const LEVELS: { value: OwnershipLevel; label: string; hint: string }[] = [
  { value: OWNERSHIP.none, label: 'Private', hint: 'Not listed at all' },
  { value: OWNERSHIP.limited, label: 'Name only', hint: 'Name and portrait on the party list' },
  { value: OWNERSHIP.observer, label: 'Can read', hint: 'Full sheet, no edits' },
  { value: OWNERSHIP.owner, label: 'Can edit', hint: 'Full control, including HP' },
];

export function ShareSheet({
  actorId,
  ownerUserId,
  campaignIds,
  grants,
  onChanged,
}: {
  actorId: string;
  ownerUserId: string;
  campaignIds: string[];
  grants: { userId: string; level: number }[];
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (campaignIds.length === 0) return;

    void (async () => {
      // Everyone who shares a campaign with this character.
      const lists = await Promise.all(
        campaignIds.map((id) =>
          api
            .get<{ members: Member[] }>(`/api/campaigns/${id}/members`)
            .then((r) => r.members)
            .catch(() => []),
        ),
      );

      const seen = new Map<string, Member>();
      for (const member of lists.flat()) {
        if (member.id !== ownerUserId) seen.set(member.id, member);
      }
      setMembers([...seen.values()]);
    })();
  }, [campaignIds.join(','), ownerUserId]);

  async function setLevel(userId: string, level: OwnershipLevel) {
    setBusy(userId);
    try {
      await api.put(`/api/actors/${actorId}/ownership/${userId}`, { level });
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  if (campaignIds.length === 0) {
    return (
      <p className="text-sm text-ink-500">
        Assign this character to a campaign to share it with the people in it.
      </p>
    );
  }

  if (members.length === 0) {
    return <p className="text-sm text-ink-500">Nobody else is in this campaign yet.</p>;
  }

  return (
    <ul className="space-y-2">
      {members.map((member) => {
        const current = (grants.find((g) => g.userId === member.id)?.level ?? 0) as OwnershipLevel;

        return (
          <li key={member.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-ink-200">
              {member.displayName}
              {member.role === 'dm' && <span className="ml-1 text-[10px] text-ember-400">DM</span>}
            </span>
            <select
              value={current}
              disabled={busy === member.id}
              aria-label={`Access for ${member.displayName}`}
              onChange={(e) => void setLevel(member.id, Number(e.target.value) as OwnershipLevel)}
              className="rounded border border-ink-600 bg-ink-850 px-2 py-1 text-xs text-ink-100 focus:border-arcane-400 focus:outline-none"
            >
              {LEVELS.map((level) => (
                <option key={level.value} value={level.value} title={level.hint}>
                  {level.label}
                </option>
              ))}
            </select>
          </li>
        );
      })}
    </ul>
  );
}
