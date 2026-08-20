import { useState, type ReactNode } from 'react';
import { InitiativeTracker } from './InitiativeTracker.js';
import { CreaturePanel } from './CreaturePanel.js';
import { GroupRoll } from './GroupRoll.js';
import { GroupRollPrompt } from './GroupRollPrompt.js';
import { EnemyHealth } from './EnemyHealth.js';
import { TurnPrompt } from './TurnPrompt.js';

/**
 * Everything used with players watching, in one column, in two regions.
 *
 * Stacked rather than tabbed on purpose. The fight is the thing you must never
 * lose sight of, so the tracker stays on screen while you drop a creature in or
 * check a note - which is exactly what the old Combat / Scene / Journal split
 * made impossible, since placing a monster meant navigating away from the
 * initiative order and back.
 *
 * But stacking alone was not enough: with the tools open, the whole column
 * became one long scroll and the turn order went off the top of it - which is
 * the failure this panel exists to prevent, arriving by a different route. So
 * the fight is **pinned** and only the tools below it scroll. The panel owns
 * that scroll rather than `SidebarTabs`, because a pinned region needs
 * something to pin against.
 */
export function RunPanel({
  campaignId,
  isDM,
  myActorIds = [],
}: {
  campaignId: string;
  isDM: boolean;
  /** The sheets this person may answer a group roll for. */
  myActorIds?: string[];
}) {
  return (
    <div className="flex h-full flex-col gap-2">
      {/* Pinned: whose turn it is, and anything waiting on the person reading
          this. Never scrolls away, however much is open underneath. */}
      <div className="shrink-0 space-y-2">
        {/* Above the tracker on purpose: it is the one thing here that is
            waiting on the reader, and it goes the moment they answer. */}
        <GroupRollPrompt myActorIds={myActorIds} />

        {isDM && <TurnPrompt campaignId={campaignId} />}

        <InitiativeTracker isDM={isDM} />
      </div>

      {/* The tools. `min-h-0` is load-bearing: a flex child defaults to a
          min-height of its content, so without it this refuses to shrink and
          pushes the pinned region off the screen instead of scrolling. */}
      {isDM && (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          <EnemyHealth />

          <Section title="Place a creature">
            <CreaturePanel campaignId={campaignId} />
          </Section>

          <Section title="Roll for a group">
            <GroupRoll />
          </Section>
        </div>
      )}
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
