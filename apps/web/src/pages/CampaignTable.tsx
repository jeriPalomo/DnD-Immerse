import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { OWNERSHIP, abilityModifier, formatModifier } from '@dnd/shared';
import { Alert, Badge, Card, Spinner } from '../components/ui.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { api } from '../lib/api.js';
import { useTable } from '../store/table.js';
import { useAuth } from '../store/auth.js';
import type { Actor, Item } from '../store/sheet.js';

type PartyMember = Partial<Actor> & { id: string; name: string; access: number };

/** The live table: party status on the left, chat and dice on the right. */
export default function CampaignTable() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const table = useTable();

  const [campaign, setCampaign] = useState<{ name: string; role: string } | null>(null);
  const [party, setParty] = useState<PartyMember[]>([]);
  const [myItems, setMyItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    table.connect(id);
    return () => table.disconnect();
    // Reconnect only when the campaign changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const [campaignRes, partyRes] = await Promise.all([
          api.get<{ campaign: { name: string; role: string } }>(`/api/campaigns/${id}`),
          api.get<{ actors: PartyMember[] }>(`/api/campaigns/${id}/actors`),
        ]);
        setCampaign(campaignRes.campaign);
        setParty(partyRes.actors);

        // Default to speaking as your own character in this campaign.
        const mine = partyRes.actors.find((a) => a.ownerUserId === user?.id);
        if (mine) {
          useTable.getState().setActiveActor(mine.id);
          const items = await api.get<{ items: Item[] }>(`/api/actors/${mine.id}/items`);
          setMyItems(items.items);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load the table');
      } finally {
        setLoading(false);
      }
    })();
  }, [id, user?.id]);

  if (loading) return <Spinner />;
  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Alert>{error}</Alert>
      </div>
    );
  }

  const activeActorId = table.activeActorId;
  const usable = myItems.filter((i) => i.type === 'weapon' || i.type === 'spell');

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link to={`/campaigns/${id}`} className="text-sm text-ink-400 hover:text-ink-200">
          &larr; {campaign?.name}
        </Link>
        {campaign?.role === 'dm' && <Badge tone="dm">DM</Badge>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 font-display text-lg text-ink-100">The party</h2>
            {party.length === 0 ? (
              <p className="text-sm text-ink-500">
                No characters yet. Assign one from your character list.
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {party.map((member) => (
                  <PartyCard key={member.id} member={member} isSelf={member.ownerUserId === user?.id} />
                ))}
              </ul>
            )}
          </Card>

          {activeActorId && usable.length > 0 && (
            <Card className="p-4">
              <h2 className="mb-1 font-display text-lg text-ink-100">Your actions</h2>
              <p className="mb-3 text-xs text-ink-500">
                Posts a card to chat with buttons to roll. The server does the rolling.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {usable.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => table.postCard(item.id, activeActorId)}
                    className="rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-sm text-ink-200 transition-colors hover:border-ember-500 hover:text-ember-300"
                  >
                    {item.name}
                    {item.type === 'spell' && (
                      <span className="ml-1.5 text-[10px] text-ink-500">
                        {item.system.level === 0 ? 'C' : item.system.level}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="h-[calc(100vh-9rem)] lg:sticky lg:top-6">
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}

function PartyCard({ member, isSelf }: { member: PartyMember; isSelf: boolean }) {
  // A player without observer access sees only name, portrait and class.
  const detailed = (member.access ?? 0) >= OWNERSHIP.observer;
  const hpPercent =
    detailed && member.hpMax ? Math.max(0, Math.min(100, ((member.hpCurrent ?? 0) / member.hpMax) * 100)) : 0;

  return (
    <li
      className={`rounded-lg border p-3 ${
        isSelf ? 'border-ember-500/40 bg-ember-500/5' : 'border-ink-700 bg-ink-850'
      }`}
    >
      <div className="flex items-center gap-2">
        <div className="size-8 shrink-0 overflow-hidden rounded bg-ink-800">
          {member.portraitUrl ? (
            <img src={member.portraitUrl} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-xs text-ink-500">
              {member.name.slice(0, 1)}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <Link to={`/characters/${member.id}`} className="block truncate text-sm text-ink-100 hover:text-ember-300">
            {member.name}
          </Link>
          <div className="truncate text-[11px] text-ink-500">
            {[member.race, member.className && `${member.className} ${member.level}`]
              .filter(Boolean)
              .join(' ')}
          </div>
        </div>
        {detailed && member.dex !== undefined && (
          <span className="text-[11px] text-ink-500">
            init {formatModifier(abilityModifier(member.dex))}
          </span>
        )}
      </div>

      {detailed ? (
        <div className="mt-2">
          <div className="flex justify-between text-[11px] text-ink-400">
            <span>
              {member.hpCurrent}/{member.hpMax} HP
            </span>
            <span>AC {member.armorClass}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-900">
            <div
              className={`h-full ${hpPercent <= 50 ? 'bg-ember-500' : 'bg-emerald-600'}`}
              style={{ width: `${hpPercent}%` }}
            />
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-ink-600">Sheet not shared</p>
      )}
    </li>
  );
}
