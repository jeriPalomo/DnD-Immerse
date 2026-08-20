import { Fragment, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTable } from '../../store/table.js';
import type { WireInitiativeEntry } from '@dnd/shared';
import { FACE_GAP_PX, layoutTurnBar, stackOpacity } from './turnBarLayout.js';
import { MovementMeter } from './MovementMeter.js';

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
export function TurnBar({ isDM }: { isDM: boolean }) {
  const { encounter } = useTable();
  const stripRef = useRef<HTMLDivElement | null>(null);
  const positions = useRef(new Map<string, number>());
  const observerRef = useRef<ResizeObserver | null>(null);
  /** Bumped by the ResizeObserver so the fit is recomputed on a resize. */
  const [stripWidth, setStripWidth] = useState(0);

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
   * Recompute the fit when the bar changes size, from the observer rather than
   * a resize timer - the same rule the board's refit follows.
   *
   * Attached by a ref callback rather than a mount effect: this component
   * renders nothing until a fight starts, so an effect with empty dependencies
   * runs while there is no strip to observe and never attaches. The symptom was
   * that the bar fitted itself correctly when a turn advanced but not when the
   * window was resized.
   */
  const attachStrip = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    stripRef.current = node;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => setStripWidth(node.clientWidth));
    observer.observe(node);
    observerRef.current = observer;
    setStripWidth(node.clientWidth);
  }, []);

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

  const { openCount, stackStep } = layoutTurnBar(count, stripWidth);

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

      <div ref={attachStrip} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
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
              // The name lives here rather than on the face. Twelve goblins are
              // twelve identical pictures, and the answer to that is the ring
              // around the one acting, not a column of labels.
              title={`${entry.name} · initiative ${entry.initiative}`}
              className={`relative shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                index === 0
                  ? 'size-12 border-ember-400 shadow-[0_0_0_3px_rgba(249,115,22,0.25)]'
                  : nextRound
                    ? 'size-9 border-ink-800'
                    : 'size-9 border-ink-700'
              }`}
              style={
                index >= openCount
                  ? {
                      // Clumped at the end and fading, still in turn order. The
                      // negative margin eats the flex gap as well as the
                      // overlap, so the fan starts flush against the open row.
                      marginLeft: `-${Math.round(FACE_GAP_PX + (36 - stackStep))}px`,
                      opacity: stackOpacity(index - openCount, count - openCount),
                      zIndex: Math.max(0, count - index),
                    }
                  : { opacity: nextRound ? 0.4 : 0.85 }
              }
            >
              {entry.imageUrl ? (
                <img src={entry.imageUrl} alt="" loading="lazy" className="size-full object-cover" />
              ) : (
                <div className="flex size-full items-center justify-center bg-ink-850 font-display text-ink-400">
                  {entry.name.slice(0, 1).toUpperCase()}
                </div>
              )}
            </div>
          </Fragment>
        ))}
      </div>

      {/* What the creature acting has left to spend, for whoever is running it.
          Here rather than in a side panel: this is read mid-turn, and a number
          nobody sees until the server refuses a drag is an argument rather than
          information. */}
      <MovementMeter isDM={isDM} />
    </div>
  );
}
