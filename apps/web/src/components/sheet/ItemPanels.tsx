import { useState } from 'react';
import { carryingCapacity } from '@dnd/shared';
import { Button } from '../ui.js';
import type { Item } from '../../store/sheet.js';

const SPELL_LEVELS = ['Cantrips', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

/** Spells grouped by level, with prepared toggles. */
export function SpellPanel({
  spells,
  editable,
  onTogglePrepared,
  onRemove,
}: {
  spells: Item[];
  editable: boolean;
  onTogglePrepared: (id: string, prepared: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (spells.length === 0) {
    return <p className="px-1 py-3 text-sm text-ink-500">No spells known.</p>;
  }

  const byLevel = new Map<number, Item[]>();
  for (const spell of spells) {
    const level = spell.system.level ?? 0;
    byLevel.set(level, [...(byLevel.get(level) ?? []), spell]);
  }

  return (
    <div className="space-y-3">
      {[...byLevel.keys()]
        .sort((a, b) => a - b)
        .map((level) => (
          <div key={level}>
            <h4 className="mb-1 text-[10px] font-semibold tracking-wider text-ink-400 uppercase">
              {SPELL_LEVELS[level] ?? `Level ${level}`}
            </h4>
            <ul className="divide-y divide-ink-800 rounded-lg border border-ink-700 bg-ink-850">
              {byLevel.get(level)!.map((spell) => {
                const s = spell.system;
                const isOpen = expanded === spell.id;
                return (
                  <li key={spell.id}>
                    <div className="flex items-center gap-2 px-3 py-2">
                      {level > 0 && (
                        <button
                          type="button"
                          disabled={!editable}
                          onClick={() => onTogglePrepared(spell.id, !s.prepared)}
                          title={s.prepared ? 'Prepared' : 'Not prepared'}
                          className={`size-3 shrink-0 rounded-full border transition-colors ${
                            s.prepared ? 'border-ember-400 bg-ember-400' : 'border-ink-500'
                          }`}
                        />
                      )}
                      <button
                        onClick={() => setExpanded(isOpen ? null : spell.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="text-sm text-ink-100">{spell.name}</span>
                        <span className="ml-2 text-xs text-ink-500">
                          {s.rangeText}
                          {s.concentration ? ' · C' : ''}
                          {s.ritual ? ' · R' : ''}
                        </span>
                      </button>
                      {s.damageDice && (
                        <span className="font-mono text-xs text-ember-300">{s.damageDice}</span>
                      )}
                      {editable && (
                        <button
                          onClick={() => onRemove(spell.id)}
                          className="text-ink-600 hover:text-red-400"
                          aria-label={`Remove ${spell.name}`}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    {isOpen && (
                      <div className="border-t border-ink-800 bg-ink-900/60 px-3 py-2 text-xs text-ink-300">
                        <dl className="mb-2 grid grid-cols-2 gap-x-4 gap-y-1 text-ink-400 sm:grid-cols-4">
                          <Detail label="Casting" value={s.castingTime} />
                          <Detail label="Range" value={s.rangeText} />
                          <Detail label="Duration" value={s.duration} />
                          <Detail label="School" value={s.school} />
                        </dl>
                        {s.save && (
                          <p className="mb-2 text-ember-300">
                            {String(s.save.ability).toUpperCase()} save
                            {s.save.halfOnSuccess ? ', half on success' : ''}
                          </p>
                        )}
                        <p className="whitespace-pre-wrap">{s.description}</p>
                        {s.higherLevel && (
                          <p className="mt-2 whitespace-pre-wrap text-ink-400">
                            <strong className="text-ink-300">At higher levels.</strong> {s.higherLevel}
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-[10px] tracking-wide uppercase">{label}</dt>
      <dd className="text-ink-200">{value}</dd>
    </div>
  );
}

/** Equipment, consumables and other physical gear. */
export function InventoryPanel({
  items,
  editable,
  strength,
  onToggleEquipped,
  onRemove,
}: {
  items: Item[];
  editable: boolean;
  /** Carrying capacity is STR x 15, so an overloaded pack can be flagged. */
  strength: number;
  onToggleEquipped: (id: string, equipped: boolean) => void;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) {
    return <p className="px-1 py-3 text-sm text-ink-500">Nothing carried.</p>;
  }

  const totalWeight = items.reduce(
    (sum, i) => sum + (i.system.weight ?? 0) * (i.system.quantity ?? 1),
    0,
  );
  const capacity = carryingCapacity({ str: strength, dex: 10, con: 10, int: 10, wis: 10, cha: 10 });
  const overloaded = totalWeight > capacity;

  return (
    <div>
      <ul className="divide-y divide-ink-800 rounded-lg border border-ink-700 bg-ink-850">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2 px-3 py-2">
            <button
              type="button"
              disabled={!editable}
              onClick={() => onToggleEquipped(item.id, !item.system.equipped)}
              title={item.system.equipped ? 'Equipped' : 'Stowed'}
              className={`size-3 shrink-0 rounded-sm border transition-colors ${
                item.system.equipped ? 'border-emerald-400 bg-emerald-500' : 'border-ink-500'
              }`}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-ink-100">
              {item.name}
              {(item.system.quantity ?? 1) > 1 && (
                <span className="ml-1 text-ink-500">×{item.system.quantity}</span>
              )}
            </span>
            {item.system.armorType && item.system.armorType !== 'none' && (
              <span className="text-xs text-ink-500">AC {item.system.baseAC}</span>
            )}
            {item.system.weight > 0 && (
              <span className="w-14 text-right text-xs text-ink-500">{item.system.weight} lb</span>
            )}
            {editable && (
              <button
                onClick={() => onRemove(item.id)}
                className="text-ink-600 hover:text-red-400"
                aria-label={`Remove ${item.name}`}
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-right text-xs">
        <span className={overloaded ? 'text-ember-400' : 'text-ink-500'}>
          Total {totalWeight.toFixed(1)} lb
        </span>
        <span className="text-ink-600"> / {capacity} lb</span>
        {overloaded && <span className="ml-1 text-ember-400">encumbered</span>}
      </p>
    </div>
  );
}

/** Class and racial features, with a free-text add. */
export function FeaturePanel({
  features,
  editable,
  onAdd,
  onRemove,
}: {
  features: Item[];
  editable: boolean;
  onAdd: (name: string) => void;
  onRemove: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      {features.length > 0 && (
        <ul className="divide-y divide-ink-800 rounded-lg border border-ink-700 bg-ink-850">
          {features.map((feature) => (
            <li key={feature.id}>
              <div className="flex items-center gap-2 px-3 py-2">
                <button
                  onClick={() => setExpanded(expanded === feature.id ? null : feature.id)}
                  className="min-w-0 flex-1 truncate text-left text-sm text-ink-100"
                >
                  {feature.name}
                  {feature.system.source && (
                    <span className="ml-2 text-xs text-ink-500">{feature.system.source}</span>
                  )}
                </button>
                {editable && (
                  <button
                    onClick={() => onRemove(feature.id)}
                    className="text-ink-600 hover:text-red-400"
                    aria-label={`Remove ${feature.name}`}
                  >
                    ✕
                  </button>
                )}
              </div>
              {expanded === feature.id && feature.system.description && (
                <p className="border-t border-ink-800 bg-ink-900/60 px-3 py-2 text-xs whitespace-pre-wrap text-ink-300">
                  {feature.system.description}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            onAdd(name.trim());
            setName('');
          }}
          className="flex gap-2"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Add a feature…"
            className="flex-1 rounded-lg border border-ink-600 bg-ink-850 px-3 py-1.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-arcane-400 focus:outline-none"
          />
          <Button size="sm" variant="secondary" type="submit">
            Add
          </Button>
        </form>
      )}
    </div>
  );
}
