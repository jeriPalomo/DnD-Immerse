import { abilityModifier, formatModifier, proficiencyBonus } from '@dnd/shared';
import { AttackList, SpellcastingHeader } from '../sheet/Combat.js';
import { FeaturePanel, InventoryPanel, SpellPanel } from '../sheet/ItemPanels.js';
import type { Actor, Item } from '../../store/sheet.js';

const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

/**
 * Your own sheet, at the table.
 *
 * Checking what a spell does used to mean leaving the board: the target panel
 * only offers items while you are aiming at something, and the sheet itself is
 * a different page - which during someone else's turn costs you the map, the
 * chat and your scroll position.
 *
 * Read-only on purpose. Editing mid-combat is what the sheet page is for, and
 * a drawer that can change hit points is a drawer that can lose an edit when
 * the socket pushes a damage roll over the top of it. Every panel here is the
 * one the sheet already uses, with `editable` off, so the two cannot describe
 * the same spell differently.
 */
export function MySheetDrawer({
  actor,
  items,
  onClose,
}: {
  actor: Actor;
  items: Item[];
  onClose: () => void;
}) {
  const scores = {
    str: actor.str, dex: actor.dex, con: actor.con,
    int: actor.int, wis: actor.wis, cha: actor.cha,
  };

  const weapons = items.filter((i) => i.type === 'weapon');
  const spells = items.filter((i) => i.type === 'spell');
  const gear = items.filter((i) => i.type === 'equipment' || i.type === 'consumable');
  const features = items.filter((i) => i.type === 'feature');

  const noop = () => undefined;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-ink-800 p-4">
          <div className="size-10 shrink-0 overflow-hidden rounded-lg border border-ink-700 bg-ink-800">
            {actor.portraitUrl ? (
              <img src={actor.portraitUrl} alt="" className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center font-display text-ink-500">
                {actor.name.slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-lg text-ink-100">{actor.name}</h2>
            <p className="truncate text-xs text-ink-500">
              {[actor.race, actor.className && `${actor.className} ${actor.level}`]
                .filter(Boolean)
                .join(' ') || 'Unfinished sheet'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
            {ABILITIES.map((key) => (
              <div key={key} className="rounded-lg border border-ink-800 bg-ink-850 py-1.5">
                <div className="text-[10px] tracking-wide text-ink-500 uppercase">{key}</div>
                <div className="font-mono text-ink-100">
                  {formatModifier(abilityModifier(scores[key]))}
                </div>
                <div className="text-[10px] text-ink-600">{scores[key]}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-3 text-xs text-ink-400">
            <span>AC <span className="font-mono text-ink-100">{actor.armorClass}</span></span>
            <span>
              HP <span className="font-mono text-ink-100">{actor.hpCurrent}/{actor.hpMax}</span>
            </span>
            <span>Speed <span className="font-mono text-ink-100">{actor.speed} ft</span></span>
            <span>
              Prof <span className="font-mono text-ink-100">
                {formatModifier(proficiencyBonus(actor.level))}
              </span>
            </span>
          </div>

          {weapons.length > 0 && (
            <section>
              <h3 className="mb-1 font-display text-sm text-ink-100">Attacks</h3>
              <AttackList actor={actor} weapons={weapons} />
            </section>
          )}

          {spells.length > 0 && (
            <section>
              <h3 className="mb-1 font-display text-sm text-ink-100">Spells</h3>
              <SpellcastingHeader actor={actor} />
              <SpellPanel spells={spells} editable={false} onTogglePrepared={noop} onRemove={noop} />
            </section>
          )}

          {gear.length > 0 && (
            <section>
              <h3 className="mb-1 font-display text-sm text-ink-100">Inventory</h3>
              <InventoryPanel
                items={gear}
                editable={false}
                strength={actor.str}
                onToggleEquipped={noop}
                onRemove={noop}
              />
            </section>
          )}

          {features.length > 0 && (
            <section>
              <h3 className="mb-1 font-display text-sm text-ink-100">Features &amp; Traits</h3>
              <FeaturePanel features={features} editable={false} onAdd={noop} onRemove={noop} />
            </section>
          )}
        </div>

        <p className="border-t border-ink-800 p-3 text-[11px] text-ink-600">
          Read-only. Open the full sheet from Characters to make changes.
        </p>
      </div>
    </div>
  );
}
