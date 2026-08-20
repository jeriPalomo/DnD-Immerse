import { useState } from 'react';
import { ConditionsReference } from './ConditionsReference.js';

const SHORTCUTS: [string, string][] = [
  ['Esc', 'Clear selection and target'],
  ['Del', 'Delete the selected token (DM)'],
  ['← ↑ ↓ →', 'Nudge the selected token one square'],
  ['Enter', 'Jump to the chat box'],
  ['T', 'Target the selected token'],
  ['Space', 'Next turn (DM, in combat)'],
  ['F', 'Fit the map to the window'],
  ['\\', 'Focus the board, hiding the side panels'],
  ['Ctrl+Z', 'Undo the last delete or move'],
  ['C', 'Your own sheet, without leaving the board'],
  ['?', 'This list'],
];

/**
 * The help dialog: what the keys do, and what the conditions do.
 *
 * Shortcuts nobody can discover are folklore, so this is the affordance that
 * makes the rest real - and the hint under the board points at it. The
 * conditions reference joins it because it is the same kind of thing: something
 * you look up mid-turn and then close. It used to be a collapsed section in the
 * combat panel, where it sat between the DM and the fight.
 */
export function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'keys' | 'conditions'>('keys');
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex gap-1">
            {(
              [
                ['keys', 'Keyboard'],
                ['conditions', 'Status effects'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                aria-selected={tab === id}
                role="tab"
                className={`rounded-lg px-2 py-1 text-sm transition-colors ${
                  tab === id ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:text-ink-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {tab === 'conditions' ? (
          <div className="max-h-[60vh] overflow-y-auto">
            <ConditionsReference />
          </div>
        ) : (
          <>
        <dl className="space-y-1.5">
          {SHORTCUTS.map(([key, what]) => (
            <div key={key} className="flex items-baseline gap-3">
              <dt className="w-24 shrink-0">
                <kbd className="rounded border border-ink-600 bg-ink-850 px-1.5 py-0.5 font-mono text-[11px] text-ink-200">
                  {key}
                </kbd>
              </dt>
              <dd className="text-sm text-ink-300">{what}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-3 border-t border-ink-800 pt-2 text-[11px] text-ink-600">
          Shortcuts pause while you are typing, so chat behaves normally.
        </p>
          </>
        )}
      </div>
    </div>
  );
}
