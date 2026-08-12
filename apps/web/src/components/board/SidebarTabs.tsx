import { useState, type ReactNode } from 'react';
import { ErrorBoundary } from '../ErrorBoundary.js';

export interface SidebarTab {
  id: string;
  label: string;
  node: ReactNode;
}

/**
 * One tabbed panel instead of a column of stacked ones.
 *
 * Stacking put the wall tool and the initiative order several screens apart,
 * which meant scrolling between them mid-combat. Only the active tab is
 * mounted, so the soundboard and journal are not fetching in the background
 * while you fight.
 */
export function SidebarTabs({ tabs }: { tabs: SidebarTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? '');

  if (tabs.length === 0) return null;

  // Fall back to the first tab if the active one disappears - which happens
  // when a player looks at a DM-only tab that then unmounts.
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-ink-700 bg-ink-900">
      <div
        role="tablist"
        aria-label="Table panels"
        className="flex shrink-0 gap-1 border-b border-ink-800 p-1.5"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === current.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(tab.id)}
              className={`flex-1 rounded-lg px-2 py-1.5 text-xs transition-colors ${
                isActive
                  ? 'bg-ink-800 text-ink-100'
                  : 'text-ink-500 hover:bg-ink-850 hover:text-ink-300'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {/* Keyed on the tab so switching away from a crashed panel resets it. */}
        <ErrorBoundary key={current.id} label={current.label}>
          {current.node}
        </ErrorBoundary>
      </div>
    </div>
  );
}
