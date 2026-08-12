import { useState } from 'react';
import { ABILITIES, SKILLS, SKILL_KEYS } from '@dnd/shared';
import { useTable } from '../../store/table.js';

/**
 * Ask the whole party for one check.
 *
 * Replaces the DM asking four people in turn and waiting on each. Modifiers
 * come from the same rules functions the sheets display, so the result agrees
 * with what each player sees on their own character.
 */
export function GroupRoll() {
  const { groupRoll } = useTable();
  const [kind, setKind] = useState<'skill' | 'save' | 'ability'>('skill');
  const [key, setKey] = useState<string>('perception');
  const [dc, setDc] = useState('');
  const [secret, setSecret] = useState(false);

  function switchKind(next: typeof kind) {
    setKind(next);
    // Keys are not interchangeable between kinds, so reset to a sane default.
    setKey(next === 'skill' ? 'perception' : 'wis');
  }

  return (
    <div className="rounded-lg border border-ink-800 p-2">
      <div className="mb-1.5 text-[10px] tracking-wide text-ink-500 uppercase">Ask the party</div>

      <div className="mb-1.5 flex gap-1">
        {(['skill', 'save', 'ability'] as const).map((option) => (
          <button
            key={option}
            onClick={() => switchKind(option)}
            className={`flex-1 rounded px-1.5 py-1 text-[10px] capitalize transition-colors ${
              kind === option ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:text-ink-300'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      <select
        value={key}
        onChange={(e) => setKey(e.target.value)}
        aria-label="What to roll"
        className="mb-1.5 w-full rounded border border-ink-600 bg-ink-850 px-2 py-1 text-xs text-ink-100 focus:border-arcane-400 focus:outline-none"
      >
        {kind === 'skill'
          ? SKILL_KEYS.map((skill) => (
              <option key={skill} value={skill}>
                {SKILLS[skill].name}
              </option>
            ))
          : ABILITIES.map((ability) => (
              <option key={ability} value={ability}>
                {ability.toUpperCase()}
              </option>
            ))}
      </select>

      <div className="flex gap-1">
        <input
          type="number"
          min={1}
          max={40}
          value={dc}
          onChange={(e) => setDc(e.target.value)}
          placeholder="DC"
          aria-label="Difficulty class"
          className="w-14 rounded border border-ink-600 bg-ink-850 px-1.5 py-1 text-center text-xs text-ink-100 focus:border-arcane-400 focus:outline-none"
        />
        <button
          onClick={() => setSecret(!secret)}
          title="Only you see the results"
          className={`rounded border px-1.5 py-1 text-[10px] transition-colors ${
            secret
              ? 'border-arcane-500/60 bg-arcane-500/15 text-arcane-400'
              : 'border-ink-700 text-ink-500 hover:text-ink-300'
          }`}
        >
          secret
        </button>
        <button
          onClick={() => groupRoll(kind, key, dc ? Number(dc) : null, secret)}
          className="flex-1 rounded border border-ember-500/60 bg-ember-500/15 px-2 py-1 text-[11px] text-ember-300 hover:bg-ember-500/25"
        >
          Roll for everyone
        </button>
      </div>
    </div>
  );
}
