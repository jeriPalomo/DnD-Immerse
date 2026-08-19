import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui.js';
import { api } from '../../lib/api.js';
import { MonsterBrowser } from './MonsterBrowser.js';
import { useTable } from '../../store/table.js';

interface PartyActor {
  id: string;
  name: string;
  type: string;
  portraitUrl: string | null;
}

/**
 * Everything the DM puts on the board, during play.
 *
 * Lifted out of `SceneManager`, where it sat as a sub-tab of a prep panel.
 * Dropping a goblin into a live fight meant leaving the initiative tracker,
 * navigating Scene -> Tokens, and coming back - several times a session, at
 * exactly the moment the DM can least afford to lose track of whose turn it
 * is. Building a map and placing a monster are different jobs done at
 * different times, and only one of them happens with players watching.
 */
export function CreaturePanel({ campaignId }: { campaignId: string }) {
  const { scene, createToken } = useTable();
  const [actors, setActors] = useState<PartyActor[]>([]);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<{ actors: PartyActor[] }>(`/api/campaigns/${campaignId}/actors`);
    setActors(res.actors);
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * An NPC of your own, as opposed to one lifted from the bestiary.
   *
   * These start neutral; rename and re-flag from the token HUD. The campaign
   * is named in the create call as well as the assignment below, because the
   * server authorises NPC creation against that campaign's DM and cannot do
   * that for an actor belonging to no campaign at all.
   */
  async function createNpc() {
    setBusy(true);
    try {
      const { actor } = await api.post<{ actor: { id: string } }>('/api/actors', {
        name: 'New NPC',
        type: 'npc',
        campaignId,
      });
      await api.post(`/api/actors/${actor.id}/campaigns/${campaignId}`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-2">
      <div className="mb-2 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void createNpc()}>
          New NPC
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setBrowsing(true)}>
          Add from bestiary
        </Button>
      </div>

      {!scene && (
        <p className="mb-2 text-[11px] text-ink-500">
          No active scene — open one under Prep before placing anything.
        </p>
      )}

      {actors.length === 0 ? (
        <p className="text-[11px] text-ink-500">
          Nobody to place yet. Stamp a monster from the bestiary, or write an NPC by hand.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {actors.map((actor) => (
            <button
              key={actor.id}
              disabled={!scene}
              onClick={() =>
                createToken({ sceneId: scene!.id, actorId: actor.id, x: 1, y: 1, name: actor.name })
              }
              className="flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-ink-200 transition-colors hover:border-ember-500 disabled:opacity-40"
            >
              {actor.portraitUrl && (
                <img
                  src={actor.portraitUrl}
                  alt=""
                  loading="lazy"
                  className="size-5 shrink-0 rounded object-cover"
                />
              )}
              {actor.name}
              {actor.type === 'npc' && <span className="text-ink-600">NPC</span>}
            </button>
          ))}
        </div>
      )}

      {browsing && (
        <MonsterBrowser
          campaignId={campaignId}
          onAdded={() => void load()}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
