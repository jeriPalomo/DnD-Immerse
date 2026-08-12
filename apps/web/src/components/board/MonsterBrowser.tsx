import { useEffect, useState } from 'react';
import { Button, Input, Spinner } from '../ui.js';
import { api } from '../../lib/api.js';

interface Monster {
  id: string;
  name: string;
  size: string;
  type: string;
  armorClass: number;
  hitPoints: number;
  challengeRating: string;
  tokenSize: number;
}

/**
 * The SRD bestiary.
 *
 * Adding a monster stamps an NPC sheet sized from its stat block — a Gargantuan
 * dragon becomes a 4x4 unlinked token, so five goblins keep five independent
 * HP pools. Without this the DM's roster only ever held what the seed inserted.
 */
export function MonsterBrowser({
  campaignId,
  onAdded,
  onClose,
}: {
  campaignId: string;
  onAdded: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [monsters, setMonsters] = useState<Monster[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (query) params.set('q', query);

        const res = await api.get<{ monsters: Monster[] }>(`/api/compendium/monsters?${params}`);
        if (!cancelled) {
          setMonsters(res.monsters);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  async function add(monsterId: string) {
    setAdding(monsterId);
    try {
      await api.post(`/api/campaigns/${campaignId}/actors/from-monster`, { monsterId });
      onAdded();
    } finally {
      setAdding(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-16 backdrop-blur-sm">
      <div className="flex max-h-[75vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-ink-800 p-4">
          <h2 className="font-display text-lg text-ink-100">Bestiary</h2>
          <span className="text-xs text-ink-500">SRD 5.1</span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="border-b border-ink-800 p-3">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search monsters…"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <Spinner />
          ) : monsters.length === 0 ? (
            <p className="p-8 text-center text-sm text-ink-500">Nothing matches that search.</p>
          ) : (
            <ul className="divide-y divide-ink-800">
              {monsters.map((monster) => (
                <li key={monster.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-850">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink-100">
                      {monster.name}
                      <span className="ml-2 text-xs text-ink-500">CR {monster.challengeRating}</span>
                    </div>
                    <div className="truncate text-xs text-ink-500">
                      {monster.size} {monster.type} · AC {monster.armorClass} · {monster.hitPoints} HP
                      {monster.tokenSize > 1 && (
                        <span className="ml-1 text-arcane-400">
                          · {monster.tokenSize}×{monster.tokenSize} token
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={adding === monster.id}
                    onClick={() => void add(monster.id)}
                  >
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
