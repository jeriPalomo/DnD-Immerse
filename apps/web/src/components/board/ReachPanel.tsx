import { tokenDistanceInFeet } from '@dnd/shared';
import type { WireScene, WireToken } from '@dnd/shared';
import { evaluateOptions } from './TargetPanel.js';
import type { Actor, Item } from '../../store/sheet.js';

/** Enough to cover a crowded melee without listing an archer's whole sightline. */
const MAX_CREATURES = 6;

/**
 * Things that do something to a creature lead the row.
 *
 * Judged by what the item carries - damage dice, an attack roll, a save it
 * forces - never by reading its description. A touch spell like Mage Armor is
 * legal against a goblin at 5 ft and the app has no way to know you would not
 * want to, so it is sorted last rather than hidden: guessing intent from prose
 * is wrong in both directions, and a spell missing from the list is worse than
 * one sitting at the end of it.
 */
function harmful(item: Item): boolean {
  const s = item.system as Record<string, unknown>;
  return Boolean(s.damageDice || s.attackRoll || s.save || item.type === 'weapon');
}

/**
 * What you can do to whoever is near you, without picking a target first.
 *
 * Everything here was already computed for one creature at a time -
 * `evaluateOptions` measures footprint to footprint, knows a bow's long-range
 * band and checks spell slots. What it lacked was being asked about more than
 * the one creature you had already clicked, which is the wrong way round: you
 * move, and then you want to know what the move made possible.
 *
 * Only creatures with something legal against them are listed. A row that says
 * "nothing works" is noise, and the reasons are still there on the target panel
 * for the creature you commit to.
 */
export function ReachPanel({
  self,
  actor,
  items,
  tokens,
  scene,
  onUse,
}: {
  self: WireToken | null;
  actor: Actor | null;
  items: Item[];
  tokens: WireToken[];
  scene: WireScene;
  onUse: (item: Item, target: WireToken) => void;
}) {
  if (!self || items.length === 0) return null;

  const reachable = tokens
    .filter((token) => token.id !== self.id && token.layer !== 'gm')
    .map((token) => ({
      token,
      distance: tokenDistanceInFeet(self, token, 'standard', scene.feetPerSquare),
      options: evaluateOptions({ items, actor, self, target: token, scene })
        .filter((o) => o.legal)
        .sort((a, b) => Number(harmful(b.item)) - Number(harmful(a.item))),
    }))
    .filter((row) => row.options.length > 0)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_CREATURES);

  if (reachable.length === 0) return null;

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 p-2">
      <h2 className="mb-1.5 text-[10px] tracking-wider text-ink-500 uppercase">In reach</h2>

      <ul className="space-y-1.5">
        {reachable.map(({ token, distance, options }) => (
          <li key={token.id}>
            <div className="flex items-center gap-1.5">
              <div className="size-5 shrink-0 overflow-hidden rounded border border-ink-700 bg-ink-850">
                {token.imageUrl ? (
                  <img src={token.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center text-[8px] text-ink-600">
                    {(token.name || '?').slice(0, 1).toUpperCase()}
                  </div>
                )}
              </div>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-300">{token.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-ink-600">{distance} ft</span>
            </div>

            <div className="mt-1 flex flex-wrap gap-1 pl-6.5">
              {options.map(({ item, reason, longRange }) => (
                <button
                  key={item.id}
                  onClick={() => onUse(item, token)}
                  title={`${item.name} — ${reason}`}
                  className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                    longRange
                      ? 'border-ember-500/50 text-ember-300 hover:bg-ember-500/10'
                      : 'border-ink-700 text-ink-300 hover:border-arcane-400 hover:text-ink-100'
                  }`}
                >
                  {item.name}
                  {longRange && <span className="ml-1 text-[9px]">long</span>}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
