import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, EmptyState, Spinner } from '../components/ui.js';
import { ActorCard, useRoster } from '../components/roster.js';
import { api } from '../lib/api.js';
import type { Actor } from '../store/sheet.js';

/**
 * The sheets you rolled up.
 *
 * NPCs live on their own page rather than a second tab here: they are a
 * different job - prep, not play - and one goblin per encounter buries the
 * four characters you actually sit down with. The split is on `type`, never on
 * campaign assignment: a character is yours whether or not it is currently at
 * a table.
 */
export default function CharacterList() {
  const { actors, loading, error, setError } = useRoster();
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();

  const characters = actors.filter((actor) => actor.type !== 'npc');

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
      ) : characters.length === 0 ? (
        <EmptyState
          title="No characters yet"
          description="Create a sheet, then assign it to one of your campaigns to bring it to the table."
          action={<Button onClick={() => void create()}>Create your first character</Button>}
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {characters.map((actor) => (
            <li key={actor.id}>
              <ActorCard actor={actor} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
