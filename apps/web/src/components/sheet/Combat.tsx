import { useState } from 'react';
import {
  attackBonusParts,
  bonusTotal,
  damageBonusParts,
  describeBonus,
  formatModifier,
  spellAttackBonus,
  spellSaveDC,
  weaponAbility,
  type AbilityKey,
} from '@dnd/shared';
import type { Actor, Item } from '../../store/sheet.js';

const NUMBER_BOX =
  'w-full rounded border border-ink-600 bg-ink-900 px-2 py-1 text-center font-display text-xl text-ink-100 focus:border-arcane-400 focus:outline-none';

export function CombatStats({
  actor,
  editable,
  hpEditable = editable,
  onChange,
  rest,
}: {
  actor: Actor;
  editable: boolean;
  /**
   * Hit points on their own gate.
   *
   * A creature stamped from the bestiary has the compendium's armour class and
   * speed and always will, but its hit points are the one published figure the
   * handbook expects a DM to vary - the stat block prints hit dice next to the
   * average precisely so you can roll your own. Defaults to `editable`, so
   * every other sheet behaves as before.
   */
  hpEditable?: boolean;
  onChange: (fields: Partial<Actor>) => void;
  /** The rest controls, rendered inside the hit point card. */
  rest?: React.ReactNode;
}) {
  const hpPercent = actor.hpMax > 0 ? Math.max(0, Math.min(100, (actor.hpCurrent / actor.hpMax) * 100)) : 0;
  const bloodied = actor.hpCurrent <= actor.hpMax / 2;
  const down = actor.hpCurrent <= 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Armor Class">
          {editable ? (
            <input
              type="number"
              value={actor.armorClass}
              onChange={(e) => onChange({ armorClass: Number(e.target.value) || 0 })}
              className={NUMBER_BOX}
            />
          ) : (
            <div className="font-display text-xl text-ink-100">{actor.armorClass}</div>
          )}
        </Stat>
        <Stat label="Speed">
          {editable ? (
            <input
              type="number"
              value={actor.speed}
              onChange={(e) => onChange({ speed: Number(e.target.value) || 0 })}
              className={NUMBER_BOX}
            />
          ) : (
            <div className="font-display text-xl text-ink-100">{actor.speed}</div>
          )}
        </Stat>
        <Stat label="Hit Dice">
          <div className="font-display text-xl text-ink-100">{actor.hitDiceTotal}</div>
        </Stat>
      </div>

      {/* Hit points */}
      <div className="rounded-lg border border-ink-700 bg-ink-850 p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[10px] tracking-wider text-ink-400 uppercase">Hit Points</span>
          {down ? (
            <span className="text-xs font-semibold text-red-400">Unconscious</span>
          ) : bloodied ? (
            <span className="text-xs font-semibold text-ember-400">Bloodied</span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <input
            type="number"
            disabled={!hpEditable}
            value={actor.hpCurrent}
            onChange={(e) => onChange({ hpCurrent: Number(e.target.value) || 0 })}
            className="w-20 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-center font-display text-2xl text-ink-100 focus:border-arcane-400 focus:outline-none disabled:opacity-70"
          />
          <span className="text-xl text-ink-500">/</span>
          <input
            type="number"
            disabled={!hpEditable}
            value={actor.hpMax}
            onChange={(e) => onChange({ hpMax: Number(e.target.value) || 0 })}
            className="w-20 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-center font-display text-2xl text-ink-100 focus:border-arcane-400 focus:outline-none disabled:opacity-70"
          />
          <div className="ml-auto text-right">
            <div className="text-[10px] tracking-wider text-ink-400 uppercase">Temp</div>
            <input
              type="number"
              disabled={!hpEditable}
              value={actor.hpTemp}
              onChange={(e) => onChange({ hpTemp: Number(e.target.value) || 0 })}
              className="w-16 rounded border border-ink-600 bg-ink-900 px-2 py-0.5 text-center text-ink-200 focus:border-arcane-400 focus:outline-none disabled:opacity-70"
            />
          </div>
        </div>

        <div className="mt-3 h-2 overflow-hidden rounded-full bg-ink-900">
          <div
            className={`h-full transition-all ${down ? 'bg-red-700' : bloodied ? 'bg-ember-500' : 'bg-emerald-600'}`}
            style={{ width: `${hpPercent}%` }}
          />
        </div>

        {/* Resting is what you do about hit points, so it lives with them
            rather than in a section of its own further down the sheet. */}
        {rest && <div className="mt-3 border-t border-ink-700 pt-3">{rest}</div>}
      </div>

      {down && <DeathSaves actor={actor} editable={editable} onChange={onChange} />}
    </div>
  );
}

/** 1st, 2nd, 3rd, 4th... Nine levels, so the three irregulars are the whole rule. */
function ordinal(n: number): string {
  return `${n}${['th', 'st', 'nd', 'rd'][n] ?? 'th'}`;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-2 text-center">
      <div className="mb-1 text-[10px] tracking-wider text-ink-400 uppercase">{label}</div>
      {children}
    </div>
  );
}

