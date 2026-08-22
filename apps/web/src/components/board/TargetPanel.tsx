import { attackModeAgainst, tokenDistanceInFeet } from '@dnd/shared';
import { CreatureActions } from './CreatureActions.js';
import type { WireScene, WireToken } from '@dnd/shared';
import type { Actor, Item } from '../../store/sheet.js';

/**
 * What you could legally do to the targeted token, and — when you can't — why.
 *
 * Illegal options are greyed out and labelled rather than hidden. Hiding them
 * makes the app feel arbitrary; naming the reason teaches the rule mid-session
 * and lets a player argue the ruling with the DM.
 */

/** Where an option is filed in the list you pick from. */
export type OptionCategory = 'attack' | 'support' | 'item';

export const CATEGORY_LABELS: Record<OptionCategory, string> = {
  attack: 'Attacks',
  support: 'Support',
  item: 'Items',
};

export const CATEGORY_ORDER: OptionCategory[] = ['attack', 'support', 'item'];

/**
 * What an item is *for*, decided from what it carries.
 *
 * Damage dice, an attack roll or a save it forces make it an attack; healing
 * dice, or a spell or feature carrying none of those, make it support. Never
 * from the description: reading intent out of prose is wrong in both
 * directions, which is the line this codebase draws everywhere else.
 *
 * Consumables are filed as items whatever they do, because "what have I got"
 * is how anybody looks for a potion - and it keeps the two things you spend
 * from being scattered through the other two lists.
 *
 * Grouping only. Nothing is hidden or refused for being aimed at the wrong
 * sort of creature: a DM does sometimes need to strike their own NPC or heal a
 * hostile, and the same reasoning that keeps Mage Armor in the list rather than
 * out of it applies to the whole category.
 */
export function categoryOf(item: Item): OptionCategory {
  if (item.type === 'consumable') return 'item';

  const s = item.system as Record<string, unknown>;
  if (s.damageDice || s.attackRoll || s.save || item.type === 'weapon') return 'attack';
  if (s.healingDice) return 'support';

  return item.type === 'spell' || item.type === 'feature' ? 'support' : 'item';
}

/**
 * The options split into the three lists you pick from, empty ones dropped.
 *
 * One helper rather than three copies of the same grouping, so the token
 * popup, the target panel and the reach list cannot disagree about where a
 * potion belongs.
 */
export function groupOptions(
  options: Option[],
): { category: OptionCategory; label: string; options: Option[] }[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    options: options.filter((option) => option.category === category),
  })).filter((group) => group.options.length > 0);
}

export interface Option {
  item: Item;
  legal: boolean;
  reason: string;
  /** Attacks, Support or Items - so a misclick cannot heal an enemy. */
  category: OptionCategory;
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

/**
 * How far anything on this sheet reaches, in feet.
 *
 * `normal` is the furthest an option lands without penalty; `long` is the band
 * beyond it that a thrown or ranged weapon still covers at disadvantage. Both
 * come from `reachOf`, the same function `evaluateOptions` measures with, so
 * the area drawn on the board and the list of what is legal against a creature
 * cannot disagree - the rule AoE templates already follow.
 *
 * A spell with no slots left is skipped: drawing the reach of something you
 * cannot cast promises a shot you have not got. So is a `self` spell, which
 * reaches nobody, and a sight-range one, whose circle would be the whole map.
 */
export function reachBands(items: Item[], actor: Actor | null): { normal: number; long: number } {
  let normal = 0;
  let long = 0;

  for (const item of items) {
    const { reach, selfOnly, long: far } = reachOf(item);
    if (selfOnly || reach === null || !Number.isFinite(reach)) continue;

    const level = (item.system.level as number | undefined) ?? 0;
    if (item.type === 'spell' && actor && !slotsAvailable(actor, level)) continue;

    normal = Math.max(normal, reach);
    long = Math.max(long, far ?? reach);
  }

  return { normal, long };
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
    // Consumables join weapons and spells now that they carry dice and can
    // post a card with a button on it. One with nothing filled in is left out:
    // it would be a name you can press that does nothing, which is the whole
    // problem this was meant to fix.
    .filter((item) => {
      if (item.type === 'weapon' || item.type === 'spell') return true;
      if (item.type !== 'consumable') return false;
      const s = item.system as Record<string, unknown>;
      return Boolean(s.healingDice || s.damageDice);
    })
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
    // Filed once, at the end, rather than at each of the branches above - six
    // places to remember is five chances to forget.
    .map((option) => ({ ...option, category: categoryOf(option.item) }))
    .sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
        Number(b.legal) - Number(a.legal) ||
        a.item.name.localeCompare(b.item.name),
    );
}

export function TargetPanel({
  self,
  target,
  scene,
  actor,
  items,
  campaignId,
  onUse,
  onClear,
}: {
  self: WireToken | null;
  target: WireToken;
  scene: WireScene;
  actor: Actor | null;
  items: Item[];
  /** For reading the target's own stat block, which the server gates. */
  campaignId: string;
  onUse: (item: Item) => void;
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

      {/* Whose weapons these are. The panel is headed with the TARGET's name
          and everything under it is yours, which read as the goblin's longsword
          - and that is how it was read. Its own kit is the section below. */}
      <div className="mb-1 text-[10px] tracking-wider text-ink-600 uppercase">
        What you can do to it
      </div>

      {/* Capped shorter than the list wants to be, so the creature's own kit
          below is on screen rather than under the fold: the transient panels
          share one measured slice of the column, and a spell list that takes
          all of it hides whatever sits beneath. */}
      {options.length === 0 ? (
        <p className="text-sm text-ink-500">No weapons or spells on this sheet.</p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {/* Attacks, Support and Items kept apart, so a misclick cannot heal
              an enemy or swing at an ally. Grouping only: nothing is hidden for
              being aimed at the wrong sort of creature. */}
          {groupOptions(options).map((group) => (
            <li key={group.category}>
              <div className="mt-2 mb-1 text-[10px] tracking-wider text-ink-600 uppercase first:mt-0">
                {group.label}
              </div>
              <ul className="space-y-1">
          {group.options.map(({ item, legal, reason, longRange }) => (
            <li key={item.id}>
              <button
                disabled={!legal}
                onClick={() => onUse(item)}
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
            </li>
          ))}
        </ul>
      )}

      {/* What the creature you clicked can do back. Read-only, and gated on
          the server: an enemy's kit is campaign policy, and a party member's
          sheet is shared deliberately rather than by standing on the same
          board. */}
      <CreatureActions campaignId={campaignId} token={target} />
    </div>
  );
}
