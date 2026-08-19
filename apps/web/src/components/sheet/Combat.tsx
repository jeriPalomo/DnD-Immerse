import {
  abilityModifier,
  formatModifier,
  proficiencyBonus,
  spellAttackBonus,
  spellSaveDC,
  type AbilityKey,
} from '@dnd/shared';
import type { Actor, Item } from '../../store/sheet.js';

const NUMBER_BOX =
  'w-full rounded border border-ink-600 bg-ink-900 px-2 py-1 text-center font-display text-xl text-ink-100 focus:border-arcane-400 focus:outline-none';

export function CombatStats({
  actor,
  editable,
  onChange,
  rest,
}: {
  actor: Actor;
  editable: boolean;
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
            disabled={!editable}
            value={actor.hpCurrent}
            onChange={(e) => onChange({ hpCurrent: Number(e.target.value) || 0 })}
            className="w-20 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-center font-display text-2xl text-ink-100 focus:border-arcane-400 focus:outline-none disabled:opacity-70"
          />
          <span className="text-xl text-ink-500">/</span>
          <input
            type="number"
            disabled={!editable}
            value={actor.hpMax}
            onChange={(e) => onChange({ hpMax: Number(e.target.value) || 0 })}
            className="w-20 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-center font-display text-2xl text-ink-100 focus:border-arcane-400 focus:outline-none disabled:opacity-70"
          />
          <div className="ml-auto text-right">
            <div className="text-[10px] tracking-wider text-ink-400 uppercase">Temp</div>
            <input
              type="number"
              disabled={!editable}
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
  const prof = proficiencyBonus(actor.level);

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
          // A finesse weapon uses whichever of STR or DEX is better.
          const ability: AbilityKey = s.finesse
            ? abilityModifier(scores.dex) > abilityModifier(scores.str)
              ? 'dex'
              : 'str'
            : (s.ability ?? 'str');

          const mod = abilityModifier(scores[ability]);
          const toHit = mod + (s.proficient ? prof : 0) + (s.attackBonus ?? 0);
          const dmgBonus = mod + (s.damageBonus ?? 0);
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
              <td className="py-1.5 font-mono text-ember-300">{formatModifier(toHit)}</td>
              <td className="py-1.5 font-mono">
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

export function SpellcastingHeader({ actor }: { actor: Actor }) {
  if (!actor.spellcastingAbility) return null;

  const scores = { str: actor.str, dex: actor.dex, con: actor.con, int: actor.int, wis: actor.wis, cha: actor.cha };
  const ability = actor.spellcastingAbility;

  return (
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
  );
}
