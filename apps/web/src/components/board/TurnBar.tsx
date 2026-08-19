import { Fragment, useLayoutEffect, useRef } from 'react';
import { useTable } from '../../store/table.js';
import type { WireInitiativeEntry } from '@dnd/shared';

/** Fixed, because the board's height calculation has to subtract it. */
export const TURN_BAR_HEIGHT_REM = 4.5;

/** Beyond this fraction of the bar's width, a move is a wrap, not a shift. */
const WRAP_FRACTION = 0.6;
const SLIDE_MS = 320;

/**
 * The turn order, as a strip you read left to right.
 *
 * The order itself has always existed - initiative, sorted with the handbook's
 * Dexterity tiebreaker, wrapping into the next round - but it lived as a
 * vertical list inside a 320px column, where "who is next" takes reading rather
 * than a glance.
 *
 * Rotated so the creature acting now is always at the front. As turns advance
 * the strip moves: whoever just acted leaves the front and everyone shuffles up
 * behind them.
 *
 * No hit points are drawn here, deliberately. Names and initiative are already
 * public in the tracker, so this discloses nothing new - and a health bar would
 * have needed one shape for the DM and another for players, whose payload has
 * enemy hit points redacted.
 */
export function TurnBar() {
  const { encounter } = useTable();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const positions = useRef(new Map<string, number>());

  const entries = encounter?.entries ?? [];
  const count = entries.length;
  const activeIndex = encounter?.activeIndex ?? 0;

  // Rotated to start at whoever is acting, so reading order is turn order.
  const rotated: { entry: WireInitiativeEntry; nextRound: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const index = (activeIndex + i) % count;
    rotated.push({ entry: entries[index], nextRound: activeIndex + i >= count });
  }

  /**
   * FLIP: the nodes have already moved by the time this runs, so measure where
   * each one is now, put it back where it was with no transition, and release
   * it on the next frame. React has kept the same DOM node per entry id, which
   * is what makes the movement continuous rather than a repaint.
   */
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const previous = positions.current;
    const next = new Map<string, number>();
    const width = strip.getBoundingClientRect().width || 1;

    for (const node of Array.from(strip.children) as HTMLElement[]) {
      const id = node.dataset.entryId;
      if (!id) continue;

      const left = node.offsetLeft;
      next.set(id, left);

      const before = previous.get(id);
      if (reduced || before === undefined || before === left) continue;

      const delta = before - left;

      // The creature that just acted travels from the front of the bar to the
      // back. Sliding that literally is a portrait shooting across the whole
      // screen, so it cross-fades in place instead; everyone else shuffles.
      if (Math.abs(delta) > width * WRAP_FRACTION) {
        node.animate(
          [
            { opacity: 0, transform: 'scale(0.85)' },
            { opacity: 1, transform: 'scale(1)' },
          ],
          { duration: SLIDE_MS, easing: 'ease-out' },
        );
        continue;
      }

      node.animate(
        [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }],
        { duration: SLIDE_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    }

    positions.current = next;
  }, [activeIndex, encounter?.round, count]);

  if (!encounter?.isActive || count === 0) return null;

  return (
    <div
      className="mb-3 flex items-center gap-3 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 px-3"
      style={{ height: `${TURN_BAR_HEIGHT_REM}rem` }}
    >
      <div className="shrink-0 text-center">
        <div className="text-[9px] tracking-widest text-ink-500 uppercase">Round</div>
        <div className="font-display text-lg leading-none text-ember-400">{encounter.round}</div>
      </div>

      <div ref={stripRef} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {rotated.map(({ entry, nextRound }, index) => (
          <Fragment key={entry.id}>
            {/* Where the next round starts, so the wrap is legible rather than
                the same faces appearing twice for no stated reason. A sibling
                of the entries, not a child of one: inside the box it read as
                part of that creature's name. */}
            {nextRound && index > 0 && !rotated[index - 1].nextRound && (
              <div className="flex shrink-0 flex-col items-center gap-0.5 px-1">
                <span className="text-[8px] tracking-wider text-ink-600 uppercase">
                  Round {encounter.round + 1}
                </span>
                <span className="h-4 w-px bg-ink-700" />
              </div>
            )}

            <div
              data-entry-id={entry.id}
              title={`${entry.name} · initiative ${entry.initiative}`}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-1.5 py-1 ${
                index === 0
                  ? 'border-ember-400 bg-ember-500/15'
                  : nextRound
                    ? 'border-ink-800 opacity-50'
                    : 'border-ink-800'
              }`}
            >
            <div
              className={`overflow-hidden rounded border border-ink-700 bg-ink-850 ${
                index === 0 ? 'size-9' : 'size-7'
              }`}
            >
              {entry.imageUrl ? (
                <img src={entry.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center text-[10px] text-ink-600">
                  {entry.name.slice(0, 1).toUpperCase()}
                </div>
              )}
            </div>

            <div className="min-w-0">
              <div
                className={`max-w-24 truncate text-xs ${
                  index === 0 ? 'text-ink-100' : 'text-ink-400'
                }`}
              >
                {entry.name}
              </div>
              <div className="font-mono text-[9px] text-ink-600">{entry.initiative}</div>
            </div>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
