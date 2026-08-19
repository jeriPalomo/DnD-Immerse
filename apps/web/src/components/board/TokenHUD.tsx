import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useTable } from '../../store/table.js';
import { TokenStatBlock } from './TokenStatBlock.js';
import { CONDITIONS, DISPOSITIONS, DISPOSITION_HINT, deriveToken } from '@dnd/shared';
import type { WireToken } from '@dnd/shared';

/**
 * Quick controls for the selected token: damage and healing, conditions, and
 * the DM's hide/lock toggles.
 *
 * A linked token writes HP straight through to its actor, so editing here and
 * editing the sheet cannot disagree.
 */
export function TokenHUD({
  token,
  campaignId,
  isDM,
  canEdit,
  onUpdate,
  onDelete,
}: {
  token: WireToken;
  campaignId: string;
  isDM: boolean;
  canEdit: boolean;
  onUpdate: (fields: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [uploadingArt, setUploadingArt] = useState(false);
  const [showStats, setShowStats] = useState(false);

  async function uploadArt(file: File) {
    setUploadingArt(true);
    try {
      await api.upload(`/api/tokens/${token.id}/image`, file);
    } finally {
      setUploadingArt(false);
    }
  }

  const [delta, setDelta] = useState('');
  const [showConditions, setShowConditions] = useState(false);
  const [showSight, setShowSight] = useState(false);
  /** Rounds the next condition is applied for. Blank means until removed. */
  const [rounds, setRounds] = useState('');
  const { applyEffect, updateEffect, removeEffect } = useTable();

  function applyDelta(sign: 1 | -1) {
    const amount = Math.abs(Number(delta) || 0);
    if (!amount || token.maxHp === null) return;

    const next = Math.max(0, Math.min(token.maxHp, (token.hp ?? 0) + sign * amount));
    onUpdate({ hp: next });
    setDelta('');
  }

  /**
   * Conditions are effect rows now, so a duration can ride along with one.
   * Clicking an active condition clears it; clicking an inactive one applies it
   * for however many rounds the box says, or indefinitely when it is blank.
   */
  function toggleCondition(condition: string) {
    const existing = token.effects.find((effect) => effect.statusId === condition);
    if (existing) {
      removeEffect(existing.id);
      return;
    }

    const parsed = Number(rounds);
    applyEffect([token.id], condition, parsed > 0 ? parsed : null);
  }

  const hpPercent = token.maxHp ? Math.max(0, Math.min(100, ((token.hp ?? 0) / token.maxHp) * 100)) : 0;

  // Conditions are applied, not merely listed: prone really does halve speed.
  const derived = deriveToken(token);
  const speedChanged = derived.speed !== 30;

  return (
    <div className="rounded-xl border border-arcane-500/40 bg-ink-900 p-4">
      <div className="mb-2 flex items-start gap-2">
        {/* The art, so you can see what you have selected without looking back
            at the board. Doubles as the upload control for whoever owns it. */}
        <label
          className={`relative size-11 shrink-0 overflow-hidden rounded-lg border border-ink-700 bg-ink-800 ${
            canEdit ? 'group cursor-pointer' : ''
          }`}
          title={canEdit ? 'Change token art' : undefined}
        >
          {token.imageUrl ? (
            <img src={token.imageUrl} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-xs text-ink-500">
              {(token.name || '?').slice(0, 2).toUpperCase()}
            </div>
          )}
          {canEdit && (
            <>
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                aria-label="Token art"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadArt(file);
                }}
              />
              <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-[9px] text-ink-100 opacity-0 transition-opacity group-hover:opacity-100">
                {uploadingArt ? '…' : 'Change'}
              </span>
            </>
          )}
        </label>

        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-ink-100">{token.name || 'Token'}</h3>
          <p className="text-[11px] text-ink-500">
            {token.w}×{token.h} squares
            {token.actorLinked ? ' · linked' : token.actorId ? ' · unlinked copy' : ''}
          </p>

          {/* Allegiance was display-only text, and nothing anywhere could
              change it - so every monster from the bestiary was hostile
              forever, friendly NPC or not. */}
          {isDM ? (
            <div className="mt-1 flex gap-1">
              {DISPOSITIONS.map(({ value, label, color }) => (
                <button
                  key={value}
                  onClick={() => onUpdate({ disposition: value })}
                  title={`${label} — ${DISPOSITION_HINT[value]}`}
                  className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                    token.disposition === value
                      ? 'border-current'
                      : 'border-ink-700 text-ink-600 hover:text-ink-300'
                  }`}
                  style={token.disposition === value ? { color } : undefined}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-ink-500">{token.disposition}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {token.ac !== null && (
            <span className="rounded bg-ink-800 px-2 py-0.5 text-xs text-ink-300">AC {token.ac}</span>
          )}
          {/* Offered on the server's answer, not the client's opinion: the
              route re-checks, so drawing this anyway earns a 403. */}
          {token.statsVisible && (
            <button
              onClick={() => setShowStats(true)}
              title="What is this creature?"
              aria-label="Stat block"
              className="rounded px-1.5 py-0.5 text-sm text-ink-500 transition-colors hover:text-ink-200"
            >
              📖
            </button>
          )}
          {/* Visibility is the thing a DM reaches for mid-sentence, so it sits
              here rather than at the bottom of the panel. */}
          {isDM && (
            <button
              onClick={() => onUpdate({ hidden: !token.hidden })}
              title={
                token.hidden
                  ? 'Hidden — players are not sent this token at all'
                  : 'Visible to players'
              }
              aria-label={token.hidden ? 'Show to players' : 'Hide from players'}
              className={`rounded px-1.5 py-0.5 text-sm transition-colors ${
                token.hidden ? 'text-ember-400 hover:text-ember-300' : 'text-ink-500 hover:text-ink-200'
              }`}
            >
              {token.hidden ? '🙈' : '👁'}
            </button>
          )}
        </div>
      </div>

      {token.maxHp !== null && (
        <>
          <div className="flex items-baseline justify-between text-xs text-ink-400">
            <span>
              {token.hp}/{token.maxHp} HP
            </span>
            {(token.hp ?? 0) <= 0 && <span className="text-red-400">Down</span>}
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-950">
            <div
              className={`h-full ${hpPercent <= 50 ? 'bg-ember-500' : 'bg-emerald-600'}`}
              style={{ width: `${hpPercent}%` }}
            />
          </div>

          {canEdit && (
            <div className="mt-2 flex gap-1.5">
              <input
                type="number"
                min={0}
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                placeholder="0"
                aria-label="Hit point change"
                className="w-16 rounded border border-ink-600 bg-ink-850 px-2 py-1 text-center text-sm text-ink-100 focus:border-arcane-400 focus:outline-none"
              />
              <button
                onClick={() => applyDelta(-1)}
                className="flex-1 rounded border border-red-900/60 bg-red-950/40 px-2 py-1 text-xs text-red-200 hover:bg-red-900/40"
              >
                Damage
              </button>
              <button
                onClick={() => applyDelta(1)}
                className="flex-1 rounded border border-emerald-900/60 bg-emerald-950/40 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-900/40"
              >
                Heal
              </button>
            </div>
          )}
        </>
      )}

      {token.effects.length > 0 && (
        <>
          {/* Each effect with its own countdown and controls, because a timer
              nobody can shorten is a timer the DM works around rather than
              with - the ruling at the table beats the one the app assumed. */}
          <div className="mt-2 space-y-1">
            {token.effects.map((effect) => (
              <div
                key={effect.id}
                className={`flex items-center gap-1.5 rounded bg-arcane-500/15 px-1.5 py-1 text-[10px] ${
                  effect.disabled ? 'opacity-40' : ''
                }`}
              >
                <span className="flex-1 capitalize text-arcane-400">{effect.name}</span>

                {effect.roundsRemaining === null ? (
                  <span className="text-ink-600" title="Lasts until removed">—</span>
                ) : (
                  <span
                    className="tabular-nums text-ink-300"
                    title="Rounds left. Nothing counts down outside combat."
                  >
                    {effect.roundsRemaining} rd
                  </span>
                )}

                {canEdit && (
                  <>
                    <button
                      // Nothing to shorten on an effect that lasts until it is
                      // removed: this used to send 0, which quietly scheduled it
                      // to expire at the top of the next round instead.
                      disabled={effect.roundsRemaining === null}
                      onClick={() =>
                        updateEffect(effect.id, {
                          rounds: Math.max(1, (effect.roundsRemaining ?? 1) - 1),
                        })
                      }
                      className="px-1 text-ink-500 hover:text-ink-200 disabled:opacity-30 disabled:hover:text-ink-500"
                      title={
                        effect.roundsRemaining === null
                          ? 'Lasts until removed — nothing to shorten'
                          : 'One round less'
                      }
                    >
                      −
                    </button>
                    <button
                      onClick={() =>
                        updateEffect(effect.id, { rounds: (effect.roundsRemaining ?? 0) + 1 })
                      }
                      className="px-1 text-ink-500 hover:text-ink-200"
                      title="One round more"
                    >
                      +
                    </button>
                    <button
                      onClick={() => removeEffect(effect.id)}
                      className="px-1 text-ink-500 hover:text-red-400"
                      title="Remove"
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* What those conditions actually do, rather than leaving the DM to
              remember. */}
          <div className="mt-1.5 space-y-0.5 rounded border border-arcane-500/20 bg-arcane-500/5 px-2 py-1.5">
            {speedChanged && (
              <div className="text-[10px] text-ink-300">
                Speed <span className="text-arcane-400">{derived.speed} ft</span>
                <span className="text-ink-600"> (was 30)</span>
              </div>
            )}
            {derived.hasDisadvantage && (
              <div className="text-[10px] text-red-400">Disadvantage on attack rolls</div>
            )}
            {derived.hasAdvantage && (
              <div className="text-[10px] text-emerald-400">Attacks against this token have advantage</div>
            )}
            {derived.incapacitated && (
              <div className="text-[10px] text-red-400">Incapacitated — no actions or reactions</div>
            )}
            {!speedChanged && !derived.hasDisadvantage && !derived.hasAdvantage && !derived.incapacitated && (
              <div className="text-[10px] text-ink-600">No mechanical effect</div>
            )}
          </div>
        </>
      )}

      {canEdit && (
        <div className="mt-3 space-y-2">
          {/* Art moved to the thumbnail in the header - it is the same upload,
              somewhere you can see what you are replacing. */}
          <button
            onClick={() => setShowConditions(!showConditions)}
            className="w-full rounded border border-ink-700 px-2 py-1 text-xs text-ink-300 hover:border-ink-600"
          >
            {showConditions ? 'Hide conditions' : 'Conditions'}
          </button>

          {showConditions && (
            <>
              <label className="flex items-center gap-2 text-[10px] text-ink-400">
                Lasts
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={rounds}
                  onChange={(e) => setRounds(e.target.value)}
                  placeholder="—"
                  aria-label="Rounds the condition lasts"
                  className="w-14 rounded border border-ink-700 bg-ink-850 px-1 py-0.5 text-center text-ink-200"
                />
                rounds
                <span className="text-ink-600">{rounds ? '' : '(until removed)'}</span>
              </label>

              <div className="flex flex-wrap gap-1">
              {CONDITIONS.map((condition) => {
                const active = token.conditions.includes(condition);
                return (
                  <button
                    key={condition}
                    onClick={() => toggleCondition(condition)}
                    className={`rounded px-1.5 py-0.5 text-[10px] capitalize transition-colors ${
                      active
                        ? 'bg-arcane-500/30 text-arcane-400'
                        : 'bg-ink-850 text-ink-500 hover:text-ink-300'
                    }`}
                  >
                    {condition}
                  </button>
                );
              })}
              </div>
            </>
          )}

          {isDM && (
            <>
              <button
                onClick={() => setShowSight(!showSight)}
                className="w-full rounded border border-ink-700 px-2 py-1 text-xs text-ink-300 hover:border-ink-600"
              >
                {showSight ? 'Hide sight' : 'Sight & light'}
              </button>

              {showSight && (
                <div className="space-y-2 rounded-lg border border-ink-800 bg-ink-950/60 p-2">
                  {(
                    [
                      ['visionRange', 'Vision', 'Feet seen in light. 0 uses the default 60 ft.'],
                      ['darkvisionRange', 'Darkvision', 'Feet seen with no light at all.'],
                      ['lightBright', 'Light carried', 'Feet this token illuminates, e.g. a torch at 20.'],
                    ] as const
                  ).map(([field, label, hint]) => (
                    <label key={field} className="block">
                      <div className="flex items-center justify-between text-[11px] text-ink-400">
                        <span>{label}</span>
                        <span className="font-mono text-ink-200">{token[field]} ft</span>
                      </div>
                      <input
                        type="number"
                        min={0}
                        max={500}
                        step={5}
                        value={token[field]}
                        aria-label={`${label} range in feet`}
                        title={hint}
                        onChange={(e) => onUpdate({ [field]: Math.max(0, Number(e.target.value) || 0) })}
                        className="mt-0.5 w-full rounded border border-ink-600 bg-ink-850 px-2 py-1 text-xs text-ink-100 focus:border-arcane-400 focus:outline-none"
                      />
                    </label>
                  ))}
                  <label className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-ink-400">Light colour</span>
                    <input
                      type="color"
                      value={token.lightColor}
                      aria-label="Light colour"
                      onChange={(e) => onUpdate({ lightColor: e.target.value })}
                      className="h-6 w-12 cursor-pointer rounded border border-ink-600 bg-ink-850"
                    />
                  </label>

                  <p className="text-[10px] text-ink-600">
                    Darkvision and carried light only matter when the scene's daylight
                    is switched off. Colour is cosmetic — it never changes what anyone
                    can see.
                  </p>
                </div>
              )}

            {/* Only ever restrictive: this closes one creature while the
                campaign default stays open. It cannot open a creature when the
                campaign has stats off, so there is one direction to think in. */}
            <button
              onClick={() => onUpdate({ statsHidden: !token.statsHidden })}
              className={`w-full rounded border px-2 py-1 text-xs transition-colors ${
                token.statsHidden
                  ? 'border-ember-400 bg-ember-500/20 text-ember-300'
                  : 'border-ink-700 text-ink-400 hover:text-ink-200'
              }`}
              title={
                token.statsHidden
                  ? 'Players cannot read this creature’s stat block'
                  : 'Players may read this creature’s stat block, if the campaign allows it'
              }
            >
              {token.statsHidden ? 'Stats hidden' : 'Stats shared'}
            </button>

            {/* Visibility moved to the eye in the header. */}
            <div className="flex gap-1.5">
              <button
                onClick={() => onUpdate({ locked: !token.locked })}
                className={`flex-1 rounded border px-2 py-1 text-xs transition-colors ${
                  token.locked
                    ? 'border-ember-400 bg-ember-500/20 text-ember-300'
                    : 'border-ink-700 text-ink-400 hover:text-ink-200'
                }`}
              >
                {token.locked ? 'Locked' : 'Unlocked'}
              </button>
              <button
                onClick={onDelete}
                className="rounded border border-red-900/60 px-2 py-1 text-xs text-red-300 hover:bg-red-950/40"
                aria-label="Delete token"
              >
                Remove
              </button>
            </div>
            </>
          )}
        </div>
      )}

      {showStats && (
        <TokenStatBlock
          campaignId={campaignId}
          tokenId={token.id}
          onClose={() => setShowStats(false)}
        />
      )}
    </div>
  );
}
