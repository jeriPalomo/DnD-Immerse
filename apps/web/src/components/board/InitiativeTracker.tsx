import { useState } from 'react';
import { CONDITION_SUMMARY, formatCombatTime, formatModifier, tokensInTemplate } from '@dnd/shared';
import { Button } from '../ui.js';
import { useTable } from '../../store/table.js';
import { useAuth } from '../../store/auth.js';

/**
 * The turn order.
 *
 * Players see who is up and roughly how everyone is doing, but enemy hit
 * points are redacted server-side — knowing the boss is on 7 HP changes how a
 * table plays, and that is the DM's to reveal deliberately.
 */
export function InitiativeTracker({ isDM }: { isDM: boolean }) {
  const {
    encounter, tokens, selectedTokenId, lastDamage, templates, scene, clearTemplate, rollDeathSave,
    startEncounter, endEncounter, addToInitiative, removeFromInitiative, setInitiative,
    nextTurn, previousTurn, select, rollInitiative,
  } = useTable();
  const { user } = useAuth();

  const [damage, setDamage] = useState('');
  const [damageType, setDamageType] = useState('slashing');
  /** The entry whose initiative is being retyped, and the text so far. */
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  if (!encounter) {
    if (!isDM) return null;

    // One button, because there is one thing to do here. "Roll monsters, ask
    // the players" used to sit beside it and start the fight *as well as*
    // filling it, so the panel offered two ways to begin and no way to tell
    // which one you had pressed. It lives in the turn order now, with the rest
    // of the controls for putting creatures into a fight that already exists.
    return (
      <div className="space-y-3 p-2">
        <div>
          <h2 className="mb-2 font-display text-sm text-ink-100">Combat</h2>
          <Button size="sm" variant="secondary" onClick={() => startEncounter()}>
            Start encounter
          </Button>
        </div>
      </div>
    );
  }

  /**
   * Writes a retyped initiative and lets the server resort the order.
   *
   * Only the number: position is the server's, computed from initiative with
   * the handbook's dexterity tiebreaker. The payload used to require a
   * `sortOrder` as well, which was sent as a placeholder and never read.
   */
  function commitInitiative(entryId: string): void {
    if (!editing || editing.id !== entryId) return;

    const value = Number(editing.value);
    setEditing(null);
    if (!Number.isFinite(value)) return;

    const entry = encounter?.entries.find((e) => e.id === entryId);
    if (!entry || value === entry.initiative) return;

    setInitiative(encounter!.id, {
      entries: [{ id: entryId, initiative: value }],
    });
  }

  /**
   * Whether this viewer may answer that entry.
   *
   * Theirs, or the DM's - who fills in for whoever is not at the table, exactly
   * as they can on a group roll card. Enforced on the server; this only decides
   * whether to offer the button.
   */
  function mayRoll(tokenId: string | null): boolean {
    if (isDM) return true;
    const token = tokens.find((t) => t.id === tokenId);
    return Boolean(token && token.ownerUserId === user?.id);
  }

  const active = encounter.entries[encounter.activeIndex] ?? null;
  const onBoard = tokens.filter((t) => !encounter.entries.some((e) => e.tokenId === t.id));

  // Everyone standing in the most recent area effect, from the same geometry
  // that draws it - so the outline and the target list cannot disagree.
  const template = templates[templates.length - 1] ?? null;
  const caught =
    template && scene
      ? tokensInTemplate(template, tokens, { feetPerSquare: scene.feetPerSquare })
      : [];

  return (
    <div className="rounded-lg border-l-2 border-ember-500/60 bg-ink-900 p-2 pl-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-display text-sm text-ink-100">
          Round {encounter.round}
          {/* What the round means in the world. Six seconds each, derived and
              stored nowhere - a party that has just rolled initiative has spent
              none of it, so round 1 reads zero. */}
          {/* A middle dot rather than margin alone: spaced apart it reads
              correctly on screen, but as plain text - which is what a screen
              reader gets - "Round 3" and "12 seconds in" ran together into
              "Round 312 seconds in". */}
          <span
            title="A round is six seconds of game time"
            className="ml-2 font-sans text-[10px] font-normal text-ink-500"
          >
            · {formatCombatTime(encounter.round)}
          </span>
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

      {lastDamage && lastDamage.length > 0 && (
        <div className="mb-2 space-y-0.5 rounded border border-ink-700 bg-ink-950/60 px-2 py-1.5">
          {lastDamage.map((result) => (
            <div key={result.tokenId} className="text-[10px] text-ink-300">
              {result.name}{' '}
              <span className="font-mono text-ink-500">
                {/* The pool only where it is known: a player is sent the amount
                    and nothing else, so this used to print an enemy's hit points
                    to the whole table. */}
                {result.before !== undefined && result.after !== undefined
                  ? `${result.before} → ${result.after}`
                  : `${result.healing ? '+' : '−'}${result.amount}`}
              </span>
              {result.reason !== 'normal' && result.reason !== 'healing' && (
                // Naming the reason is the point: silent halving looks like a bug.
                <span className="ml-1 text-ember-400">{result.reason}</span>
              )}
            </div>
          ))}
        </div>
      )}

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
                  {/* A mistyped initiative used to be uncorrectable: the server
                      handler for this existed from the start and nothing ever
                      called it, so 17 entered as 71 meant removing the combatant
                      and adding them back. Commits on blur or Enter, reverts on
                      Escape - the same shape as renaming a scene. */}
                  {isDM && editing?.id === entry.id ? (
                    <input
                      autoFocus
                      type="number"
                      value={editing.value}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditing({ id: entry.id, value: e.target.value })}
                      onBlur={() => commitInitiative(entry.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitInitiative(entry.id);
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      className="w-8 shrink-0 rounded border border-ember-500/60 bg-ink-900 text-center font-mono text-xs text-ink-100 focus:outline-none"
                      aria-label={`Initiative for ${entry.name}`}
                    />
                  ) : entry.pending ? (
                    // Waiting on whoever runs this creature. The button is here
                    // rather than in a banner because the turn order is where
                    // somebody is already looking when a fight starts.
                    mayRoll(entry.tokenId) ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          rollInitiative(entry.id);
                        }}
                        title="Roll your initiative"
                        className="shrink-0 rounded border border-ember-500/60 bg-ember-500/15 px-1.5 text-[10px] text-ember-300 transition-colors hover:bg-ember-500/25"
                      >
                        {/* The Dexterity modifier, because 5e initiative is a
                            Dexterity check - the same number the party list
                            prints beside a name. Computed on the server and
                            sent only on a waiting entry. */}
                        Roll {formatModifier(entry.initiativeBonus ?? 0)}
                      </button>
                    ) : (
                      <span className="w-6 shrink-0 text-center text-[9px] text-ink-600">…</span>
                    )
                  ) : (
                    <span
                      onClick={(e) => {
                        if (!isDM) return;
                        e.stopPropagation();
                        setEditing({ id: entry.id, value: String(entry.initiative) });
                      }}
                      title={isDM ? 'Click to change' : undefined}
                      className={`w-6 shrink-0 text-center font-mono text-xs ${
                        isDM ? 'cursor-text hover:text-ink-100' : ''
                      } ${isActive ? 'text-ember-300' : 'text-ink-500'}`}
                    >
                      {entry.initiative}
                    </span>
                  )}
                  {/* A face reads faster than a name once a fight has a dozen
                      creatures in it. Falls back to the initial, the way the
                      token HUD and the roster cards already do. */}
                  <div className="size-6 shrink-0 overflow-hidden rounded border border-ink-800 bg-ink-850">
                    {entry.imageUrl ? (
                      <img
                        src={entry.imageUrl}
                        alt=""
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center text-[9px] text-ink-600">
                        {entry.name.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                  </div>

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

                {/* At zero hit points the tracker offers the save directly,
                    rather than the DM remembering to ask for it. */}
                {entry.hp !== null && entry.hp <= 0 && entry.tokenId && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-[9px] tracking-wide text-red-400 uppercase">Dying</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        rollDeathSave(entry.tokenId!);
                      }}
                      className="rounded border border-red-800 bg-red-950/50 px-1.5 py-0.5 text-[9px] text-red-200 hover:bg-red-900/50"
                    >
                      Death save
                    </button>
                  </div>
                )}

                {entry.conditions.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-0.5">
                    {entry.conditions.map((condition) => (
                      <span
                        key={condition}
                        title={CONDITION_SUMMARY[condition]}
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
                {/* The DM's creatures roll now because they have nobody to ask;
                    each character's entry waits with a Roll button on it. Here
                    rather than beside "Start encounter", where it was a second
                    way to begin a fight. */}
                {onBoard.length > 0 && (
                  <button
                    onClick={() => addToInitiative(onBoard.map((t) => t.id), true)}
                    title="Rolls your creatures now and asks each player for their own"
                    className="rounded border border-ember-500/50 px-1.5 py-0.5 text-[10px] text-ember-300"
                  >
                    + roll monsters, ask the players
                  </button>
                )}
              </div>
            </div>
          )}

          {caught.length > 0 && template && (
            <div className="rounded-lg border border-arcane-500/40 bg-arcane-500/5 p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] tracking-wide text-arcane-400 uppercase">
                  In the {template.shape} — {caught.length}
                </span>
                <button
                  onClick={() => clearTemplate(template.id)}
                  className="text-[10px] text-ink-500 hover:text-ink-300"
                >
                  clear
                </button>
              </div>
              <div className="mb-1.5 flex flex-wrap gap-1">
                {caught.map((token) => (
                  <span key={token.id} className="rounded bg-ink-800 px-1.5 text-[10px] text-ink-300">
                    {token.name || 'token'}
                  </span>
                ))}
              </div>
              {/* Its own amount, now that the shared one has gone. Damaging a
                  single creature belongs on that creature - click it and the
                  HUD does it, resistances and concentration and all - but a
                  fireball is the one thing a token cannot answer for, so this
                  is the only place several are hit at once. */}
              <div className="mb-1.5 flex gap-1">
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
              <div className="flex gap-1">
                {([['All', false], ['Half (saved)', true]] as const).map(([label, halved]) => (
                  <button
                    key={label}
                    onClick={() => {
                      const amount = Number(damage) || 0;
                      if (!amount) return;
                      useTable
                        .getState()
                        .applyDamage(caught.map((t) => t.id), amount, damageType, false, halved);
                      setDamage('');
                    }}
                    className="flex-1 rounded border border-red-900/60 bg-red-950/40 px-1.5 py-1 text-[10px] text-red-200 hover:bg-red-900/40"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}


          <Button size="sm" variant="ghost" onClick={() => endEncounter()} className="w-full">
            End encounter
          </Button>
        </div>
      )}
    </div>
  );
}
