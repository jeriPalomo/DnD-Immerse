import { attackModeAgainst, tokenDistanceInFeet } from '@dnd/shared';
import type { WireScene, WireToken } from '@dnd/shared';
import type { Actor, Item } from '../../store/sheet.js';

/**
 * What you could legally do to the targeted token, and — when you can't — why.
 *
 * Illegal options are greyed out and labelled rather than hidden. Hiding them
 * makes the app feel arbitrary; naming the reason teaches the rule mid-session
 * and lets a player argue the ruling with the DM.
 */

export interface Option {
  item: Item;
  legal: boolean;
  reason: string;
  /** Range in feet this option reaches, for the tooltip. */
  reach: number | null;
  longRange: boolean;
}

const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'];

/**
 * Reach for one item, in feet. Touch is 5 ft (adjacent), self-only spells
 * cannot be aimed at another creature at all.
 */
function reachOf(item: Item): { reach: number | null; selfOnly: boolean; long: number | null } {
  const range = item.system.range as { type?: string; value?: number; long?: number | null } | undefined;
  if (!range) return { reach: 5, selfOnly: false, long: null };

  switch (range.type) {
    case 'self':
      return { reach: null, selfOnly: true, long: null };
    case 'touch':
      return { reach: 5, selfOnly: false, long: null };
    case 'sight':
    case 'unlimited':
      return { reach: Number.POSITIVE_INFINITY, selfOnly: false, long: null };
    default:
      return { reach: range.value ?? 0, selfOnly: false, long: range.long ?? null };
  }
}

function slotsAvailable(actor: Actor, level: number): boolean {
  if (level === 0) return true; // Cantrips are unlimited.
  const max = actor.spellSlots?.max?.[level - 1] ?? 0;
  const used = actor.spellSlots?.used?.[level - 1] ?? 0;
  return max - used > 0;
}

export function evaluateOptions({
  items,
  actor,
  self,
  target,
  scene,
}: {
  items: Item[];
  actor: Actor | null;
  self: WireToken;
  target: WireToken;
  scene: WireScene;
}): Option[] {
  // Footprint to footprint: standing against a Gargantuan dragon's flank is
  // 5 ft, not the 25 ft a centre-to-centre measure would report.
  const distance = tokenDistanceInFeet(self, target, 'standard', scene.feetPerSquare);

  return items
    .filter((item) => item.type === 'weapon' || item.type === 'spell')
    .map((item) => {
      const { reach, selfOnly, long } = reachOf(item);
      const level = (item.system.level as number | undefined) ?? 0;

      if (selfOnly) {
        return { item, legal: false, reason: 'Affects only you', reach: null, longRange: false };
      }

      if (item.type === 'spell' && actor && !slotsAvailable(actor, level)) {
        return {
          item,
          legal: false,
          reason: `No ${ORDINAL[level]}-level slots remaining`,
          reach,
          longRange: false,
        };
      }

      if (reach !== null && distance > reach) {
        // A thrown or ranged weapon can still reach at long range, at disadvantage.
        if (long && distance <= long) {
          return {
            item,
            legal: true,
            reason: `Long range — ${distance} ft, disadvantage`,
            reach,
            longRange: true,
          };
        }
        return {
          item,
          legal: false,
          reason: `Out of range — ${distance} ft away, reach ${reach} ft`,
          reach,
          longRange: false,
        };
      }

      const detail =
        item.type === 'spell' && level > 0
          ? `${ORDINAL[level]} level · ${distance} ft`
          : `${distance} ft away`;

      return { item, legal: true, reason: detail, reach, longRange: false };
    })
    .sort((a, b) => Number(b.legal) - Number(a.legal) || a.item.name.localeCompare(b.item.name));
}

export function TargetPanel({
  self,
  target,
  scene,
  actor,
  items,
  onUse,
  onClear,
}: {
  self: WireToken | null;
  target: WireToken;
  scene: WireScene;
  actor: Actor | null;
  items: Item[];
  onUse: (item: Item, longRange: boolean) => void;
  onClear: () => void;
}) {
  if (!self) {
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
        <p className="text-sm text-ink-500">Select your own token to see what you can do.</p>
      </div>
    );
  }

  const distance = tokenDistanceInFeet(self, target, 'standard', scene.feetPerSquare);
  const options = evaluateOptions({ items, actor, self, target, scene });
  // 5e cancels advantage against disadvantage rather than stacking them.
  const attack = attackModeAgainst(self, target);

  return (
    <div className="rounded-xl border border-ember-500/40 bg-ink-900 p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="font-display text-ink-100">
            Targeting <span className="text-ember-300">{target.name || 'token'}</span>
          </h3>
          <p className="text-xs text-ink-500">
            {distance} ft away
            {target.maxHp ? ` · ${target.hp}/${target.maxHp} HP` : ''}
            {target.ac ? ` · AC ${target.ac}` : ''}
          </p>
        </div>
        <button onClick={onClear} className="text-ink-500 hover:text-ink-200" aria-label="Clear target">
          ✕
        </button>
      </div>

      {attack.mode !== 'normal' && (
        <div
          className={`mb-2 rounded border px-2 py-1 text-[11px] ${
            attack.mode === 'advantage'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-red-500/40 bg-red-500/10 text-red-300'
          }`}
        >
          Attacks at {attack.mode} — {attack.reasons.join('; ')}
        </div>
      )}
      {attack.mode === 'normal' && attack.reasons.length > 0 && (
        <div className="mb-2 rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-400">
          {attack.reasons.join('; ')}
        </div>
      )}

      {options.length === 0 ? (
        <p className="text-sm text-ink-500">No weapons or spells on this sheet.</p>
      ) : (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {options.map(({ item, legal, reason, longRange }) => (
            <li key={item.id}>
              <button
                disabled={!legal}
                // `longRange` travels with the use, so the disadvantage this
                // panel already worked out reaches the roll instead of being
                // printed and dropped.
                onClick={() => onUse(item, longRange)}
                className={`w-full rounded-lg border px-2.5 py-1.5 text-left transition-colors ${
                  legal
                    ? 'border-ink-700 bg-ink-850 hover:border-ember-500'
                    : 'cursor-not-allowed border-ink-800 bg-ink-900 opacity-60'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`text-sm ${legal ? 'text-ink-100' : 'text-ink-500'}`}>
                    {item.name}
                  </span>
                  {item.system.damageDice && (
                    <span className={`font-mono text-xs ${legal ? 'text-ember-300' : 'text-ink-600'}`}>
                      {item.system.damageDice}
                    </span>
                  )}
                </div>
                <div
                  className={`text-[11px] ${
                    !legal ? 'text-red-400/80' : longRange ? 'text-ember-400' : 'text-ink-500'
                  }`}
                >
                  {reason}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
