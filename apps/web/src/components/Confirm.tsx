import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * "Are you sure", asked by the app rather than by the browser.
 *
 * `window.confirm` looked fine and was not: after a page has raised a few of
 * them, Edge and Chrome offer "prevent this page from creating additional
 * dialogs", and from then on every `confirm()` returns **false** without showing
 * anything. Every feature gated on one silently stops working - which is exactly
 * how deleting a scene and clearing the log both arrived as "the button does
 * nothing" while the code behind them was correct and the API call, once the
 * dialog was accepted, returned 200.
 *
 * It is also modal to the whole browser, unstyled, and impossible to drive in a
 * test without a dialog handler. This is none of those things.
 */
export interface ConfirmRequest {
  title: string;
  /** The consequence, in a sentence. What "this cannot be undone" should say. */
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red rather than ember, for the ones that destroy something. */
  danger?: boolean;
}

type Ask = (request: ConfirmRequest) => Promise<boolean>;

const ConfirmContext = createContext<Ask | null>(null);

/**
 * Returns a function that resolves true or false, so a call site reads almost
 * exactly as `confirm()` did - `if (!(await ask({...}))) return;`.
 */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error('useConfirm needs a ConfirmProvider above it');
  return ask;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback<Ask>((next) => {
    // A second question while one is open answers the first with "no" rather
    // than losing its promise and leaving that caller waiting for ever.
    resolver.current?.(false);
    setRequest(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setRequest(null);
  }, []);

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {request && <ConfirmDialog request={request} onSettle={settle} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({
  request,
  onSettle,
}: {
  request: ConfirmRequest;
  onSettle: (ok: boolean) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();

    // Escape cancels, the way it does everywhere else on the board. Captured on
    // the window rather than the dialog, since the click that opened this may
    // have left focus somewhere else entirely.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onSettle(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onSettle]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={() => onSettle(false)}
      role="dialog"
      aria-modal="true"
      aria-label={request.title}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-ink-700 bg-ink-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="font-display text-lg text-ink-100">{request.title}</h2>
        {request.body && <p className="mt-2 text-sm text-ink-400">{request.body}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => onSettle(false)}
            className="rounded-lg border border-ink-700 px-3 py-1.5 text-sm text-ink-300 transition-colors hover:text-ink-100"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            onClick={() => onSettle(true)}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              request.danger
                ? 'bg-red-600/90 text-white hover:bg-red-600'
                : 'bg-ember-500 text-ink-950 hover:bg-ember-400'
            }`}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
