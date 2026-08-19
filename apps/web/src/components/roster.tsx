import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { abilityModifier, formatModifier } from '@dnd/shared';
import { Badge, Card } from './ui.js';
import { api } from '../lib/api.js';
import type { Actor } from '../store/sheet.js';

export type RosterEntry = Actor & { campaigns: { id: string; name: string }[] };

/**
 * Every actor you own, characters and NPCs alike.
 *
 * Shared by the two pages that split them, so there is one fetch to keep
 * right rather than two that can disagree about what an actor is.
 */
export function useRoster(): {
  actors: RosterEntry[];
  loading: boolean;
  error: string | null;
  setError: (message: string | null) => void;
} {
  const [actors, setActors] = useState<RosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ actors: RosterEntry[] }>('/api/actors');
        setActors(res.actors);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load characters');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return { actors, loading, error, setError };
}

/**
 * One actor, on either shelf.
 *
 * Extracted rather than copied: the characters page and the NPC page render
 * the identical card, and two copies would drift the moment either grew a
 * field.
 */
export function ActorCard({ actor }: { actor: RosterEntry }) {
  return (
    <Link to={`/characters/${actor.id}`} className="block h-full">
      <Card className="flex h-full gap-4 p-4 transition-colors hover:border-ink-600 hover:bg-ink-850">
        <div className="size-16 shrink-0 overflow-hidden rounded-lg border border-ink-700 bg-ink-800">
          {actor.portraitUrl ? (
            <img src={actor.portraitUrl} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center font-display text-xl text-ink-500">
              {actor.name.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h2 className="truncate font-display text-lg text-ink-100">{actor.name}</h2>
            {actor.type === 'npc' && <Badge>NPC</Badge>}
          </div>
          <p className="truncate text-sm text-ink-400">
            {[actor.race, actor.className && `${actor.className} ${actor.level}`]
              .filter(Boolean)
              .join(' ') || 'Unfinished sheet'}
          </p>

          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-500">
            <span>AC {actor.armorClass}</span>
            <span>
              HP {actor.hpCurrent}/{actor.hpMax}
            </span>
            <span>Init {formatModifier(abilityModifier(actor.dex))}</span>
          </div>

          {actor.campaigns.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {actor.campaigns.map((c) => (
                <span
                  key={c.id}
                  className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400"
                >
                  {c.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </Card>
    </Link>
  );
}