function DeathSaves({
  actor,
  editable,
  onChange,
}: {
  actor: Actor;
  editable: boolean;
  onChange: (fields: Partial<Actor>) => void;
}) {
  return (
    <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-3">
      <div className="mb-2 text-[10px] tracking-wider text-red-300 uppercase">Death Saves</div>
      {(['deathSaveSuccesses', 'deathSaveFailures'] as const).map((field) => (
        <div key={field} className="flex items-center gap-2 py-0.5 text-sm">
          <span className="w-16 text-ink-300">
            {field === 'deathSaveSuccesses' ? 'Success' : 'Failure'}
          </span>
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              disabled={!editable}
              onClick={() => onChange({ [field]: actor[field] >= n ? n - 1 : n } as Partial<Actor>)}
              className={`size-4 rounded-full border transition-colors ${
                actor[field] >= n
                  ? field === 'deathSaveSuccesses'
                    ? 'border-emerald-400 bg-emerald-500'
                    : 'border-red-400 bg-red-500'
                  : 'border-ink-500'
              }`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Attack rows built from weapon Items. The to-hit and damage numbers are
 * computed from the actor's abilities and proficiency, so re-rolling stats or
 * levelling up updates every weapon at once.
 *
 * An NPC stamped from the bestiary is the exception: its numbers are copied
 * from the published block, and the ability keying them is an implementation
 * detail of that copy - a goblin's shortbow reads STR only because that is
 * what the offsets cancel against. The chip is suppressed there rather than
 * printing something that looks like a mistake.
 */
export function AttackList({ actor, weapons }: { actor: Actor; weapons: Item[] }) {
  const scores = { str: actor.str, dex: actor.dex, con: actor.con, int: actor.int, wis: actor.wis, cha: actor.cha };

  if (weapons.length === 0) return null;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[10px] tracking-wider text-ink-400 uppercase">
          <th className="pb-1 font-medium">Weapon</th>
          <th className="pb-1 font-medium">Hit</th>
          <th className="pb-1 font-medium">Damage</th>
          <th className="pb-1 font-medium">Range</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-ink-800">
        {weapons.map((weapon) => {
          const s = weapon.system;
          // The same arithmetic the item card prints and the server rolls, from
          // the same function - this table used to do its own, and read
          // `proficient` as falsy where the roll read "not explicitly false",
          // so an item saved without the field would have shown one number here
          // and rolled another.
          const published = actor.type === 'npc' && Boolean(actor.srdMonsterId);
          const ability: AbilityKey = weaponAbility(s, scores);
          const hitParts = attackBonusParts(s, scores, actor.level, { published });
          const damageParts = damageBonusParts(s, scores, { published });
          const toHit = bonusTotal(hitParts);
          const dmgBonus = bonusTotal(damageParts);
          const range = s.range?.type === 'ranged' ? `${s.range.value}/${s.range.long ?? '-'} ft` : '5 ft';

          return (
            <tr key={weapon.id} className="text-ink-200">
              <td className="py-1.5">
                {weapon.name}
                {actor.type !== 'npc' && (
                  <span className="ml-1.5 text-[10px] text-ink-500 uppercase">{ability}</span>
                )}
                {/* 2024 weapon mastery; blank under 2014, where it does not exist. */}
                {s.mastery && (
                  <span
                    className="ml-1.5 rounded bg-arcane-500/20 px-1 text-[10px] text-arcane-400"
                    title={`Weapon mastery: ${s.mastery}`}
                  >
                    {s.mastery}
                  </span>
                )}
              </td>
              <td
                className="py-1.5 font-mono text-ember-300"
                title={describeBonus(hitParts) || 'no bonuses'}
              >
                {formatModifier(toHit)}
              </td>
              <td className="py-1.5 font-mono" title={describeBonus(damageParts) || 'no bonuses'}>
                {s.damageDice}
                {dmgBonus !== 0 && formatModifier(dmgBonus)}{' '}
                <span className="text-ink-500">{s.damageType}</span>
                {s.versatileDice && <span className="ml-1 text-ink-500">({s.versatileDice} 2h)</span>}
              </td>
              <td className="py-1.5 text-ink-400">{range}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function SpellcastingHeader({
  actor,
  editable = false,
  onChange,
}: {
  actor: Actor;
  editable?: boolean;
  onChange?: (fields: Partial<Actor>) => void;
}) {
  if (!actor.spellcastingAbility) return null;

  const scores = { str: actor.str, dex: actor.dex, con: actor.con, int: actor.int, wis: actor.wis, cha: actor.cha };
  const ability = actor.spellcastingAbility;

  return (
    <>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <Stat label="Ability">
          <div className="font-display text-lg text-ink-100 uppercase">{ability}</div>
        </Stat>
        <Stat label="Save DC">
          <div className="font-display text-lg text-ink-100">{spellSaveDC(scores, actor.level, ability)}</div>
        </Stat>
        <Stat label="Attack">
          <div className="font-display text-lg text-ink-100">
            {formatModifier(spellAttackBonus(scores, actor.level, ability))}
          </div>
        </Stat>
      </div>
      <SpellSlotTrack actor={actor} editable={editable} onChange={onChange} />
    </>
  );
}

/**
 * Slots, as pips, one row per level the sheet has any at.
 *
 * There was no slot display anywhere in this app - not here, not in the table
 * drawer, not on the board - while two pieces of logic read the count to decide
 * whether a spell could be cast. So the resource governed play and could
 * neither be seen nor spent. Casting a spell now spends one on the server; this
 * is where it is read back, and where it is put right.
 *
 * Clicking a pip toggles it, which is deliberately the whole editing story. It
 * is the undo for a card posted to read a spell rather than to cast it, and it
 * is how a table houses-rules a slot back after a spell fizzled - so the server
 * may refuse a cast outright without ever trapping anybody.
 */
export function SpellSlotTrack({
  actor,
  editable,
  onChange,
}: {
  actor: Actor;
  editable?: boolean;
  onChange?: (fields: Partial<Actor>) => void;
}) {
  const slots = actor.spellSlots;
  const levels = slots ? slots.max.map((max, i) => ({ level: i + 1, max, used: slots.used[i] ?? 0 })) : [];
  const tracked = levels.filter((row) => row.max > 0);

  // A caster with no slot table is a cantrip-only sheet or a stamped creature.
  // An empty grid of headings would say less than nothing.
  if (tracked.length === 0) return null;

  function setUsed(level: number, used: number) {
    if (!editable || !onChange || !slots) return;
    const next = slots.used.slice();
    next[level - 1] = used;
    onChange({ spellSlots: { max: slots.max, used: next } });
  }

  return (
    <div className="mb-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
      <div className="mb-1.5 text-[10px] tracking-wider text-ink-400 uppercase">Spell slots</div>
      <div className="space-y-1">
        {tracked.map(({ level, max, used }) => (
          <div key={level} className="flex items-center gap-2">
            <span className="w-7 shrink-0 font-display text-sm text-ink-400">{ordinal(level)}</span>
            <div className="flex flex-wrap gap-1">
              {Array.from({ length: max }, (_, i) => {
                const spent = i < used;
                // Clicking a pip sets `used` to everything up to and including
                // it, or back to it - so one click both spends the next slot
                // and recovers the last, rather than needing two controls.
                const target = spent ? i : i + 1;
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={!editable}
                    onClick={() => setUsed(level, target)}
                    aria-label={`Level ${level} slot ${i + 1} of ${max}, ${spent ? 'spent' : 'available'}`}
                    title={editable ? (spent ? 'Give this slot back' : 'Mark this slot spent') : undefined}
                    className={`size-4 rounded-full border transition-colors ${
                      spent
                        ? 'border-ink-600 bg-ink-800'
                        : 'border-arcane-400 bg-arcane-500/70'
                    } ${editable ? 'cursor-pointer hover:border-arcane-300' : 'cursor-default'}`}
                  />
                );
              })}
            </div>
            <span className="ml-auto shrink-0 text-[11px] text-ink-500">
              {Math.max(0, max - used)}/{max}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The twelve damage types 5e has. A closed set, so this is a picker not a text box. */
const DAMAGE_TYPES = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
] as const;

const MODIFIER_ROWS = [
  { key: 'resistances', label: 'Resistant to', hint: 'Takes half damage of this type.' },
  { key: 'immunities', label: 'Immune to', hint: 'Takes none of this type.' },
  { key: 'vulnerabilities', label: 'Vulnerable to', hint: 'Takes double damage of this type.' },
] as const;

/**
 * What this creature shrugs off, and what it cannot be given.
 *
 * `applyDamage` has read `damageModifiers` since the schema was written, and
 * `effect:apply` now honours `conditionImmunities` - but until this panel
 * existed there was no way to *set* either. The mechanic was complete, tested
 * and unreachable: a dwarf never resisted poison because nobody could say she
 * did. The same shape as `spellSlots`, one column along.
 *
 * Read-only on a creature stamped from the bestiary, following the lock the
 * rest of that sheet already carries. Unlike hit points, which the handbook
 * expects a DM to vary, immunity to fire is what an Ancient Red Dragon *is* -
 * and the compendium has already filled it in.
 */
export function DamageModifierPanel({
  actor,
  editable,
  onChange,
}: {
  actor: Actor;
  editable: boolean;
  onChange: (fields: Partial<Actor>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const mods = actor.damageModifiers ?? {};
  const conditionImmunities = mods.conditionImmunities ?? [];
  const anything =
    MODIFIER_ROWS.some((row) => (mods[row.key] ?? []).length > 0) || conditionImmunities.length > 0;

  // Nothing to say and no way to say it: a locked sheet with no modifiers gets
  // no empty headings.
  if (!editable && !anything) return null;

  function toggle(key: (typeof MODIFIER_ROWS)[number]['key'], type: string) {
    if (!editing) return;
    const current = mods[key] ?? [];
    const next = current.includes(type) ? current.filter((t) => t !== type) : [...current, type];
    // A type is one thing at a time. Resisting and being immune to fire at once
    // is not a state 5e has, and `applyDamage` would have to pick one.
    const others = MODIFIER_ROWS.filter((r) => r.key !== key).map((r) => [
      r.key,
      (mods[r.key] ?? []).filter((t) => t !== type),
    ]);
    onChange({
      damageModifiers: {
        ...mods,
        conditionImmunities,
        ...Object.fromEntries(others),
        [key]: next,
      } as Actor['damageModifiers'],
    });
  }

  return (
    <section className="rounded-lg border border-ink-700 bg-ink-850 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] tracking-wider text-ink-500 uppercase">Damage & conditions</h3>
        {editable && (
          <button
            type="button"
            onClick={() => setEditing((on) => !on)}
            className="rounded px-1.5 py-0.5 text-[11px] text-ink-400 hover:bg-ink-800 hover:text-ink-100"
          >
            {editing ? 'Done' : anything ? 'Edit' : 'Add'}
          </button>
        )}
      </div>

      {!editing && !anything && (
        <p className="text-[11px] text-ink-600">
          Nothing yet — most characters resist nothing, and a stat block fills this in itself.
        </p>
      )}

      <div className="space-y-2">
        {MODIFIER_ROWS.map(({ key, label, hint }) => {
          const chosen = mods[key] ?? [];
          // The full palette is thirty-six chips across three rows, and on a
          // character who resists nothing - which is most of them - that is
          // 187px of grey on every sheet. Shown only while editing; the rest
          // of the time this is a list of facts, and usually an empty one.
          if (!editing && chosen.length === 0) return null;
          return (
            <div key={key}>
              <div className="mb-1 text-xs text-ink-400" title={hint}>
                {label}
              </div>
              <div className="flex flex-wrap gap-1">
                {(editing ? DAMAGE_TYPES : chosen).map((type) => {
                  const on = chosen.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      disabled={!editing}
                      onClick={() => toggle(key, type)}
                      className={`rounded px-1.5 py-0.5 text-[11px] capitalize transition-colors ${
                        on
                          ? 'bg-arcane-500/25 text-arcane-200 ring-1 ring-arcane-400/50'
                          : 'bg-ink-800 text-ink-500 hover:text-ink-300'
                      } ${editing ? 'cursor-pointer' : 'cursor-default'}`}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {conditionImmunities.length > 0 && (
          <div>
            {/* Read-only even on an editable sheet: these come from a stat block,
                and a character with condition immunities is rare enough that
                typing one is the DM's job on the NPC rather than a control
                every player meets. */}
            <div className="mb-1 text-xs text-ink-400">Cannot be</div>
            <div className="flex flex-wrap gap-1">
              {conditionImmunities.map((condition) => (
                <span
                  key={condition}
                  className="rounded bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-300 capitalize"
                >
                  {condition}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
