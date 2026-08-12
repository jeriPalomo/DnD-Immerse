import { useState } from 'react';
import { api } from '../../lib/api.js';
import { CONDITIONS } from '@dnd/shared';
import type { WireToken } from '@dnd/shared';
import { deriveToken } from '../../lib/derive.js';

/**
 * Quick controls for the selected token: damage and healing, conditions, and
 * the DM's hide/lock toggles.
 *
 * A linked token writes HP straight through to its actor, so editing here and
 * editing the sheet cannot disagree.
 */
export function TokenHUD({
  token,
  isDM,
  canEdit,
  onUpdate,
  onDelete,
}: {
  token: WireToken;
  isDM: boolean;
  canEdit: boolean;
  onUpdate: (fields: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const [uploadingArt, setUploadingArt] = useState(false);

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

  function applyDelta(sign: 1 | -1) {
    const amount = Math.abs(Number(delta) || 0);
    if (!amount || token.maxHp === null) return;

    const next = Math.max(0, Math.min(token.maxHp, (token.hp ?? 0) + sign * amount));
    onUpdate({ hp: next });
    setDelta('');
  }

  function toggleCondition(condition: string) {
    const active = token.conditions.includes(condition);
    onUpdate({
      conditions: active
        ? token.conditions.filter((c) => c !== condition)
        : [...token.conditions, condition],
    });
  }

  const hpPercent = token.maxHp ? Math.max(0, Math.min(100, ((token.hp ?? 0) / token.maxHp) * 100)) : 0;

  // Conditions are applied, not merely listed: prone really does halve speed.
  const derived = deriveToken(token);
  const speedChanged = derived.speed !== 30;

  return (
    <div className="rounded-xl border border-arcane-500/40 bg-ink-900 p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-display text-ink-100">{token.name || 'Token'}</h3>
          <p className="text-[11px] text-ink-500">
            {token.w}×{token.h} squares · {token.disposition}
            {token.actorLinked ? ' · linked' : token.actorId ? ' · unlinked copy' : ''}
          </p>
        </div>
        {token.ac !== null && (
          <span className="shrink-0 rounded bg-ink-800 px-2 py-0.5 text-xs text-ink-300">
            AC {token.ac}
          </span>
        )}
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

      {token.conditions.length > 0 && (
        <>
          <div className="mt-2 flex flex-wrap gap-1">
            {token.conditions.map((condition) => (
              <span
                key={condition}
                className="rounded bg-arcane-500/20 px-1.5 py-0.5 text-[10px] text-arcane-400 capitalize"
              >
                {condition}
              </span>
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
          {/* Art for this token alone. Without it every goblin stamped from
              the same NPC looks identical. */}
          <label className="block cursor-pointer text-center text-[10px] text-arcane-400 hover:underline">
            {uploadingArt ? 'Uploading…' : token.imageUrl ? 'Replace token art' : 'Set token art'}
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
          </label>

          <button
            onClick={() => setShowConditions(!showConditions)}
            className="w-full rounded border border-ink-700 px-2 py-1 text-xs text-ink-300 hover:border-ink-600"
          >
            {showConditions ? 'Hide conditions' : 'Conditions'}
          </button>

          {showConditions && (
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

            <div className="flex gap-1.5">
              <button
                onClick={() => onUpdate({ hidden: !token.hidden })}
                className={`flex-1 rounded border px-2 py-1 text-xs transition-colors ${
                  token.hidden
                    ? 'border-arcane-400 bg-arcane-500/20 text-arcane-400'
                    : 'border-ink-700 text-ink-400 hover:text-ink-200'
                }`}
                title="Hidden tokens are not sent to players at all"
              >
                {token.hidden ? 'Hidden' : 'Visible'}
              </button>
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
    </div>
  );
}
