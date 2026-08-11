import { useState } from 'react';
import { Button } from '../ui.js';
import { useTable } from '../../store/table.js';

/**
 * The turn order.
 *
 * Players see who is up and roughly how everyone is doing, but enemy hit
 * points are redacted server-side — knowing the boss is on 7 HP changes how a
 * table plays, and that is the DM's to reveal deliberately.
 */
export function InitiativeTracker({ isDM }: { isDM: boolean }) {
  const {
    encounter, tokens, selectedTokenId,
    startEncounter, endEncounter, addToInitiative, removeFromInitiative,
    nextTurn, previousTurn, select,
  } = useTable();

  const [damage, setDamage] = useState('');
  const [damageType, setDamageType] = useState('slashing');

  if (!encounter) {
    if (!isDM) return null;
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
        <h2 className="mb-2 font-display text-sm text-ink-100">Combat</h2>
        <Button size="sm" variant="secondary" onClick={() => startEncounter()}>
          Start encounter
        </Button>
      </div>
    );
  }

  const active = encounter.entries[encounter.activeIndex] ?? null;
  const onBoard = tokens.filter((t) => !encounter.entries.some((e) => e.tokenId === t.id));

  return (
    <div className="rounded-xl border border-ember-500/40 bg-ink-900 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-display text-sm text-ink-100">
          Round {encounter.round}
        </h2>
        {isDM && (
          <div className="flex gap-1">
            <button
              onClick={() => previousTurn()}
              className="rounded border border-ink-700 px-2 py-0.5 text-xs text-ink-400 hover:text-ink-100"
              aria-label="Previous turn"
            >
              ‹
            </button>
            <button
              onClick={() => nextTurn()}
              className="rounded border border-ember-500 bg-ember-500/15 px-2 py-0.5 text-xs text-ember-300 hover:bg-ember-500/25"
            >
              Next turn ›
            </button>
          </div>
        )}
      </div>

      {encounter.entries.length === 0 ? (
        <p className="text-xs text-ink-500">No combatants yet.</p>
      ) : (
        <ol className="space-y-1">
          {encounter.entries.map((entry, index) => {
            const isActive = index === encounter.activeIndex;
            const hpPercent =
              entry.maxHp && entry.hp !== null
                ? Math.max(0, Math.min(100, (entry.hp / entry.maxHp) * 100))
                : null;

            return (
              <li
                key={entry.id}
                onClick={() => entry.tokenId && select(entry.tokenId)}
                className={`cursor-pointer rounded-lg border px-2 py-1.5 transition-colors ${
                  isActive
                    ? 'border-ember-400 bg-ember-500/10'
                    : entry.tokenId === selectedTokenId
                      ? 'border-arcane-500/50 bg-arcane-500/5'
                      : 'border-ink-800 hover:border-ink-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-6 shrink-0 text-center font-mono text-xs ${
                      isActive ? 'text-ember-300' : 'text-ink-500'
                    }`}
                  >
                    {entry.initiative}
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-xs ${isActive ? 'text-ink-100' : 'text-ink-300'}`}>
                    {entry.name}
                  </span>

                  {entry.hpRedacted ? (
                    // Deliberately vague: the player sees that it exists, not how close it is to dying.
                    <span className="text-[10px] text-ink-600">—</span>
                  ) : (
                    entry.hp !== null && (
                      <span className="font-mono text-[10px] text-ink-500">
                        {entry.hp}/{entry.maxHp}
                      </span>
                    )
                  )}

                  {isDM && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFromInitiative(entry.id);
                      }}
                      className="text-ink-700 hover:text-red-400"
                      aria-label={`Remove ${entry.name}`}
                    >
                      ✕
                    </button>
                  )}
                </div>

                {hpPercent !== null && (
                  <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-ink-950">
                    <div
                      className={`h-full ${hpPercent <= 50 ? 'bg-ember-500' : 'bg-emerald-600'}`}
                      style={{ width: `${hpPercent}%` }}
                    />
                  </div>
                )}

                {entry.conditions.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-0.5">
                    {entry.conditions.map((condition) => (
                      <span
                        key={condition}
                        className="rounded bg-arcane-500/20 px-1 text-[9px] text-arcane-400 capitalize"
                      >
                        {condition}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {isDM && (
        <div className="mt-3 space-y-2 border-t border-ink-800 pt-3">
          {onBoard.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] tracking-wide text-ink-500 uppercase">
                Add to initiative
              </div>
              <div className="flex flex-wrap gap-1">
                {onBoard.map((token) => (
                  <button
                    key={token.id}
                    onClick={() => addToInitiative([token.id])}
                    className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] text-ink-300 hover:border-ember-500"
                  >
                    + {token.name || 'Token'}
                  </button>
                ))}
                {onBoard.length > 1 && (
                  <button
                    onClick={() => addToInitiative(onBoard.map((t) => t.id))}
                    className="rounded border border-arcane-500/50 px-1.5 py-0.5 text-[10px] text-arcane-400"
                  >
                    + roll all
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Damage the active combatant, or whoever is selected. */}
          <div>
            <div className="mb-1 text-[10px] tracking-wide text-ink-500 uppercase">
              Apply to {selectedTokenId ? 'selected' : (active?.name ?? 'active')}
            </div>
            <div className="flex gap-1">
              <input
                type="number"
                min={0}
                value={damage}
                onChange={(e) => setDamage(e.target.value)}
                placeholder="0"
                aria-label="Damage amount"
                className="w-14 rounded border border-ink-600 bg-ink-850 px-1.5 py-1 text-center text-xs text-ink-100 focus:border-arcane-400 focus:outline-none"
              />
              <input
                value={damageType}
                onChange={(e) => setDamageType(e.target.value)}
                aria-label="Damage type"
                className="min-w-0 flex-1 rounded border border-ink-600 bg-ink-850 px-1.5 py-1 text-xs text-ink-100 focus:border-arcane-400 focus:outline-none"
              />
            </div>
            <div className="mt-1 flex gap-1">
              {(
                [
                  ['Damage', false, false],
                  ['Half', false, true],
                  ['Heal', true, false],
                ] as const
              ).map(([label, healing, halved]) => (
                <button
                  key={label}
                  onClick={() => {
                    const target = selectedTokenId ?? active?.tokenId;
                    const amount = Number(damage) || 0;
                    if (!target || !amount) return;
                    useTable.getState().applyDamage([target], amount, damageType, healing, halved);
                    setDamage('');
                  }}
                  className={`flex-1 rounded border px-1.5 py-1 text-[10px] transition-colors ${
                    healing
                      ? 'border-emerald-900/60 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-900/40'
                      : 'border-red-900/60 bg-red-950/40 text-red-200 hover:bg-red-900/40'
                  }`}
                  title={halved ? 'Half damage, for a successful save' : undefined}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[9px] text-ink-600">
              Resistances come from the sheet. A concentrating target rolls to hold it.
            </p>
          </div>

          <Button size="sm" variant="ghost" onClick={() => endEncounter()} className="w-full">
            End encounter
          </Button>
        </div>
      )}
    </div>
  );
}
