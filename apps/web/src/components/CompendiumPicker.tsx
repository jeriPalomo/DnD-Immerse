import { useEffect, useMemo, useState } from 'react';
import {
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  SPELL_CLASSES,
  SPELL_SCHOOLS,
  maxSpellLevel,
  type ItemCategory,
  type ItemType,
} from '@dnd/shared';
import { Button, Input, Spinner } from './ui.js';
import { ManualItemForm } from './ManualItemForm.js';
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

const PAGE_SIZE = 60;

/**
 * Browse the SRD compendium and grant an entry to a sheet.
 *
 * Because import already stored each SRD row in Item `system` shape, adding one
 * is a copy on the server rather than a conversion here.
 *
 * It opens showing the list rather than an empty box: "what does the compendium
 * have" is the more common question than "where is this exact spell", and you
 * cannot search for something whose name you do not know. The filters exist for
 * the same reason - 204 of the 319 spells are on the wizard list, so browsing is
 * only useful if it narrows.
 */
export function CompendiumPicker({
  kind,
  initialCategory = null,
  ruleset = '2014',
  casterClass = '',
  casterLevel = 20,
  onAdd,
  onCreate,
  onClose,
}: {
  kind: 'spell' | 'item';
  /** Opens pre-filtered, so the Attacks panel offers weapons rather than everything. */
  initialCategory?: ItemCategory | null;
  ruleset?: '2014' | '2024';
  /**
   * The character browsing. Their class pre-filters the list, and their level
   * decides what they can actually take - every spell on the class list stays
   * visible, because knowing what is coming is half of levelling up.
   */
  casterClass?: string;
  casterLevel?: number;
  onAdd: (srdId: string) => Promise<void>;
  /** Hand-entry for things the SRD does not publish. */
  onCreate: (type: ItemType, name: string, system: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<number | ''>('');
  const [school, setSchool] = useState('');
  // Defaults to the character's own class when it is one that casts.
  const [spellClass, setSpellClass] = useState(
    SPELL_CLASSES.find((c) => c.toLowerCase() === casterClass.trim().toLowerCase()) ?? '',
  );
  const [category, setCategory] = useState<ItemCategory | ''>(initialCategory ?? '');

  /** The highest level this character can take. -1 when the class never casts. */
  const ceiling = casterClass ? maxSpellLevel(casterClass, casterLevel) : 9;
  const [rows, setRows] = useState<(SpellRow | ItemRow)[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [manual, setManual] = useState(false);

  const path = useMemo(() => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (kind === 'spell') {
      if (level !== '') params.set('level', String(level));
      if (school) params.set('school', school);
      if (spellClass) params.set('class', spellClass);
    } else if (category) {
      params.set('category', category);
    }
    params.set('ruleset', ruleset);
    params.set('limit', String(PAGE_SIZE));
    return `/api/compendium/${kind === 'spell' ? 'spells' : 'items'}?${params}`;
  }, [query, level, school, spellClass, category, kind, ruleset]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Debounced so typing does not fire a request per keystroke.
    const timer = setTimeout(async () => {
      try {
        const res = await api.get<{ spells?: SpellRow[]; items?: ItemRow[]; more?: boolean }>(path);
        if (!cancelled) {
          setRows(res.spells ?? res.items ?? []);
          setMore(Boolean(res.more));
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
  }, [path]);

  /** Appends the next page rather than replacing, so the scroll position holds. */
  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await api.get<{ spells?: SpellRow[]; items?: ItemRow[]; more?: boolean }>(
        `${path}&offset=${rows.length}`,
      );
      const next = res.spells ?? res.items ?? [];
      setRows((current) => [...current, ...next]);
      setMore(Boolean(res.more));
    } finally {
      setLoadingMore(false);
    }
  }

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
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-ink-800 p-4">
          <h2 className="font-display text-lg text-ink-100">
            {manual ? 'Add your own' : kind === 'spell' ? 'Spells' : 'Equipment'}
          </h2>
          {/* Which SRD you are browsing. Meaningless once you are typing your
              own item in, so it goes away rather than claiming a source. */}
          {!manual && (
            <span className="text-xs text-ink-500">
              {ruleset === '2024' ? 'SRD 5.2 · 2024' : 'SRD 5.1 · 2014'}
            </span>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded px-2 py-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {manual ? (
          <ManualItemForm
            kind={kind}
            initialCategory={initialCategory}
            onCancel={() => setManual(false)}
            onCreate={async (type, name, system) => {
              await onCreate(type, name, system);
              onClose();
            }}
          />
        ) : (
          <>
            <div className="flex flex-wrap gap-2 border-b border-ink-800 p-3">
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={kind === 'spell' ? 'Search spells…' : 'Search equipment…'}
              />
              {kind === 'spell' ? (
                <>
                  <Select
                    label="Spell level"
                    value={level === '' ? '' : String(level)}
                    onChange={(v) => setLevel(v === '' ? '' : Number(v))}
                  >
                    <option value="">All levels</option>
                    {levels.map((l) => (
                      <option key={l} value={l}>
                        {l === 0 ? 'Cantrip' : `Level ${l}`}
                      </option>
                    ))}
                  </Select>
                  <Select label="Class" value={spellClass} onChange={setSpellClass}>
                    <option value="">All classes</option>
                    {SPELL_CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                  <Select label="School" value={school} onChange={setSchool}>
                    <option value="">All schools</option>
                    {SPELL_SCHOOLS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </>
              ) : (
                <Select label="Category" value={category} onChange={(v) => setCategory(v as ItemCategory | '')}>
                  <option value="">Everything</option>
                  {ITEM_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {ITEM_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </Select>
              )}
            </div>

            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <Spinner />
              ) : rows.length === 0 ? (
                // With no query and no filters, an empty list means the
                // compendium was never imported - not that the search failed.
                <p className="p-8 text-center text-sm text-ink-500">
                  {query || category || level !== '' || spellClass || school ? (
                    'Nothing matches that search.'
                  ) : (
                    <>
                      The compendium is empty. Run{' '}
                      <code className="text-ink-300">npm run srd:import</code> to fill it.
                    </>
                  )}
                </p>
              ) : (
                <>
                  <ul className="divide-y divide-ink-800">
                    {rows.map((row) => {
                      // Out-of-reach spells stay listed - seeing what is coming
                      // is half of levelling up - but cannot be taken yet.
                      const spellLevel = kind === 'spell' ? ((row as SpellRow).level ?? 0) : 0;
                      const tooHigh = kind === 'spell' && spellLevel > ceiling;
                      return (
                        <li
                          key={row.id}
                          className={`flex items-center gap-3 px-4 py-2.5 hover:bg-ink-850 ${
                            tooHigh ? 'opacity-50' : ''
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-ink-100">{row.name}</div>
                            <div className="truncate text-xs text-ink-500">
                              {describe(row)}
                              {tooHigh && (
                                <span className="ml-1.5 text-ember-400">
                                  {ceiling < 0
                                    ? `${casterClass} does not cast`
                                    : `needs level ${spellLevel} slots`}
                                </span>
                              )}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={tooHigh}
                            loading={adding === row.id}
                            onClick={() => void add(row.id)}
                          >
                            Add
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                  {more && (
                    <div className="p-3 text-center">
                      <Button size="sm" variant="ghost" loading={loadingMore} onClick={() => void loadMore()}>
                        Load more
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-2 border-t border-ink-800 px-4 py-2.5">
              <span className="text-xs text-ink-500">
                {rows.length} shown{more ? '+' : ''}
              </span>
              <button
                onClick={() => setManual(true)}
                className="ml-auto text-xs text-arcane-400 hover:text-arcane-300 hover:underline"
              >
                Not in the list — add your own
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Select({
  value,
  label,
  onChange,
  children,
}: {
  value: string;
  /** Named, because "All levels" beside "All schools" tells a screen reader nothing. */
  label: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-ink-600 bg-ink-850 px-3 py-1.5 text-sm text-ink-100 focus:border-arcane-400 focus:outline-none"
    >
      {children}
    </select>
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
