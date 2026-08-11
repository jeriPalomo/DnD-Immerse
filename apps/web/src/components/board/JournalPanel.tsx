import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui.js';
import { api } from '../../lib/api.js';

interface Page {
  id: string;
  title: string;
  bodyMarkdown: string;
}

interface Entry {
  id: string;
  title: string;
  pages: Page[];
}

/**
 * Campaign notes, and what the party is allowed to read of them.
 *
 * Entries are DM-only until shown, and the server filters unshared entries out
 * of the player payload — so a player's browser never holds the DM's notes on
 * the villain, shown or not.
 */
export function JournalPanel({ campaignId, isDM }: { campaignId: string; isDM: boolean }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [shared, setShared] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const res = await api.get<{ entries: Entry[] }>(`/api/campaigns/${campaignId}/journal`);
    setEntries(res.entries);
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    try {
      const res = await api.post<{ entry: Entry }>(`/api/campaigns/${campaignId}/journal`, {
        title: `Note ${entries.length + 1}`,
      });
      await load();
      setOpenId(res.entry.id);
    } finally {
      setBusy(false);
    }
  }

  /** Debounced, like the character sheet: typing should not be a request each. */
  function editPage(pageId: string, bodyMarkdown: string) {
    setEntries((current) =>
      current.map((entry) => ({
        ...entry,
        pages: entry.pages.map((page) => (page.id === pageId ? { ...page, bodyMarkdown } : page)),
      })),
    );

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void api.patch(`/api/journal/pages/${pageId}`, { bodyMarkdown });
    }, 600);
  }

  async function toggleShare(entryId: string) {
    const next = !shared[entryId];
    setShared({ ...shared, [entryId]: next });
    await api.post(`/api/journal/${entryId}/share`, { shared: next });
  }

  async function remove(entryId: string) {
    await api.delete(`/api/journal/${entryId}`);
    if (openId === entryId) setOpenId(null);
    await load();
  }

  if (!isDM && entries.length === 0) return null;

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-display text-sm text-ink-100">Journal</h2>
        {isDM && (
          <Button size="sm" variant="ghost" onClick={() => void create()} loading={busy}>
            New note
          </Button>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="text-[11px] text-ink-600">
          Nothing yet. Notes stay private until you show them to the party.
        </p>
      ) : (
        <ul className="space-y-1">
          {entries.map((entry) => {
            const isOpen = openId === entry.id;
            const page = entry.pages[0];

            return (
              <li key={entry.id} className="rounded-lg border border-ink-800">
                <div className="flex items-center gap-1.5 px-2 py-1.5">
                  <button
                    onClick={() => setOpenId(isOpen ? null : entry.id)}
                    className="min-w-0 flex-1 truncate text-left text-xs text-ink-200"
                  >
                    {isOpen ? '▾' : '▸'} {entry.title}
                  </button>

                  {isDM && (
                    <>
                      <button
                        onClick={() => void toggleShare(entry.id)}
                        className={`shrink-0 rounded border px-1.5 text-[10px] transition-colors ${
                          shared[entry.id]
                            ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                            : 'border-ink-700 text-ink-500 hover:text-ink-300'
                        }`}
                        title="Show this entry to the party"
                      >
                        {shared[entry.id] ? 'shown' : 'show'}
                      </button>
                      <button
                        onClick={() => void remove(entry.id)}
                        className="shrink-0 text-ink-700 hover:text-red-400"
                        aria-label={`Delete ${entry.title}`}
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>

                {isOpen && page && (
                  <div className="border-t border-ink-800 p-2">
                    {isDM ? (
                      <textarea
                        value={page.bodyMarkdown}
                        onChange={(e) => editPage(page.id, e.target.value)}
                        rows={6}
                        placeholder="Names, clues, whatever you need to remember…"
                        aria-label={`${entry.title} body`}
                        className="w-full resize-y rounded border border-ink-700 bg-ink-850 px-2 py-1.5 text-xs text-ink-200 placeholder:text-ink-600 focus:border-arcane-400 focus:outline-none"
                      />
                    ) : (
                      <p className="text-xs whitespace-pre-wrap text-ink-300">
                        {page.bodyMarkdown || <span className="text-ink-600">Empty.</span>}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
