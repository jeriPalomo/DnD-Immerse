import { useTable } from '../../store/table.js';

/**
 * A short-lived message with an undo button.
 *
 * Preferred over a confirm dialog on delete: a confirm you click forty times a
 * session stops being read, whereas an undo forgives the one time it matters.
 */
export function Toast() {
  const { toast, undo, dismissToast } = useTable();
  if (!toast) return null;

  return (
    <div
      role="status"
      className="pointer-events-auto fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 shadow-xl shadow-black/50"
    >
      <span className="text-sm text-ink-200">{toast.message}</span>
      {toast.undo && (
        <button
          onClick={undo}
          className="rounded border border-ember-500/60 bg-ember-500/15 px-2 py-0.5 text-xs text-ember-300 hover:bg-ember-500/25"
        >
          Undo
        </button>
      )}
      <button
        onClick={dismissToast}
        className="text-ink-600 hover:text-ink-300"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
