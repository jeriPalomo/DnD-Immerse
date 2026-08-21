import { useEffect, useState } from 'react';
import { describeBonus, formatModifier } from '@dnd/shared';
import type { WireCardNumbers, WireToken } from '@dnd/shared';
import { api } from '../../lib/api.js';

interface ActionRow {
  id: string;
  name: string;
  type: string;
  numbers: WireCardNumbers;
  spellLevel: string;
  range: string;
}

interface StatBlockResponse {
  actions?: ActionRow[];
}

/**
 * What the creature you just clicked can do.
 *
 * Selecting a token answered with its hit points and its conditions, which is
 * what the DM needs and not what anybody else does: when it is not your turn
 * and you are working out whether to stand where you are, the question is what
 * the thing across the room is carrying. That was two clicks away inside the
 * stat block dialog, and even there it was a list of names - `Longsword
 * (weapon)` - with the reach and the damage left out.
 *
 * Read-only, deliberately. Rolling somebody else's attacks is not a thing this
 * panel offers; the creature you act as follows your own selection, and the
 * target panel is where a swing is taken.
 *
 * The list scrolls rather than growing. A wizard's spell list is arbitrarily
 * long and the contextual column has a fixed height it shares with the tab
 * stack - a panel that pushes the turn order off the screen is a worse problem
 * than the one it solves.
 */
export function CreatureActions({
  campaignId,
  token,
}: {
  campaignId: string;
  token: WireToken;
}) {
  const [rows, setRows] = useState<ActionRow[] | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    // The board's own flag, which is the server's answer rather than a guess:
    // asking about a creature it says nothing about earns a 403 and no rows.
    if (!token.statsVisible) {
      setRows([]);
      setRefused(null);
      return;
    }

    let cancelled = false;
    setRows(null);
    setRefused(null);

    void api
      .get<StatBlockResponse>(`/api/campaigns/${campaignId}/tokens/${token.id}/statblock`)
      .then((res) => {
        if (!cancelled) setRows(res.actions ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows([]);
        // Said out loud rather than left as an empty list. A party member's
        // sheet is shared deliberately, not by being on the same board, so
        // "nothing here" would read as a creature with no weapons.
        setRefused(err instanceof Error ? err.message : 'Those details are not shared with you');
      });

    return () => {
      cancelled = true;
    };
  }, [campaignId, token.id, token.statsVisible]);

  if (!token.statsVisible && !refused) return null;
  if (rows !== null && rows.length === 0 && !refused) return null;

  return (
    <div className="mt-2 border-t border-ink-800 pt-2">
      <div className="mb-1 text-[10px] tracking-wider text-ink-500 uppercase">
        What it can do
      </div>

      {refused ? (
        <p className="text-[11px] text-ink-500">{refused}</p>
      ) : rows === null ? (
        <p className="text-[11px] text-ink-600">Reading its stat block…</p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto pr-1">
          {rows.map((row) => (
            <li key={row.id} className="rounded border border-ink-800 bg-ink-900 px-2 py-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-xs text-ink-200">{row.name}</span>
                {row.numbers.toHit !== null && (
                  <span
                    className="shrink-0 font-mono text-[11px] text-ember-300"
                    title={describeBonus(row.numbers.toHitParts) || 'no bonuses'}
                  >
                    {formatModifier(row.numbers.toHit)}
                  </span>
                )}
              </div>
              <div className="font-mono text-[10px] text-ink-500">
                {row.numbers.damageDice && (
                  <>
                    {row.numbers.damageDice}
                    {row.numbers.damageBonus !== 0 && formatModifier(row.numbers.damageBonus)}{' '}
                    {row.numbers.damageType}
                  </>
                )}
                {row.numbers.healingDice && <>heals {row.numbers.healingDice}</>}
                {row.numbers.versatileDice && (
                  <span className="ml-1 text-ink-600">({row.numbers.versatileDice} two-handed)</span>
                )}
                <span className="ml-1.5 text-ink-600">{row.spellLevel || row.range}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
