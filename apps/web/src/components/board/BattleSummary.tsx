import { useTable } from '../../store/table.js';

/**
 * What the fight came to, over the board where the fight happened.
 *
 * It used to be four lines of chat, which is where it was least likely to be
 * read: a fight ends with everyone still looking at the map, and the summary
 * arrived under the last damage roll and scrolled away with it. Here it waits.
 *
 * Dismissed by hand rather than on a timer, unlike `HandoutReveal` - a handout
 * is a picture everyone glances at, while this is a column of numbers somebody
 * will want to read twice and may want to write down.
 *
 * The text is the server's, rendered as it arrives. Re-deriving the lines here
 * would be a second opinion about how long a fight took.
 */
export function BattleSummary() {
  const { battleSummary, dismissBattleSummary } = useTable();
  if (!battleSummary) return null;

  const [headline, ...rest] = battleSummary.split('\n');

  return (
    <div
      role="dialog"
      aria-label="Battle summary"
      className="pointer-events-auto absolute inset-x-0 top-4 z-30 mx-auto w-fit max-w-[92%]"
    >
      <div className="rounded-xl border border-ember-500/50 bg-ink-950/95 px-5 py-4 shadow-2xl shadow-black/60 backdrop-blur">
        <div className="flex items-start gap-6">
          <div className="min-w-0">
            <h2 className="font-display text-lg text-ember-300">{headline}</h2>
            <ul className="mt-1.5 space-y-0.5">
              {rest.map((line) => (
                <li key={line} className="text-sm text-ink-300">
                  {line}
                </li>
              ))}
            </ul>
          </div>
          <button
            onClick={dismissBattleSummary}
            aria-label="Dismiss"
            className="shrink-0 rounded px-2 py-1 text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-100"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
