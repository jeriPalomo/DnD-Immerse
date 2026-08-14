/**
 * Small local preferences — the ones that would be irritating to set again
 * every reload, like whether the board's shortcut hint is showing.
 *
 * Deliberately not the zustand stores: nothing here is campaign data, none of
 * it belongs on the server, and a preference that failed to load should not be
 * able to break a page. Reads and writes are wrapped because private browsing
 * and blocked storage both throw rather than returning null.
 */

const PREFIX = 'dnd-immerse:';

export function getPref(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

export function setPref(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(PREFIX + key, value ? '1' : '0');
  } catch {
    // A preference that cannot be saved is not worth failing a render over.
  }
}
