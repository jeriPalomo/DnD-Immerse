import { useEffect, useState } from 'react';
import { deriveToken } from '@dnd/shared';
import { useTable } from '../../store/table.js';
import { api } from '../../lib/api.js';

interface StatBlockResponse {
  source: 'compendium' | 'actor' | 'token';
  name: string;
  statBlock: Record<string, any>;
}

/**
 * What the creature whose turn it is can actually do.
 *
 * A 5e turn is: move up to your speed, take one action, and often a bonus
 * action. What complicates it is everything hanging off the creature - it may
 * be concentrating on a spell that ends the moment it takes damage, and its
 * conditions may forbid things outright: an incapacitated creature takes no
 * action at all, a prone one attacks at disadvantage. A stat block does not
 * present any of that as a checklist, and forgetting it is the most common way
 * a fight is run wrong.
 *
 * Everything here is already known. `deriveToken` is the same function the
 * server folds conditions with, so the speed shown is the speed the server
 * will actually allow - the two drifted once before, and a paralyzed token
 * read Speed 0 in the HUD while the server offered it a full 30 ft. The
 * attacks come from the stat block route, which is permission-checked and
 * already knows how to answer for a stamped monster, a hand-written NPC or a
 * bare token.
 */
export function TurnPrompt({ campaignId }: { campaignId: string }) {
  const { encounter, tokens, scene } = useTable();
  const [block, setBlock] = useState<StatBlockResponse | null>(null);

  const active = encounter?.isActive ? (encounter.entries[encounter.activeIndex] ?? null) : null;
  const token = active?.tokenId ? tokens.find((t) => t.id === active.tokenId) : undefined;
  const tokenId = token?.id ?? null;

  useEffect(() => {
    if (!tokenId) {
      setBlock(null);
      return;
    }

    let cancelled = false;
    void api
      .get<StatBlockResponse>(`/api/campaigns/${campaignId}/tokens/${tokenId}/statblock`)
      .then((res) => {
        if (!cancelled) setBlock(res);
      })
      .catch(() => {
        // A creature with nothing behind it is not an error worth shouting
        // about; the rest of the prompt still tells the DM what it can do.
        if (!cancelled) setBlock(null);
      });

    return () => {
      cancelled = true;
    };
  }, [campaignId, tokenId]);

  if (!encounter?.isActive || !active) return null;

  const derived = token
    ? deriveToken({ conditions: token.conditions, ac: token.ac, maxHp: token.maxHp })
    : null;

  const conditions = token?.conditions ?? [];
  const concentrating = conditions.includes('concentrating');

  // Compendium monsters carry their actions in the published blob; a
  // hand-written NPC carries items instead.
  const actions: { name: string }[] = block?.statBlock?.data?.actions
    ? (block.statBlock.data.actions as { name: string }[])
    : ((block?.statBlock?.items ?? []) as { name: string; type: string }[]).filter(
        (item) => item.type === 'weapon',
      );

  return (
    <div className="rounded-lg border border-ember-500/40 bg-ember-500/5 p-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-display text-sm text-ink-100">{active.name}</span>
        <span className="shrink-0 text-[10px] tracking-wider text-ember-400 uppercase">
          Round {encounter.round}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-400">
        <span>
          Move <span className="font-mono text-ink-200">{derived?.speed ?? 30} ft</span>
          {scene && (
            <span className="text-ink-600">
              {' '}
              ({Math.floor((derived?.speed ?? 30) / (scene.feetPerSquare || 5))} sq)
            </span>
          )}
        </span>
        <span>1 action{derived?.incapacitated ? '' : ' · 1 bonus action'}</span>
      </div>

      {derived?.incapacitated && (
        <p className="mt-1 rounded bg-red-950/40 px-1.5 py-1 text-[11px] text-red-300">
          Incapacitated — no action, no bonus action, no reaction.
        </p>
      )}

      {!derived?.incapacitated && (derived?.hasDisadvantage || derived?.hasAdvantage) && (
        <p className="mt-1 text-[11px] text-arcane-300">
          Attacks at {derived.hasDisadvantage && derived.hasAdvantage
            ? 'normal — advantage and disadvantage cancel'
            : derived.hasDisadvantage
              ? 'disadvantage'
              : 'advantage'}
        </p>
      )}

      {derived?.blinded && (
        <p className="mt-1 text-[11px] text-ink-400">Blinded — it cannot see anything.</p>
      )}

      {concentrating && (
        <p className="mt-1 text-[11px] text-arcane-300">
          ◈ Concentrating — damage forces a save to hold it.
        </p>
      )}

      {conditions.length > 0 && (
        <p className="mt-1 text-[11px] text-ink-500">
          {conditions.join(', ')}
        </p>
      )}

      {actions.length > 0 && (
        <div className="mt-1.5 border-t border-ink-800 pt-1.5">
          <div className="text-[10px] tracking-wider text-ink-500 uppercase">Can do</div>
          <p className="text-[11px] text-ink-300">
            {actions.slice(0, 6).map((a) => a.name).join(' · ')}
          </p>
        </div>
      )}
    </div>
  );
}
