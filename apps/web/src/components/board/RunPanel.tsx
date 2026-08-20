import { useState, type ReactNode } from 'react';
import { InitiativeTracker } from './InitiativeTracker.js';
import { CreaturePanel } from './CreaturePanel.js';
import { EnemyHealth } from './EnemyHealth.js';
import { TurnPrompt } from './TurnPrompt.js';
import { ConditionsReference } from './ConditionsReference.js';

/**
 * Everything used with players watching, in one column.
 *
 * Stacked rather than tabbed on purpose. The fight is the thing you must never
 * lose sight of, so the tracker stays on screen while you drop a creature in or
 * check a note - which is exactly what the old Combat / Scene / Journal split
 * made impossible, since placing a monster meant navigating away from the
 * initiative order and back.
 *
 * The bulky parts are collapsed by default so the fight keeps the top of the
 * column. That is the one thing stacking gets wrong if you let it: an earlier
 * version of this app stacked everything and put the wall tool several screens
 * from the initiative order.
 */
export function RunPanel({ campaignId, isDM }: { campaignId: string; isDM: boolean }) {
  return (
    <div className="space-y-2">
      {isDM && <TurnPrompt campaignId={campaignId} />}

      <InitiativeTracker isDM={isDM} />

      {isDM && <EnemyHealth />}

      {isDM && (
        <Section title="Place a creature">
          <CreaturePanel campaignId={campaignId} />
        </Section>
      )}

      {/* Not DM-gated: a player wanting to know what restrained does is asking
          the same question. */}
      <Section title="What conditions do">
        <ConditionsReference />
      </Section>
    </div>
  );
}

/**
 * A collapsed section. Closed by default: open, these would push the fight off
 * the top of a 320px column, which is the whole thing this panel exists to
 * keep in view.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-ink-800">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-xs text-ink-400 transition-colors hover:text-ink-200"
      >
        <span className="text-ink-600">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && <div className="border-t border-ink-800">{children}</div>}
    </div>
  );
}
