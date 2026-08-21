import { useEffect, useState } from 'react';
import { Button } from '../ui.js';
import { api } from '../../lib/api.js';
import type { SubclassFeature } from '../../store/sheet.js';

/**
 * The subclass a table wrote for itself.
 *
 * The SRD publishes exactly one subclass per class, and the rest are copyright,
 * so a Battle Master or a Bladesinger has nothing to draw on. Written here once
 * and read at every level-up afterwards, which is the whole trade: five minutes
 * of typing buys a twenty-level campaign.
 *
 * Deliberately not a wizard or a template. What each feature is called and what
 * it says are the two things only the person playing it knows, and any attempt
 * to guess them from a name would be the confidently-wrong this app refuses.
 */
export function SubclassEditor({
  actorId,
  subclassName,
  publishedSubclass,
  saved,
  editable,
  onSaved,
}: {
  actorId: string;
  /** What the sheet says. Empty means there is nothing to write against yet. */
  subclassName: string;
  /** What the compendium carries for this class, which needs no writing. */
  publishedSubclass: string | null;
  saved: SubclassFeature[];
  editable: boolean;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<SubclassFeature[]>(saved);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Reloaded when the sheet is: saving elsewhere, or switching character, must
  // not leave the editor showing the last sheet's subclass.
  useEffect(() => {
    setRows(saved);
    setDirty(false);
  }, [saved]);

  const isPublished =
    Boolean(publishedSubclass) &&
    subclassName.trim().toLowerCase() === publishedSubclass?.trim().toLowerCase();

  // Written for a subclass this sheet no longer plays. Said rather than
  // silently ignored: the rows are still there and still recoverable by putting
  // the old name back, which is friendlier than deleting them.
  const writtenFor = rows.find((row) => row.subclassName)?.subclassName ?? '';
  const stale =
    Boolean(writtenFor) &&
    Boolean(subclassName.trim()) &&
    writtenFor.trim().toLowerCase() !== subclassName.trim().toLowerCase();

  function edit(index: number, fields: Partial<SubclassFeature>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...fields } : row)));
    setDirty(true);
  }

  function add() {
    setRows((current) => [
      ...current,
      { subclassName, level: current.length ? current[current.length - 1]!.level : 3, name: '', description: '' },
    ]);
    setDirty(true);
    setOpen(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/actors/${actorId}/subclass-features`, {
        // Blank rows are dropped rather than refused: an empty row somebody
        // added and thought better of should not block the save.
        features: rows
          .filter((row) => row.name.trim())
          .map((row) => ({ level: row.level, name: row.name.trim(), description: row.description })),
      });
      setDirty(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the subclass');
    } finally {
      setBusy(false);
    }
  }

  if (!editable && rows.length === 0) return null;

  // Nothing to write against, and nothing worth nagging about: a class picks
  // its subclass at second or third level, not at first.
  if (!subclassName.trim() && rows.length === 0) {
    return editable ? (
      <p className="mt-2 text-[11px] text-ink-600">
        Set a subclass above to write down what it grants at each level.
      </p>
    ) : null;
  }

  return (
    <div className="mt-3 rounded-lg border border-ink-800 bg-ink-900/40 p-2" id="subclass-editor">
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="text-xs font-semibold text-ink-200"
        >
          {open ? '▾' : '▸'} {subclassName || writtenFor || 'Subclass'}
        </button>
        <span className="text-[10px] text-ink-600">
          {rows.length === 0 ? 'nothing written yet' : `${rows.length} by level`}
        </span>
        {editable && (
          <Button size="sm" variant="ghost" onClick={add} className="ml-auto">
            Add feature
          </Button>
        )}
      </div>

      {/* The compendium already has this one, so writing it out again would be
          two answers to one question. */}
      {isPublished && (
        <p className="mt-1 text-[11px] text-ink-500">
          {publishedSubclass} is published — its features arrive at level-up without any of this.
        </p>
      )}

      {stale && (
        <p className="mt-1 text-[11px] text-amber-400">
          These were written for {writtenFor}, and the sheet now says{' '}
          {subclassName || 'nothing'}. They are not being used — put the name back, or save to
          re-file them under {subclassName}.
        </p>
      )}

      {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}

      {open && (
        <>
          <ul className="mt-2 space-y-1.5">
            {rows.map((row, index) => (
              <li key={index} className="rounded border border-ink-800 bg-ink-950/40 p-1.5">
                <div className="flex items-center gap-1.5">
                  <label className="flex items-center gap-1 text-[10px] text-ink-500">
                    Lv
                    <input
                      type="number"
                      min={1}
                      max={20}
                      disabled={!editable}
                      value={row.level}
                      onChange={(e) =>
                        edit(index, { level: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })
                      }
                      className="w-12 rounded border border-ink-700 bg-ink-900 px-1 py-0.5 text-xs text-ink-100"
                    />
                  </label>
                  <input
                    disabled={!editable}
                    value={row.name}
                    onChange={(e) => edit(index, { name: e.target.value })}
                    placeholder="Feature name"
                    className="flex-1 rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-xs text-ink-100"
                  />
                  {editable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRows((current) => current.filter((_, i) => i !== index));
                        setDirty(true);
                      }}
                    >
                      ×
                    </Button>
                  )}
                </div>
                <textarea
                  disabled={!editable}
                  value={row.description}
                  onChange={(e) => edit(index, { description: e.target.value })}
                  placeholder="What it does"
                  rows={2}
                  className="mt-1 w-full rounded border border-ink-700 bg-ink-900 px-1.5 py-1 text-[11px] text-ink-200"
                />
              </li>
            ))}
          </ul>

          {editable && (
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" loading={busy} disabled={!dirty} onClick={() => void save()}>
                {dirty ? 'Save subclass' : 'Saved'}
              </Button>
              <span className="text-[10px] text-ink-600">
                Read at every level-up from now on.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
