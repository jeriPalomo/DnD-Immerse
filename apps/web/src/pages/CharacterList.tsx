import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { abilityModifier, formatModifier } from '@dnd/shared';
import { Alert, Badge, Button, Card, EmptyState, Spinner } from '../components/ui.js';
import { api } from '../lib/api.js';
import type { Actor } from '../store/sheet.js';

type RosterEntry = Actor & { campaigns: { id: string; name: string }[] };

export default function CharacterList() {
  const [actors, setActors] = useState<RosterEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

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

  async function create() {
    setCreating(true);
    try {
      const { actor } = await api.post<{ actor: Actor }>('/api/actors', { name: 'New Character' });
      navigate(`/characters/${actor.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create character');
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-ink-100">Your characters</h1>
          <p className="mt-1 text-sm text-ink-400">
            Characters belong to you, not to a campaign — bring them into any story you join.
          </p>
        </div>
        <Button onClick={() => void create()} loading={creating}>
          New character
        </Button>
      </header>

      {error && <Alert>{error}</Alert>}

      {loading ? (
        <Spinner />
      ) : actors.length === 0 ? (
        <EmptyState
          title="No characters yet"
          description="Create a sheet, then assign it to one of your campaigns to bring it to the table."
          action={<Button onClick={() => void create()}>Create your first character</Button>}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {actors.map((actor) => (
            <li key={actor.id}>
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
