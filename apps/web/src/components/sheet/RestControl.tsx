import { useState } from 'react';
import { parseHitDicePool, type RestResult } from '@dnd/shared';
import { Button } from '../ui.js';
import { api } from '../../lib/api.js';

/**
 * Short and long rest.
 *
 * The dice are rolled on the server, like every other roll in the app, so a
 * short rest reports what it actually healed rather than an average.
 */
export function RestControl({
  actorId,
  hitDiceTotal,
  hitDiceUsed,
  onRested,
}: {
  actorId: string;
  hitDiceTotal: string;
  hitDiceUsed: number;
  onRested: () => void;
}) {
  const [busy, setBusy] = useState<'short' | 'long' | null>(null);
  const [spend, setSpend] = useState(1);
  const [result, setResult] = useState<RestResult | null>(null);

  const pool = parseHitDicePool(hitDiceTotal);
  const available = Math.max(0, pool.count - hitDiceUsed);

  async function rest(type: 'short' | 'long') {
    setBusy(type);
    try {
      const res = await api.post<{ result: RestResult }>(`/api/actors/${actorId}/rest`, {
        type,
        hitDiceSpent: type === 'short' ? Math.min(spend, available) : 0,
      });
      setResult(res.result);
      onRested();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-400">
          <span className="mb-1 block">
            Hit dice to spend
            <span className="ml-1 text-ink-600">
              ({available} of {pool.count || '?'} left)
            </span>
          </span>
          <input
            type="number"
            min={0}
            max={available}
            value={spend}
            disabled={available === 0}
            onChange={(e) => setSpend(Math.max(0, Math.min(available, Number(e.target.value) || 0)))}
            aria-label="Hit dice to spend"
            className="w-20 rounded border border-ink-600 bg-ink-850 px-2 py-1.5 text-center text-sm text-ink-100 focus:border-arcane-400 focus:outline-none disabled:opacity-50"
          />
        </label>

        <Button
          size="sm"
          variant="secondary"
          loading={busy === 'short'}
          onClick={() => void rest('short')}
        >
          Short rest
        </Button>
        <Button size="sm" loading={busy === 'long'} onClick={() => void rest('long')}>
          Long rest
        </Button>
      </div>

      <p className="text-[11px] text-ink-600">
        A short rest spends hit dice to heal and refreshes short-rest features. A long rest restores
        all hit points, half your hit dice, and every spell slot.
      </p>

      {result && (
        <ul className="space-y-0.5 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-2">
          {result.summary.map((line) => (
            <li key={line} className="text-xs text-emerald-200">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
