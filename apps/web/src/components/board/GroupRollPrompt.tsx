import { useTable } from '../../store/table.js';

/**
 * "The DM has asked you for a roll."
 *
 * The button is also on the card in the log, which is where the answer appears
 * - but the log is a column somebody may not be looking at, and a request that
 * goes unnoticed stalls the table. This is the same lesson as the sheet drawer,
 * which nobody found while it was a keystroke only.
 *
 * The pending state is read straight out of the messages rather than kept
 * anywhere of its own: the request *is* the message, so a reload, a late join
 * and a second tab all see the same thing.
 */
export function GroupRollPrompt({ myActorIds }: { myActorIds: string[] }) {
  const { messages, answerGroupRoll } = useTable();

  // Only the most recent one. Two open requests at once is the DM asking twice
  // without waiting, and stacking banners would push the fight off the screen -
  // the older one is still answerable from its own card in the log.
  const pending = [...messages]
    .reverse()
    .map((message) => {
      const rows = (message.groupData?.rows ?? []).filter(
        (row) => row.total === null && row.actorId !== null && myActorIds.includes(row.actorId),
      );
      return rows.length > 0 ? { message, rows } : null;
    })
    .find((entry): entry is NonNullable<typeof entry> => entry !== null);

  if (!pending) return null;

  return (
    <div className="rounded-lg border border-ember-500/60 bg-ember-500/10 p-2">
      <div className="text-[10px] tracking-wider text-ember-400 uppercase">The DM asks for</div>
      <div className="mt-0.5 text-sm text-ink-100">
        {pending.message.groupData!.label}
        {pending.message.groupData!.dc !== null && (
          <span className="ml-1.5 font-mono text-[11px] text-ink-400">
            DC {pending.message.groupData!.dc}
          </span>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {pending.rows.map((row) => (
          <button
            key={row.actorId}
            onClick={() => answerGroupRoll(pending.message.id, row.actorId!)}
            className="rounded border border-ember-500/60 bg-ember-500/20 px-2 py-1 text-xs text-ember-200 transition-colors hover:bg-ember-500/30"
          >
            {/* Named, because a player with two characters is asked for both
                and "Roll" alone would not say which. */}
            Roll for {row.name} ({row.modifier >= 0 ? `+${row.modifier}` : row.modifier})
          </button>
        ))}
      </div>
    </div>
  );
}
