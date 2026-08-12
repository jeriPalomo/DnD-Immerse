import { useEffect, useRef } from 'react';

/**
 * Keyboard shortcuts for the table.
 *
 * One listener owns every key rather than each panel adding its own, so the
 * focus guard below is written once and cannot be forgotten. That guard is the
 * whole risk here: typing "delete" in chat must not delete a token.
 */

export type HotkeyHandler = (event: KeyboardEvent) => void;

/** True when the user is typing, and shortcuts must stay out of the way. */
export function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;

  const tag = element.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    element.isContentEditable === true
  );
}

export interface HotkeyMap {
  [key: string]: HotkeyHandler;
}

/**
 * Binds a map of `event.key` values to handlers.
 *
 * Keys are matched case-insensitively, so Shift+/ arrives as "?" and a plain
 * "t" and "T" behave the same. Modifier combinations are deliberately not
 * supported - the browser and the OS already own those, and quietly stealing
 * Ctrl+F from someone is worse than having one fewer shortcut.
 */
export function useHotkeys(map: HotkeyMap, enabled = true): void {
  // Kept in a ref so re-rendering does not detach and reattach the listener,
  // which would drop a keypress landing in the gap.
  const handlers = useRef(map);
  handlers.current = map;

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (isTyping(event.target)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const handler =
        handlers.current[event.key] ?? handlers.current[event.key.toLowerCase()];
      if (!handler) return;

      handler(event);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
