import { useEffect, useState } from 'react';
import { StatBlock } from './MonsterBrowser.js';
import { api } from '../../lib/api.js';

interface StatBlockResponse {
  source: 'compendium' | 'actor';
  name: string;
  imageUrl: string | null;
  statBlock: Record<string, any>;
}

/**
 * What a creature is, for whoever is allowed to ask.
 *
 * The button that opens this is offered on `token.statsVisible`, but that is a
 * convenience only - the route re-checks with the same `mayReadStats` the
 * payload used, so a client that draws the button anyway gets a 403.
 *
 * Hit points are absent by construction: the server strips them from the
 * response. Whether a creature is nearly dead stays the DM's to narrate, which
 * is a separate decision from whether players know what they are fighting.
 */
export function TokenStatBlock({
  campaignId,
  tokenId,
  onClose,
}: {
  campaignId: string;
  tokenId: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<StatBlockResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);

    void api
      .get<StatBlockResponse>(`/api/campaigns/${campaignId}/tokens/${tokenId}/statblock`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load that stat block');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [campaignId, tokenId]);

  const items = (data?.statBlock.items ?? []) as { id: string; name: string; type: string }[];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-16 backdrop-blur-sm">
      <div className="flex max-h-[75vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-ink-800 p-4">
          {data?.imageUrl && (
            <img
              src={data.imageUrl}
              alt=""
              className="size-9 shrink-0 rounded border border-ink-700 object-cover"
            />
          )}
          <h2 className="min-w-0 flex-1 truncate font-display text-lg text-ink-100">
            {data?.name ?? 'Stat block'}
          </h2>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 text-xs text-ink-300">
          {error ? (
            <p className="text-ink-500">{error}</p>
          ) : !data ? (
            <p className="text-ink-600">Loading stat block…</p>
          ) : (
            <div className="space-y-3">
              <p className="text-ink-500">
                {[data.statBlock.size, data.statBlock.type, data.statBlock.alignment]
                  .filter(Boolean)
                  .join(' ') || 'Creature'}
                {data.statBlock.armorClass != null && ` · AC ${data.statBlock.armorClass}`}
                {data.statBlock.challengeRating
                  ? ` · CR ${data.statBlock.challengeRating}`
                  : ''}
              </p>

              <StatBlock monster={data.statBlock} />

              {items.length > 0 && (
                <div>
                  <div className="mb-0.5 text-[10px] tracking-wide text-ink-500 uppercase">
                    Carried
                  </div>
                  {items.map((item) => (
                    <p key={item.id} className="text-ink-300">
                      {item.name} <span className="text-ink-600">({item.type})</span>
                    </p>
                  ))}
                </div>
              )}

              {/* Said out loud rather than left as a gap, so nobody reads a
                  missing number as a bug. */}
              <p className="border-t border-ink-800 pt-2 text-[10px] text-ink-600">
                Hit points are not shown — ask the DM.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
