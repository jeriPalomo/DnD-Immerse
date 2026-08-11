import {
  ABILITIES,
  ABILITY_NAMES,
  SKILLS,
  SKILL_KEYS,
  abilityModifier,
  formatModifier,
  passiveSkill,
  proficiencyBonus,
  savingThrowBonus,
  skillBonus,
  type AbilityKey,
  type AbilityScores,
  type ProficiencyLevel,
} from '@dnd/shared';
import type { Actor } from '../../store/sheet.js';

function scoresOf(actor: Actor): AbilityScores {
  return { str: actor.str, dex: actor.dex, con: actor.con, int: actor.int, wis: actor.wis, cha: actor.cha };
}

/**
 * Every number here is derived at render time from the ability scores. Nothing
 * is stored, so a score edit updates the modifier, every skill, every save and
 * passive perception in the same frame - and they cannot drift apart.
 */
export function AbilityScoresBlock({
  actor,
  editable,
  onChange,
}: {
  actor: Actor;
  editable: boolean;
  onChange: (key: AbilityKey, value: number) => void;
}) {
  const scores = scoresOf(actor);

  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-2">
      {ABILITIES.map((key) => {
        const modifier = abilityModifier(scores[key]);
        return (
          <div
            key={key}
            className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-3 text-center"
          >
            <div className="text-[11px] font-semibold tracking-wider text-ink-400 uppercase">
              {ABILITY_NAMES[key].slice(0, 3)}
            </div>
            <div className="font-display text-2xl font-bold text-ink-100">
              {formatModifier(modifier)}
            </div>
            {editable ? (
              <input
                type="number"
                min={1}
                max={30}
                aria-label={`${ABILITY_NAMES[key]} score`}
                value={scores[key]}
                onChange={(e) => onChange(key, Math.max(1, Math.min(30, Number(e.target.value) || 10)))}
                className="mt-1 w-14 rounded border border-ink-600 bg-ink-900 px-1 py-0.5 text-center text-sm text-ink-200 focus:border-arcane-400 focus:outline-none"
              />
            ) : (
              <div className="mt-1 text-sm text-ink-400">{scores[key]}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SavingThrows({
  actor,
  editable,
  onToggle,
}: {
  actor: Actor;
  editable: boolean;
  onToggle: (ability: AbilityKey, proficient: boolean) => void;
}) {
  const scores = scoresOf(actor);

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 p-3">
      <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-ink-400 uppercase">
        Saving Throws
      </h3>
      <ul className="space-y-0.5">
        {ABILITIES.map((key) => {
          const proficient = Boolean(actor.saveProficiencies[key]);
          const bonus = savingThrowBonus(scores, actor.level, key, proficient);
          return (
            <li key={key} className="flex items-center gap-2 text-sm">
              <button
                type="button"
                disabled={!editable}
                onClick={() => onToggle(key, !proficient)}
                aria-label={`${ABILITY_NAMES[key]} save proficiency`}
                className={`size-3 shrink-0 rounded-full border transition-colors ${
                  proficient ? 'border-ember-400 bg-ember-400' : 'border-ink-500'
                } ${editable ? 'cursor-pointer hover:border-ember-300' : 'cursor-default'}`}
              />
              <span className="flex-1 text-ink-300">{ABILITY_NAMES[key]}</span>
              <span className="font-mono text-ink-100">{formatModifier(bonus)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SkillList({
  actor,
  editable,
  onCycle,
}: {
  actor: Actor;
  editable: boolean;
  onCycle: (skill: keyof typeof SKILLS, level: ProficiencyLevel) => void;
}) {
  const scores = scoresOf(actor);

  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 p-3">
      <h3 className="mb-2 text-[11px] font-semibold tracking-wider text-ink-400 uppercase">
        Skills
      </h3>
      <ul className="space-y-0.5">
        {SKILL_KEYS.map((key) => {
          const level = (actor.skillProficiencies[key] ?? 0) as ProficiencyLevel;
          const bonus = skillBonus(scores, actor.level, key, level);
          return (
            <li key={key} className="flex items-center gap-2 text-sm">
              <button
                type="button"
                disabled={!editable}
                // Cycles none -> proficient -> expertise -> none.
                onClick={() => onCycle(key, ((level + 1) % 3) as ProficiencyLevel)}
                title={level === 2 ? 'Expertise' : level === 1 ? 'Proficient' : 'Not proficient'}
                className={`size-3 shrink-0 rounded-full border transition-colors ${
                  level === 2
                    ? 'border-arcane-400 bg-arcane-400'
                    : level === 1
                      ? 'border-ember-400 bg-ember-400'
                      : 'border-ink-500'
                } ${editable ? 'cursor-pointer' : 'cursor-default'}`}
              />
              <span className="flex-1 text-ink-300">{SKILLS[key].name}</span>
              <span className="text-[10px] text-ink-500 uppercase">
                {SKILLS[key].ability}
              </span>
              <span className="w-8 text-right font-mono text-ink-100">{formatModifier(bonus)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Passive scores and the proficiency bonus, both purely derived. */
export function DerivedStats({ actor }: { actor: Actor }) {
  const scores = scoresOf(actor);
  const perception = passiveSkill(
    scores,
    actor.level,
    'perception',
    (actor.skillProficiencies.perception ?? 0) as ProficiencyLevel,
  );
  const investigation = passiveSkill(
    scores,
    actor.level,
    'investigation',
    (actor.skillProficiencies.investigation ?? 0) as ProficiencyLevel,
  );
  const initiative = abilityModifier(scores.dex);

  const stats = [
    { label: 'Proficiency', value: formatModifier(proficiencyBonus(actor.level)) },
    { label: 'Initiative', value: formatModifier(initiative) },
    { label: 'Passive Perception', value: String(perception) },
    { label: 'Passive Investigation', value: String(investigation) },
  ];

  return (
    <div className="grid grid-cols-2 gap-2">
      {stats.map((stat) => (
        <div key={stat.label} className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
          <div className="text-[10px] tracking-wider text-ink-400 uppercase">{stat.label}</div>
          <div className="font-display text-lg text-ink-100">{stat.value}</div>
        </div>
      ))}
    </div>
  );
}
