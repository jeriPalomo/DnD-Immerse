import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../ui.js';
import { api } from '../../lib/api.js';
import { useTable } from '../../store/table.js';

interface Page {
  id: string;
  title: string;
  type: 'text' | 'image' | 'pdf';
  bodyMarkdown: string;
  fileUrl: string | null;
}

interface Entry {
  id: string;
  title: string;
  /** Reported by the server; local state guessed wrong after a reload. */
  shared: boolean;
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
  const [busy, setBusy] = useState(false);
  const { showHandout, journalVersion } = useTable();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const res = await api.get<{ entries: Entry[] }>(`/api/campaigns/${campaignId}/journal`);
    setEntries(res.entries);
  }, [campaignId]);

  // Refetches when anyone shares an entry, so a player sees a note appear
  // without reloading the table.
  useEffect(() => {
    void load();
  }, [load, journalVersion]);

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

  async function toggleShare(entry: Entry) {
    // Optimistic, then reconciled from the server on reload.
    setEntries((current) =>
      current.map((e) => (e.id === entry.id ? { ...e, shared: !e.shared } : e)),
    );
    try {
      await api.post(`/api/journal/${entry.id}/share`, { shared: !entry.shared });
    } finally {
      // Reload either way: on failure this puts the pill back where it belongs
      // rather than leaving it claiming the party can read something.
      await load();
    }
  }

  async function addImage(entryId: string, file: File) {
    await api.upload(`/api/journal/${entryId}/pages/image`, file);
    await load();
  }

  async function removePage(pageId: string) {
    await api.delete(`/api/journal/pages/${pageId}`);
    await load();
  }

  async function remove(entryId: string) {
    await api.delete(`/api/journal/${entryId}`);
    if (openId === entryId) setOpenId(null);
    await load();
  }

  if (!isDM && entries.length === 0) return null;

  return (
    <div className="p-2">
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
                        onClick={() => void toggleShare(entry)}
                        className={`shrink-0 rounded border px-1.5 text-[10px] transition-colors ${
                          entry.shared
                            ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                            : 'border-ink-700 text-ink-500 hover:text-ink-300'
                        }`}
                        title={entry.shared ? 'Take this back from the party' : 'Show this entry to the party'}
                      >
                        {entry.shared ? 'shown' : 'show'}
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

                {isOpen && (
                  <div className="space-y-2 border-t border-ink-800 p-2">
                    {entry.pages.map((p) =>
                      p.type === 'image' && p.fileUrl ? (
                        <figure key={p.id}>
                          <img
                            src={p.fileUrl}
                            alt={p.title}
                            className="w-full rounded border border-ink-700"
                          />
                          <figcaption className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-ink-500">
                            <span className="min-w-0 flex-1 truncate">{p.title}</span>
                            {isDM && (
                              <>
                                <button
                                  onClick={() => showHandout(p.id)}
                                  title="Show this large on everyone's screen"
                                  className="shrink-0 rounded border border-ember-500/50 px-1.5 text-[10px] text-ember-300 hover:bg-ember-500/15"
                                >
                                  reveal
                                </button>
                                <button
                                  onClick={() => void removePage(p.id)}
                                  className="shrink-0 text-ink-700 hover:text-red-400"
                                  aria-label={`Remove ${p.title}`}
                                >
                                  ✕
                                </button>
                              </>
                            )}
                          </figcaption>
                        </figure>
                      ) : isDM ? (
                        <textarea
                          key={p.id}
                          value={p.bodyMarkdown}
                          onChange={(e) => editPage(p.id, e.target.value)}
                          rows={6}
                          placeholder="Names, clues, whatever you need to remember…"
                          aria-label={`${entry.title} body`}
                          className="w-full resize-y rounded border border-ink-700 bg-ink-850 px-2 py-1.5 text-xs text-ink-200 placeholder:text-ink-600 focus:border-arcane-400 focus:outline-none"
                        />
                      ) : (
                        <p key={p.id} className="text-xs whitespace-pre-wrap text-ink-300">
                          {p.bodyMarkdown || <span className="text-ink-600">Empty.</span>}
                        </p>
                      ),
                    )}

                    {isDM && (
                      <label className="block cursor-pointer text-[10px] text-arcane-400 hover:underline">
                        + add an image handout
                        <input
                          type="file"
                          accept="image/*"
                          className="sr-only"
                          aria-label={`Add image to ${entry.title}`}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void addImage(entry.id, file);
                          }}
                        />
                      </label>
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
