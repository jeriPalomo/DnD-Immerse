import { useEffect } from 'react';
import { useAuth } from '../../store/auth.js';
import { useTable } from '../../store/table.js';

/**
 * What the acting creature has left of its turn.
 *
 * Lives in the turn bar because that is where the eye already is once a fight
 * is running - a movement budget in a side panel is a number nobody reads until
 * the server refuses a drag, at which point it is an argument rather than
 * information.
 *
 * Shown only for a creature you actually control. Remaining movement plus what
 * has been spent is a creature's speed, and speed is stat block data: drawing
 * this over a monster would hand every player the thing `statsHidden` exists to
 * withhold. The DM sees it for whatever is acting, which is how they run one.
 */
export function MovementMeter({ isDM }: { isDM: boolean }) {
  const { user } = useAuth();
  const { encounter, tokens, moveRange, queryMovement } = useTable();

  const active = encounter?.isActive ? (encounter.entries[encounter.activeIndex] ?? null) : null;
  const token = active?.tokenId ? (tokens.find((t) => t.id === active.tokenId) ?? null) : null;
  const mine = Boolean(token && (isDM || token.ownerUserId === user?.id));

  /**
   * Asked for rather than pushed. The budget rides on the movement reply, which
   * the server only answers for someone allowed to ask - so the meter has to
   * ask before it can draw, and it asks again whenever the acting creature
   * changes.
   */
  useEffect(() => {
    if (token && mine && moveRange.tokenId !== token.id) queryMovement(token.id);
  }, [token, mine, moveRange.tokenId, queryMovement]);

  if (!token || !mine) return null;
  if (moveRange.tokenId !== token.id || moveRange.leftFeet === null) return null;

  const left = Math.round(moveRange.leftFeet);
  const max = Math.round(moveRange.maxFeet ?? 0);
  const fraction = max > 0 ? Math.max(0, Math.min(1, left / max)) : 0;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <div className="text-right">
        <div className="text-[9px] tracking-widest text-ink-500 uppercase">Move</div>
        <div className="font-display text-sm leading-none text-ink-200">
          {left}
          <span className="text-ink-500"> / {max} ft</span>
        </div>
      </div>

      {/* A bar as well as a number: "14 left" takes reading, a bar a fifth full
          does not, and this is read mid-turn with four people waiting. */}
      <div className="h-8 w-1.5 overflow-hidden rounded-full bg-ink-800">
        <div
          className={`w-full transition-[height] ${left > 0 ? 'bg-ember-400' : 'bg-ink-700'}`}
          style={{ height: `${fraction * 100}%`, marginTop: `${(1 - fraction) * 100}%` }}
        />
      </div>

    </div>
  );
}
