import { useEffect, useState } from 'react';
import { classInfo } from '@dnd/shared';
import type { LevelGains } from '@dnd/shared';
import { Button } from '../ui.js';
import { api } from '../../lib/api.js';

/**
 * What a level gained you, and the chance to take it.
 *
 * The moment a player is already looking at, so the hit points that used to be
 * the whole of this prompt stay at the top of it. Everything below is offered
 * rather than applied: a feature is written to the sheet when its button is
 * pressed, the rule a stamped monster and a rolled heal both already follow.
 *
 * Ability score increases are announced and never written. Which two points
 * move is the player's decision and the ability block is a few inches up the
 * same page; writing them would be guessing at the one part of levelling up
 * that is actually a choice.
 */
export function LevelUpPanel({
  actorId,
  className,
  level,
  editable,
  onDone,
  onDismiss,
}: {
  actorId: string;
  className: string;
  level: number;
  editable: boolean;
  /** Reload the sheet: hit points and new feature rows both land on it. */
  onDone: () => void;
  onDismiss: () => void;
}) {
  const [gains, setGains] = useState<LevelGains | null>(null);
  const [empty, setEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [taking, setTaking] = useState<string | null>(null);
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [hp, setHp] = useState<'roll' | 'average' | null>(null);
  const [hpResult, setHpResult] = useState<{ gained: number; hpMax: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const info = classInfo(className);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .get<{ gains: LevelGains; compendiumEmpty: boolean }>(`/api/actors/${actorId}/level-gains`)
      .then((res) => {
        if (!live) return;
        setGains(res.gains);
        setEmpty(res.compendiumEmpty);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : 'Could not read the level'))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [actorId, level]);

  async function takeHitPoints(method: 'roll' | 'average') {
    setHp(method);
    setError(null);
    try {
      setHpResult(
        await api.post<{ gained: number; hpMax: number }>(`/api/actors/${actorId}/level-hit-points`, {
          method,
        }),
      );
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add hit points');
    } finally {
      setHp(null);
    }
  }

  async function addFeature(name: string, description: string) {
    setTaking(name);
    setError(null);
    try {
      await api.post(`/api/actors/${actorId}/level-features`, {
        features: [{ name, description }],
      });
      setTaken((current) => new Set(current).add(name));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that feature');
    } finally {
      setTaking(null);
    }
  }

  async function dismiss() {
    try {
      await api.post(`/api/actors/${actorId}/acknowledge-level`, {});
    } finally {
      onDismiss();
    }
  }

  const feature = (
    entry: LevelGains['features'][number],
    kind: 'class' | 'subclass',
  ) => (
    <li key={`${kind}-${entry.name}`} className="rounded border border-ink-800 bg-ink-900/60 p-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold text-ink-100">{entry.name}</span>
        {entry.subclassName && (
          <span className="text-[10px] text-arcane-400">{entry.subclassName}</span>
        )}
        <span className="text-[10px] text-ink-600">level {entry.level}</span>
        {editable && (
          <Button
            size="sm"
            variant={taken.has(entry.name) ? 'ghost' : 'secondary'}
            loading={taking === entry.name}
            disabled={taken.has(entry.name)}
            onClick={() => void addFeature(entry.name, entry.description)}
            className="ml-auto"
            title="Writes this into Features & Traits. Adding it twice is not possible."
          >
            {taken.has(entry.name) ? 'On the sheet' : 'Add to sheet'}
          </Button>
        )}
      </div>

      {entry.description && (
        <p className="mt-1 line-clamp-6 text-[11px] whitespace-pre-line text-ink-400">
          {entry.description}
        </p>
      )}

      {/* A choice, drawn as a choice. The SRD publishes these as siblings of
          the feature they belong to, which reads as eight things rather than
          two and a decision. */}
      {entry.options.length > 0 && (
        <div className="mt-1.5 border-t border-ink-800 pt-1.5">
          <div className="mb-1 text-[10px] tracking-wide text-ink-500 uppercase">
            Choose one of {entry.options.length}
          </div>
          <ul className="space-y-1">
            {entry.options.map((option) => (
              <li key={option.name} className="flex items-baseline gap-2">
                <span className="text-[11px] text-ink-300">{option.name}</span>
                {editable && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={taking === option.name}
                    disabled={taken.has(option.name)}
                    onClick={() => void addFeature(option.name, option.description)}
                    className="ml-auto"
                  >
                    {taken.has(option.name) ? 'Taken' : 'Take'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );

  return (
    <div className="mt-2 rounded-lg border border-ember-500/40 bg-ember-500/5 p-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-sm font-semibold text-ember-300">Level {level}</span>
        <span className="text-[11px] text-ink-500">{className}</span>
        <Button size="sm" variant="ghost" onClick={() => void dismiss()} className="ml-auto">
          {editable ? 'Done' : 'Close'}
        </Button>
      </div>

      {error && <p className="mb-2 text-[11px] text-red-400">{error}</p>}

      {/* Hit points first: it is what this prompt has always been for, and it
          is the one thing that has to happen. */}
      {editable &&
        (hpResult ? (
          <p className="mb-2 text-xs text-emerald-300">
            +{hpResult.gained} hit points. Maximum is now {hpResult.hpMax}.
          </p>
        ) : info ? (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-300">
              Hit points — roll your d{info.hitDie}, or take the average.
            </span>
            <Button size="sm" loading={hp === 'roll'} onClick={() => void takeHitPoints('roll')}>
              Roll 1d{info.hitDie}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              loading={hp === 'average'}
              onClick={() => void takeHitPoints('average')}
            >
              Take {Math.floor(info.hitDie / 2) + 1}
            </Button>
          </div>
        ) : (
          <p className="mb-2 text-xs text-ink-400">
            No hit die is known for &ldquo;{className}&rdquo;, so hit points stay yours to set.
          </p>
        ))}

      {loading ? (
        <p className="text-[11px] text-ink-500">Reading what this level grants…</p>
      ) : empty ? (
        // Told apart deliberately: "nothing is imported" and "this level grants
        // nothing" look identical on screen and mean completely different things.
        <p className="text-[11px] text-ink-400">
          The compendium has no class progression yet — run <code>npm run srd:import</code>.
        </p>
      ) : gains?.unavailable ? (
        <p className="text-[11px] text-ink-400">{gains.unavailable}</p>
      ) : gains ? (
        <div className="space-y-2">
          {/* The things that are not features, said in one line each. */}
          <ul className="space-y-0.5 text-[11px]">
            {gains.abilityScoreIncreases > 0 && (
              <li className="text-ember-300">
                {gains.abilityScoreIncreases === 1
                  ? 'An ability score increase to spend — two points, or one feat.'
                  : `${gains.abilityScoreIncreases} ability score increases to spend.`}{' '}
                <span className="text-ink-500">Set them in Abilities, above.</span>
              </li>
            )}
            {gains.proficiencyBonus && (
              <li className="text-ink-300">
                Proficiency bonus +{gains.proficiencyBonus.from} → +{gains.proficiencyBonus.to}
              </li>
            )}
            {gains.cantrips && (
              <li className="text-ink-300">
                Cantrips known {gains.cantrips.from} → {gains.cantrips.to}
              </li>
            )}
            {gains.spellSlots.map((slot) => (
              <li key={slot.spellLevel} className="text-ink-300">
                Level {slot.spellLevel} spell slots {slot.from} → {slot.to}
              </li>
            ))}
            {gains.counters.map((counter) => (
              <li key={counter.label} className="text-ink-300">
                {counter.label} {counter.from} → {counter.to}
              </li>
            ))}
          </ul>

          {gains.features.length > 0 && <ul className="space-y-1.5">{gains.features.map((f) => feature(f, 'class'))}</ul>}

          {/*
            * The subclass section says something in every case.
            *
            * It used to show whatever the SRD published whenever the sheet
            * named nothing, so a Battle Master was handed Champion's features;
            * naming the subclass then produced an empty section with no
            * explanation. Neither is shown now - an empty section this can
            * explain beats a filled one that is wrong.
            */}
          {/* Silent when the subclass is known and simply grants nothing here:
              a Champion at level 6 gains nothing from their subclass, which is
              ordinary and not worth a line. */}
          {(gains.subclassFeatures.length > 0 || !gains.subclassKnown) && (
            <>
              <div className="text-[10px] tracking-wide text-ink-500 uppercase">
                Subclass{gains.subclassName ? ` — ${gains.subclassName}` : ''}
              </div>

              {gains.subclassFeatures.length > 0 ? (
                <ul className="space-y-1.5">
                  {gains.subclassFeatures.map((f) => feature(f, 'subclass'))}
                </ul>
              ) : !gains.subclassName ? (
                <p className="text-[11px] text-ink-500">
                  No subclass set on this sheet — put it beside your class above to see what it
                  grants.
                </p>
              ) : (
                <p className="text-[11px] text-ink-400">
                  Nothing written down for {gains.subclassName}
                  {gains.publishedSubclassName
                    ? ` — the SRD only publishes ${gains.publishedSubclassName}.`
                    : '.'}{' '}
                  <a href="#subclass-editor" className="text-arcane-400 underline">
                    Write down what it grants
                  </a>{' '}
                  and every level-up after this one fills itself in.
                </p>
              )}
            </>
          )}

          {/* A pointer, and drawn as one. 5e writes its few racial level-ups
              into prose, and reading them for you would be wrong in both
              directions - so this says where to look and applies nothing. */}
          {gains.raceHints.length > 0 && (
            <div className="rounded border border-arcane-500/30 bg-arcane-500/5 p-2">
              {gains.raceHints.map((hint) => (
                <p key={hint.name} className="text-[11px] text-arcane-200">
                  <span className="font-semibold">{hint.name}</span> mentions this level — worth
                  re-reading on your species. Nothing here has applied it.
                </p>
              ))}
            </div>
          )}

          {gains.features.length === 0 &&
            gains.subclassFeatures.length === 0 &&
            gains.subclassKnown &&
            gains.spellSlots.length === 0 &&
            gains.counters.length === 0 &&
            gains.abilityScoreIncreases === 0 &&
            !gains.proficiencyBonus && (
              <p className="text-[11px] text-ink-500">
                No new features at this level — hit points and a little more of everything.
              </p>
            )}
        </div>
      ) : null}
    </div>
  );
}
