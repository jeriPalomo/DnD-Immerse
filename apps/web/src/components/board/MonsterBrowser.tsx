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
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, any> | null>(null);

  // Fetch the full stat block only when a row is opened; the list carries
  // enough to choose by, and 334 stat blocks is a lot to send up front.
  useEffect(() => {
    if (!expanded) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    void api
      .get<{ monster: Record<string, any> }>(`/api/compendium/monsters/${expanded}`)
      .then((res) => {
        if (!cancelled) setDetail(res.monster);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [expanded]);

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
                <li key={monster.id} className="hover:bg-ink-850">
                  <div className="flex items-center gap-3 px-4 py-2.5">
                    <button
                      onClick={() => setExpanded(expanded === monster.id ? null : monster.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-sm text-ink-100">
                        {expanded === monster.id ? '▾ ' : '▸ '}
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
                    </button>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={adding === monster.id}
                      onClick={() => void add(monster.id)}
                    >
                      Add
                    </Button>
                  </div>

                  {expanded === monster.id && (
                    <div className="border-t border-ink-800 bg-ink-950/50 px-4 py-3 text-xs text-ink-300">
                      {!detail ? (
                        <p className="text-ink-600">Loading stat block…</p>
                      ) : (
                        <StatBlock monster={detail} />
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** The parts of a stat block a DM checks before dropping the monster in. */
function StatBlock({ monster }: { monster: Record<string, any> }) {
  const data = (monster.data ?? {}) as Record<string, any>;
  const abilities = [
    ['STR', monster.str], ['DEX', monster.dex], ['CON', monster.con],
    ['INT', monster.int], ['WIS', monster.wis], ['CHA', monster.cha],
  ] as const;

  const actions = (data.actions ?? []) as { name: string; desc: string }[];
  const traits = (data.special_abilities ?? []) as { name: string; desc: string }[];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        {abilities.map(([label, score]) => (
          <div key={label} className="text-center">
            <div className="text-[10px] tracking-wide text-ink-500">{label}</div>
            <div className="font-mono text-ink-200">
              {score}
              <span className="ml-1 text-ink-500">
                ({Math.floor((Number(score) - 10) / 2) >= 0 ? '+' : ''}
                {Math.floor((Number(score) - 10) / 2)})
              </span>
            </div>
          </div>
        ))}
      </div>

      {monster.speed && <p className="text-ink-400">Speed {monster.speed}</p>}

      {traits.length > 0 && (
        <div>
          <div className="mb-0.5 text-[10px] tracking-wide text-ink-500 uppercase">Traits</div>
          {traits.slice(0, 4).map((trait) => (
            <p key={trait.name} className="mb-1">
              <strong className="text-ink-200">{trait.name}.</strong> {trait.desc}
            </p>
          ))}
        </div>
      )}

      {actions.length > 0 && (
        <div>
          <div className="mb-0.5 text-[10px] tracking-wide text-ink-500 uppercase">Actions</div>
          {actions.slice(0, 5).map((action) => (
            <p key={action.name} className="mb-1">
              <strong className="text-ink-200">{action.name}.</strong> {action.desc}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
