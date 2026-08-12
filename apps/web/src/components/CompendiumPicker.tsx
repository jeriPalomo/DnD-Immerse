import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Spinner } from './ui.js';
import { api } from '../lib/api.js';

interface SpellRow {
  id: string;
  name: string;
  level: number;
  school: string;
  castingTime: string;
  range: string;
  concentration: boolean;
  ritual: boolean;
  classes: string[];
}

interface ItemRow {
  id: string;
  name: string;
  category: string;
  itemType: string;
  cost: string;
  weight: number;
}

/**
 * Search across the SRD compendium and grant an entry to a sheet.
 *
 * Because import already stored each SRD row in Item `system` shape, adding one
 * is a copy on the server rather than a conversion here.
 */
export function CompendiumPicker({
  kind,
  ruleset = '2014',
  onAdd,
  onClose,
}: {
  kind: 'spell' | 'item';
  ruleset?: '2014' | '2024';
  onAdd: (srdId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<number | ''>('');
  const [rows, setRows] = useState<(SpellRow | ItemRow)[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Debounced so typing does not fire a request per keystroke.
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (query) params.set('q', query);
        if (kind === 'spell' && level !== '') params.set('level', String(level));
        params.set('ruleset', ruleset);

        const path = `/api/compendium/${kind === 'spell' ? 'spells' : 'items'}?${params}`;
        const res = await api.get<{ spells?: SpellRow[]; items?: ItemRow[] }>(path);
        if (!cancelled) {
          setRows(res.spells ?? res.items ?? []);
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
  }, [query, level, kind, ruleset]);

  const levels = useMemo(() => Array.from({ length: 10 }, (_, i) => i), []);

  async function add(id: string) {
    setAdding(id);
    try {
      await onAdd(id);
    } finally {
      setAdding(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-16 backdrop-blur-sm">
      <div className="flex max-h-[75vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-ink-800 p-4">
          <h2 className="font-display text-lg text-ink-100">
            {kind === 'spell' ? 'Spells' : 'Equipment'}
          </h2>
          <span className="text-xs text-ink-500">
            {ruleset === '2024' ? 'SRD 5.2 · 2024' : 'SRD 5.1 · 2014'}
          </span>
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex gap-2 border-b border-ink-800 p-3">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={kind === 'spell' ? 'Search spells…' : 'Search equipment…'}
          />
          {kind === 'spell' && (
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value === '' ? '' : Number(e.target.value))}
              className="rounded-lg border border-ink-600 bg-ink-850 px-3 text-sm text-ink-100 focus:border-arcane-400 focus:outline-none"
            >
              <option value="">All levels</option>
              {levels.map((l) => (
                <option key={l} value={l}>
                  {l === 0 ? 'Cantrip' : `Level ${l}`}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-ink-500">Nothing matches that search.</p>
          ) : (
            <ul className="divide-y divide-ink-800">
              {rows.map((row) => (
                <li key={row.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-850">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-ink-100">{row.name}</div>
                    <div className="truncate text-xs text-ink-500">{describe(row)}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={adding === row.id}
                    onClick={() => void add(row.id)}
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

function describe(row: SpellRow | ItemRow): string {
  if ('level' in row) {
    const parts = [
      row.level === 0 ? `${row.school} cantrip` : `Level ${row.level} ${row.school.toLowerCase()}`,
      row.castingTime,
      row.range,
    ];
    if (row.concentration) parts.push('Concentration');
    if (row.ritual) parts.push('Ritual');
    return parts.filter(Boolean).join(' · ');
  }
  const mastery = (row as { system?: { mastery?: string } }).system?.mastery;
  return [row.category, row.cost, row.weight ? `${row.weight} lb` : '', mastery && `Mastery: ${mastery}`]
    .filter(Boolean)
    .join(' · ');
}
