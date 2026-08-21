import { useRef, useState } from 'react';
import { Button } from '../ui.js';
import { api } from '../../lib/api.js';

/** What the server made of the file, before anything is written. */
interface Found {
  values: Record<string, string | number>;
  unread: string[];
  fieldCount: number;
  read: number;
}

/** Field names as a person would say them, for the confirmation table. */
const LABELS: Record<string, string> = {
  name: 'Name',
  className: 'Class',
  level: 'Level',
  race: 'Race',
  background: 'Background',
  alignment: 'Alignment',
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
  armorClass: 'Armour class',
  speed: 'Speed',
  hpMax: 'Hit points (max)',
  hpCurrent: 'Hit points (current)',
  hitDiceTotal: 'Hit dice',
  personalityTraits: 'Personality traits',
  ideals: 'Ideals',
  bonds: 'Bonds',
  flaws: 'Flaws',
  backstory: 'Backstory',
  appearance: 'Appearance',
  otherProficiencies: 'Proficiencies & languages',
};

/**
 * Fills a sheet in from a filled-in PDF.
 *
 * Two steps on purpose. The file is read and *shown*, and only writes when the
 * player presses Apply - the same rule the ability roller follows, where seeing
 * the numbers before keeping them is the whole point. A one-step import would
 * be one bad parse away from overwriting a character somebody spent an evening
 * on, and the fields it gets wrong are the ones nobody thinks to check.
 */
export function ImportPdf({
  actorId,
  onApplied,
}: {
  actorId: string;
  onApplied: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function read(file: File) {
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      setFound(await api.upload<Found>(`/api/actors/${actorId}/import-pdf`, file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!found) return;
    setBusy(true);
    try {
      // An ordinary PATCH, so it goes through the same schema and the same
      // rules as any other edit rather than a private path of its own.
      await api.patch(`/api/actors/${actorId}`, found.values);
      setFound(null);
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply those values');
    } finally {
      setBusy(false);
    }
  }

  const entries = found ? Object.entries(found.values) : [];

  return (
    <div>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void read(file);
          e.target.value = '';
        }}
      />

      <Button
        size="sm"
        variant="ghost"
        loading={busy}
        onClick={() => input.current?.click()}
        title="Reads a filled-in fillable character sheet. Nothing is written until you confirm."
        className="w-full"
      >
        Import from PDF
      </Button>

      {error && <p className="mt-1.5 text-[11px] text-red-400">{error}</p>}

      {found && (
        <div className="mt-2 rounded-lg border border-ink-700 bg-ink-900 p-2">
          {entries.length === 0 ? (
            <p className="text-[11px] text-ink-400">
              Nothing recognised in that sheet, out of {found.fieldCount} fields.
            </p>
          ) : (
            <>
              <div className="mb-1.5 text-[10px] tracking-wide text-ink-500 uppercase">
                Found {entries.length} of {found.fieldCount} fields
              </div>

              <ul className="max-h-64 space-y-0.5 overflow-y-auto">
                {entries.map(([key, value]) => (
                  <li key={key} className="flex items-baseline justify-between gap-3 text-[11px]">
                    <span className="shrink-0 text-ink-500">{LABELS[key] ?? key}</span>
                    <span className="truncate text-right text-ink-200">{String(value)}</span>
                  </li>
                ))}
              </ul>

              {/* Named rather than dropped. An import that quietly ignores half
                  a sheet teaches you to trust it about the other half - and
                  weapons and spells genuinely are not read yet. */}
              {found.unread.length > 0 && (
                <p className="mt-2 border-t border-ink-800 pt-1.5 text-[10px] text-ink-600">
                  {found.unread.length} field{found.unread.length === 1 ? '' : 's'} not read,
                  including weapons and spells — add those from the compendium.
                </p>
              )}

              <div className="mt-2 flex gap-1.5">
                <Button size="sm" loading={busy} onClick={() => void apply()} className="flex-1">
                  Apply to sheet
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setFound(null)}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
