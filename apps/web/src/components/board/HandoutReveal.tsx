import { useTable } from '../../store/table.js';

/**
 * A handout shown large on every screen for a few seconds.
 *
 * Turns "there is a picture in the journal" into a moment everyone looks up
 * for. Dismissable, because the DM's timing and the players' reading speed are
 * not the same thing.
 */
export function HandoutReveal() {
  const { reveal, dismissReveal } = useTable();
  if (!reveal) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-6 backdrop-blur-sm"
      onClick={dismissReveal}
      role="dialog"
      aria-label={reveal.title}
    >
      <img
        src={reveal.imageUrl}
        alt={reveal.title}
        className="max-h-[80vh] max-w-[90vw] rounded-lg border border-ember-500/40 shadow-2xl shadow-black"
      />
      {reveal.title && (
        <p className="mt-3 font-display text-lg text-ink-100">{reveal.title}</p>
      )}
      <p className="mt-1 text-xs text-ink-500">Click anywhere to dismiss</p>
    </div>
  );
}
