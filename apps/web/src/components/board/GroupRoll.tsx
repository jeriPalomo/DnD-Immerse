import { useMemo, useState } from 'react';
import { ABILITIES, SKILLS, SKILL_KEYS } from '@dnd/shared';
import { useTable } from '../../store/table.js';

/**
 * One check, rolled for several creatures at once.
 *
 * The creature half is what this is for. A fireball lands on six goblins and
 * that is six saves rolled by hand off a stat block the app is already
 * holding - the arithmetic is the DM's least interesting job and the one most
 * likely to go wrong at eleven at night.
 *
 * Rolling for the *party* is the other half, and it is deliberately not the
 * default: it takes the moment off the players, which is why it was cut once
 * already. It stays because a corridor full of traps is a real use for it.
 */
export function GroupRoll() {
  const { tokens, groupRoll } = useTable();

  const [who, setWho] = useState<'creatures' | 'party'>('creatures');
  const [kind, setKind] = useState<'skill' | 'save' | 'ability'>('save');
  const [key, setKey] = useState<string>('dex');
  const [dc, setDc] = useState('');
  const [secret, setSecret] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});

  /**
   * The creatures the DM runs, in name order.
   *
   * Filtered on `ownerUserId`, never on disposition: a friendly NPC travelling
   * with the party is still the DM's to roll for, and a token a player owns is
   * still theirs whatever colour its ring is. That is the split the rest of the
   * app keeps - disposition tells friend from foe, ownership decides who acts.
   */
  const mine = useMemo(
    () =>
      tokens
        .filter((token) => !token.ownerUserId && token.layer !== 'gm')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [tokens],
  );

  const chosen = mine.filter((token) => picked[token.id] && token.actorId);
  const canRoll = who === 'party' || chosen.length > 0;

  function switchKind(next: typeof kind) {
    setKind(next);
    // Keys are not interchangeable between kinds, so reset to a sane default.
    setKey(next === 'skill' ? 'perception' : 'dex');
  }

  return (
    <div className="space-y-1.5 p-2">
      <div className="flex gap-1">
        {(
          [
            ['creatures', 'My creatures'],
            ['party', 'The party'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setWho(value)}
            title={
              value === 'creatures'
                ? 'Rolls for the creatures you tick below, off their own stat blocks'
                : 'Rolls for every character in this campaign - dice thrown on the players behalf'
            }
            className={`flex-1 rounded px-1.5 py-1 text-[10px] transition-colors ${
              who === value ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:text-ink-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {who === 'creatures' &&
        (mine.length === 0 ? (
          <p className="py-2 text-center text-[11px] text-ink-600">
            No creatures of yours on this scene.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 text-[10px] text-ink-600">
              <span>
                {chosen.length} of {mine.length}
              </span>
              <button
                onClick={() => setPicked(Object.fromEntries(mine.map((token) => [token.id, true])))}
                className="ml-auto transition-colors hover:text-ink-300"
              >
                all
              </button>
              <button onClick={() => setPicked({})} className="transition-colors hover:text-ink-300">
                none
              </button>
            </div>

            <ul className="max-h-32 space-y-0.5 overflow-y-auto rounded border border-ink-800 p-1">
              {mine.map((token) => {
                // A token with no sheet has no ability scores anywhere to roll
                // against. Greyed rather than dropped, so a creature missing
                // from the list is explained rather than merely absent - the
                // same reason an unreachable whisper target is greyed.
                const rollable = Boolean(token.actorId);
                return (
                  <li key={token.id}>
                    <label
                      title={
                        rollable ? undefined : 'No stat block behind this token - nothing to roll from'
                      }
                      className={`flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] ${
                        rollable ? 'cursor-pointer text-ink-300 hover:bg-ink-850' : 'text-ink-600'
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={!rollable}
                        checked={Boolean(picked[token.id]) && rollable}
                        onChange={(e) =>
                          setPicked((prev) => ({ ...prev, [token.id]: e.target.checked }))
                        }
                        className="accent-ember-500"
                      />
                      <span className="truncate">{token.name || 'Creature'}</span>
                      {!rollable && <span className="ml-auto shrink-0 text-[9px]">no sheet</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        ))}

      <div className="flex gap-1">
        {(['save', 'skill', 'ability'] as const).map((option) => (
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
        className="w-full rounded border border-ink-600 bg-ink-850 px-2 py-1 text-xs text-ink-100 focus:border-arcane-400 focus:outline-none"
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
          disabled={!canRoll}
          onClick={() =>
            groupRoll({
              kind,
              key,
              dc: dc ? Number(dc) : null,
              secret,
              who,
              tokenIds: who === 'creatures' ? chosen.map((token) => token.id) : [],
            })
          }
          className="flex-1 rounded border border-ember-500/60 bg-ember-500/15 px-2 py-1 text-[11px] text-ember-300 transition-colors hover:bg-ember-500/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {who === 'party'
            ? 'Roll for the party'
            : `Roll for ${chosen.length || 'no'} creature${chosen.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
