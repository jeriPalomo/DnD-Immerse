import { Alert, EmptyState, Spinner } from '../components/ui.js';
import { ActorCard, useRoster } from '../components/roster.js';

/**
 * The cast a campaign accumulates: NPCs you wrote, and monsters stamped out of
 * the bestiary.
 *
 * The empty state names the bestiary on purpose. It lives on the battle map,
 * behind Scene → Tokens, which is not somewhere a DM looking at an empty shelf
 * here would ever think to look.
 */
export default function NpcList() {
  const { actors, loading, error } = useRoster();
  const npcs = actors.filter((actor) => actor.type === 'npc');

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-bold text-ink-100">NPCs</h1>
        <p className="mt-1 text-sm text-ink-400">
          The cast for the campaigns you run — written by hand, or stamped from the bestiary.
        </p>
      </header>

      {error && <Alert>{error}</Alert>}

      {loading ? (
        <Spinner />
      ) : npcs.length === 0 ? (
        <EmptyState
          title="No NPCs yet"
          description="Open a scene at the table and use Add from bestiary to stamp a monster, or New NPC to write one. They collect here."
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {npcs.map((actor) => (
            <li key={actor.id}>
              <ActorCard actor={actor} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
