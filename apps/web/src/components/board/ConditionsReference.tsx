import { CONDITIONS, CONDITION_GLYPH, CONDITION_SUMMARY, conditionIsAutomated } from '@dnd/shared';

/**
 * What each condition actually does.
 *
 * The rules for these are short, easy to half-remember and easy to get wrong -
 * prone gives attacks against you advantage in melee and disadvantage at range,
 * which almost nobody recalls correctly at the table.
 *
 * Each row says whether the app enforces it, and that flag is derived from
 * `CONDITION_EFFECTS` rather than written down again, so it cannot claim
 * automation that is not there. The five it does not enforce are the DM's to
 * apply, which is the same bargain struck everywhere else here: an omission
 * means you do it by hand, where a wrong entry would make the app confidently
 * wrong.
 */
export function ConditionsReference() {
  return (
    <div className="p-2">
      <p className="mb-2 text-[11px] text-ink-500">
        <span className="text-ink-300">Applied</span> conditions change the numbers the server
        uses. <span className="text-ink-300">By hand</span> ones are yours to enforce — they turn
        on intent rather than arithmetic.
      </p>

      <ul className="space-y-1.5">
        {CONDITIONS.map((condition) => {
          const automated = conditionIsAutomated(condition);

          return (
            <li key={condition} className="rounded border border-ink-800 px-2 py-1.5">
              <div className="flex items-baseline gap-1.5">
                <span className="text-ink-500">{CONDITION_GLYPH[condition] ?? '•'}</span>
                <span className="text-xs text-ink-200 capitalize">{condition}</span>
                <span
                  className={`ml-auto shrink-0 rounded px-1 text-[9px] tracking-wide uppercase ${
                    automated ? 'bg-arcane-500/20 text-arcane-300' : 'bg-ink-800 text-ink-500'
                  }`}
                >
                  {automated ? 'Applied' : 'By hand'}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-ink-400">
                {CONDITION_SUMMARY[condition]}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
