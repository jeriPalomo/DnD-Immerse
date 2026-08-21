import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  ABILITY_ROLL,
  ALIGNMENTS,
  BACKGROUNDS,
  CLASS_NAMES,
  OWNERSHIP,
  SPECIES,
  classInfo,
  classSaves,
  hitDicePool,
  type AbilityKey,
  type ItemCategory,
  type ProficiencyLevel,
  type SkillKey,
} from '@dnd/shared';
import { Alert, Badge, Button, Card, Spinner, Suggest } from '../components/ui.js';
import { CompendiumPicker } from '../components/CompendiumPicker.js';
import {
  AbilityScoresBlock,
  DerivedStats,
  SavingThrows,
  SkillList,
} from '../components/sheet/Abilities.js';
import { AttackList, CombatStats, SpellcastingHeader } from '../components/sheet/Combat.js';
import { FeaturePanel, InventoryPanel, SpellPanel } from '../components/sheet/ItemPanels.js';
import { CampaignAssign } from '../components/sheet/CampaignAssign.js';
import { ImportPdf } from '../components/sheet/ImportPdf.js';
import { RestControl } from '../components/sheet/RestControl.js';
import { ShareSheet } from '../components/sheet/ShareSheet.js';
import { useSheet } from '../store/sheet.js';
import { LevelUpPanel } from '../components/sheet/LevelUpPanel.js';
import { SubclassEditor } from '../components/sheet/SubclassEditor.js';
import { api } from '../lib/api.js';

/** Stable anchor from a section title, so the nav and the sections agree. */
function sectionId(title: string): string {
  return `sheet-${title.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`;
}

// Rest is not here: it moved into the hit point card, which is where you look
// when you want it.
const NAV = ['Attacks', 'Spells', 'Inventory', 'Features & Traits', 'Characteristics', 'Backstory'];

export default function CharacterSheet() {
  const { id } = useParams<{ id: string }>();
  const sheet = useSheet();
  const location = useLocation();
  /**
   * Which panel opened the compendium, so it opens showing that panel's shelf.
   * A generic "browse everything" modal on the Attacks panel means scrolling
   * past 310 wondrous items to reach a sword.
   */
  const [picker, setPicker] = useState<{ kind: 'spell' | 'item'; category: ItemCategory | null } | null>(
    null,
  );
  /**
   * Shown after a level is gained, until the player says they have read it.
   *
   * Seeded from the sheet rather than from a click: the DM sets the level from
   * their own screen, so by the time this page opens the level-up has already
   * happened somewhere else. `levelAcknowledged` is what survives that.
   */
  const [dismissed, setDismissed] = useState(false);

  /**
   * Where "back" goes.
   *
   * Whoever linked here says where here was; opening a sheet from the table and
   * being returned to the character list is disorienting. Falls back to the
   * list when the sheet was opened cold, in a new tab or from a bookmark.
   */
  const from = (location.state ?? null) as { path?: string; label?: string } | null;
  const back = { path: from?.path ?? '/characters', label: from?.label ?? 'All characters' };

  useEffect(() => {
    if (id) void sheet.load(id);
    return () => sheet.clear();
    // Reload only when the character changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Never lose an in-flight edit when navigating away or closing the tab.
  useEffect(() => {
    const flush = () => void useSheet.getState().flush();
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      flush();
    };
  }, []);

  if (sheet.loading) return <Spinner />;
  if (sheet.error && !sheet.actor) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Alert>{sheet.error}</Alert>
        <Link to={back.path} className="mt-4 inline-block text-sm text-ember-400 hover:underline">
          &larr; {back.label}
        </Link>
      </div>
    );
  }

  const actor = sheet.actor;
  if (!actor) return null;

  const editable = sheet.access >= OWNERSHIP.owner;
  /**
   * A creature stamped from the bestiary keeps the compendium's numbers.
   *
   * Its name, portrait and notes are still yours - "Grix the goblin" is a
   * reasonable thing to write on a stamped goblin - but the stat block is not,
   * and the server refuses the write as well as this hiding the inputs. Write an
   * NPC by hand to have one whose numbers you own.
   */
  const statsLocked = Boolean(actor?.srdMonsterId);
  const statsEditable = editable && !statsLocked;
  const weapons = sheet.items.filter((i) => i.type === 'weapon');
  const spells = sheet.items.filter((i) => i.type === 'spell');
  const gear = sheet.items.filter((i) => i.type === 'equipment' || i.type === 'consumable');
  const features = sheet.items.filter((i) => i.type === 'feature');

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <Link to={back.path} className="text-sm text-ink-400 hover:text-ink-200">
          &larr; {back.label}
        </Link>
        <span className="text-xs text-ink-500">
          {sheet.saving ? 'Saving…' : editable ? 'Saved' : 'View only'}
        </span>
      </div>

      <Identity
        actor={actor}
        editable={editable}
        onChange={sheet.patch}
        publishedSubclass={sheet.publishedSubclass}
      />

      {/* Characters only. An NPC has a level for its stat block rather than for
          a story, and a stamped goblin sitting at level 1 with nothing
          acknowledged would otherwise be greeted by a level-up panel. */}
      {!dismissed && actor.type === 'character' && actor.level > (actor.levelAcknowledged ?? 0) && (
        <LevelUpPanel
          actorId={actor.id}
          className={actor.className}
          level={actor.level}
          editable={editable}
          onDone={() => void sheet.load(actor.id)}
          onDismiss={() => {
            setDismissed(true);
            void sheet.load(actor.id);
          }}
        />
      )}

      {/* Jumping beats scrolling a sheet this tall; hunting for the spell list
          was the actual complaint. */}
      <nav className="sticky top-0 z-10 -mx-4 mb-2 flex gap-1 overflow-x-auto border-b border-ink-800 bg-ink-950/90 px-4 py-2 backdrop-blur">
        {NAV.map((title) => (
          <a
            key={title}
            href={`#${sectionId(title)}`}
            className="shrink-0 rounded px-2 py-1 text-xs text-ink-400 transition-colors hover:bg-ink-850 hover:text-ink-100"
          >
            {title}
          </a>
        ))}
      </nav>

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        {/* Left rail: the derived numbers */}
        <div className="space-y-4">
          {statsEditable && !actor.abilitiesRolled && (
            <AbilityRoller
              actorId={actor.id}
              onApply={sheet.patch}
              onImported={() => void sheet.load(actor.id)}
            />
          )}

          {statsLocked && (
            <p className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[11px] text-ink-500">
              From the bestiary, so its numbers are the compendium's. Name, portrait
              and notes are yours.
            </p>
          )}

          <AbilityScoresBlock
            actor={actor}
            editable={statsEditable}
            onChange={(key: AbilityKey, value) => sheet.patch({ [key]: value })}
          />
          <SavingThrows
            actor={actor}
            editable={editable}
            onToggle={(ability, proficient) =>
              sheet.patch({
                saveProficiencies: { ...actor.saveProficiencies, [ability]: proficient },
              })
            }
          />
          <SkillList
            actor={actor}
            editable={editable}
            onCycle={(skill: SkillKey, level: ProficiencyLevel) =>
              sheet.patch({
                skillProficiencies: { ...actor.skillProficiencies, [skill]: level },
              })
            }
          />
        </div>

        {/* Right: combat, then the item panels */}
        <div className="space-y-4">
          <DerivedStats actor={actor} />
          <CombatStats
            actor={actor}
            editable={statsEditable}
            onChange={sheet.patch}
            rest={
              <RestControl
                actorId={actor.id}
                hitDiceTotal={actor.hitDiceTotal}
                hitDiceUsed={actor.hitDiceUsed}
                onRested={() => void sheet.load(actor.id)}
              />
            }
          />

          <Section
            title="Attacks"
            action={
              editable && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setPicker({ kind: 'item', category: 'weapon' })}
                >
                  Browse weapons
                </Button>
              )
            }
          >
            <AttackList actor={actor} weapons={weapons} />
          </Section>

          <Section
            title="Spells"
            action={
              editable && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setPicker({ kind: 'spell', category: null })}
                >
                  Browse spells
                </Button>
              )
            }
          >
            <SpellcastingHeader actor={actor} />
            <SpellPanel
              spells={spells}
              editable={editable}
              onTogglePrepared={(itemId, prepared) =>
                void sheet.patchItem(itemId, { system: { prepared } })
              }
              onRemove={(itemId) => void sheet.removeItem(itemId)}
            />
          </Section>

          <Section
            title="Inventory"
            action={
              editable && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setPicker({ kind: 'item', category: null })}
                >
                  Browse equipment
                </Button>
              )
            }
          >
            <InventoryPanel
              items={gear}
              editable={editable}
              strength={actor.str}
              onToggleEquipped={(itemId, equipped) =>
                void sheet.patchItem(itemId, { system: { equipped } })
              }
              onRemove={(itemId) => void sheet.removeItem(itemId)}
            />
          </Section>

          <Section title="Features & Traits">
            <FeaturePanel
              features={features}
              editable={editable}
              onAdd={(name) => void sheet.addItem('feature', name)}
              onRemove={(itemId) => void sheet.removeItem(itemId)}
            />
            {/* Here rather than as a seventh entry in the jump list: it matters
                only to the subclasses the SRD never published, and the nav is
                for everyone. Adjacent to the features it eventually becomes. */}
            {actor.type === 'character' && (
              <SubclassEditor
                actorId={actor.id}
                subclassName={actor.subclass}
                publishedSubclass={sheet.publishedSubclass}
                saved={sheet.subclassFeatures}
                editable={editable}
                onSaved={() => void sheet.load(actor.id)}
              />
            )}
          </Section>

          {editable && (
            <Section title="At the table">
              <CampaignAssign
                actorId={actor.id}
                assigned={sheet.campaigns}
                onChanged={() => void sheet.load(actor.id)}
              />
            </Section>
          )}

          {editable && (
            <Section title="Who can see this">
              <ShareSheet
                actorId={actor.id}
                ownerUserId={actor.ownerUserId}
                campaignIds={sheet.campaigns.map((c) => c.id)}
                grants={sheet.grants}
                onChanged={() => void sheet.load(actor.id)}
              />
            </Section>
          )}

          {/*
            The handbook's four, each its own box.
            "What is your bond" is a question with its own answer, and a single
            blob makes the DM read four paragraphs to find the one they wanted
            to lean on this scene.
          */}
          <Section title="Characteristics">
            <div className="grid gap-3 sm:grid-cols-2">
              <Prose
                label="Personality traits"
                hint="How you carry yourself; what somebody notices first."
                value={actor.personalityTraits}
                editable={editable}
                onChange={(personalityTraits) => sheet.patch({ personalityTraits })}
              />
              <Prose
                label="Ideals"
                hint="What you believe in, and would argue for."
                value={actor.ideals}
                editable={editable}
                onChange={(ideals) => sheet.patch({ ideals })}
              />
              <Prose
                label="Bonds"
                hint="Who or what you would cross the map for."
                value={actor.bonds}
                editable={editable}
                onChange={(bonds) => sheet.patch({ bonds })}
              />
              <Prose
                label="Flaws"
                hint="What a clever enemy would use against you."
                value={actor.flaws}
                editable={editable}
                onChange={(flaws) => sheet.patch({ flaws })}
              />
            </div>

            <div className="mt-3">
              <Prose
                label="Appearance"
                hint="What the table sees. Was in the schema and had nowhere to be typed."
                value={actor.appearance}
                editable={editable}
                rows={3}
                onChange={(appearance) => sheet.patch({ appearance })}
              />
            </div>
          </Section>

          {/*
            Bound to `backstory`, not `notes`.
            `backstory` has been in the schema all along with no way to fill it
            in, while the Notes box - whose placeholder read "Backstory, session
            notes, anything" - was where everybody actually wrote one. Migration
            0020 moves that text across, so renaming the section does not hide
            what somebody already wrote.
          */}
          <Section title="Backstory">
            <Prose
              label=""
              value={actor.backstory}
              editable={editable}
              rows={8}
              placeholder="Where they came from, and why they are here…"
              onChange={(backstory) => sheet.patch({ backstory })}
            />

            <div className="mt-4">
              <Prose
                label="Session notes"
                hint="Anything you want to remember between games."
                value={actor.notes}
                editable={editable}
                rows={4}
                onChange={(notes) => sheet.patch({ notes })}
              />
            </div>
          </Section>
        </div>
      </div>

      {picker && (
        <CompendiumPicker
          kind={picker.kind}
          initialCategory={picker.category}
          // The edition the character actually plays under. A 2024 campaign
          // browsed the 2014 equipment list until this was threaded through.
          ruleset={sheet.campaigns[0]?.ruleset ?? '2014'}
          casterClass={actor.className}
          casterLevel={actor.level}
          onAdd={async (srdId) => sheet.addFromSrd(picker.kind, srdId)}
          onCreate={async (type, name, system) => sheet.addItem(type, name, system)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

/**
 * Rolls a set of ability scores.
 *
 * Over HTTP, not the table socket: this page never connects one, so the socket
 * version silently did nothing. The server still rolls, and still posts to the
 * chat of any campaign the character is in.
 */
function AbilityRoller({
  actorId,
  onApply,
  onImported,
}: {
  actorId: string;
  onApply: (fields: Record<string, unknown>) => void;
  /** Reload the sheet after a PDF has written to it. */
  onImported: () => void;
}) {
  const [rolls, setRolls] = useState<{ ability: AbilityKey; total: number; dice: number[] }[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function roll() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await api.post<{ rolls: { ability: AbilityKey; total: number; dice: number[] }[] }>(
        `/api/actors/${actorId}/roll-abilities`,
      );
      setRolls(res.rolls);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-ink-700 p-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        loading={busy}
        onClick={() => void roll()}
        title={`Rolls ${ABILITY_ROLL} — 4d6, drop the lowest — for each ability`}
        className="w-full"
      >
        Roll Ability Scores
      </Button>

      {failed && <p className="mt-1.5 text-[11px] text-red-400">Could not roll. Try again.</p>}

      {/* Beside the roller because they answer the same question - "where do
          these numbers come from" - and somebody arriving with a sheet already
          filled in wants the other answer. */}
      <div className="mt-2">
        <ImportPdf actorId={actorId} onApplied={onImported} />
      </div>

      {rolls.length > 0 && (
        <>
          <ul className="mt-2 grid grid-cols-3 gap-1">
            {rolls.map(({ ability, total, dice }) => (
              <li
                key={ability}
                title={dice.join(', ')}
                className="rounded border border-ink-700 bg-ink-850 px-1 py-0.5 text-center"
              >
                <div className="text-[9px] tracking-wide text-ink-500 uppercase">{ability}</div>
                <div className="font-display text-sm text-ink-100">{total}</div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => {
              onApply(Object.fromEntries(rolls.map((r) => [r.ability, r.total])));
              setRolls([]);
            }}
            className="mt-1.5 w-full rounded border border-ember-500/50 px-2 py-1 text-[11px] text-ember-300 transition-colors hover:bg-ember-500/15"
          >
            Apply to sheet
          </button>
        </>
      )}
    </div>
  );
}

/**
 * A labelled block of writing.
 *
 * Read-only draws the words rather than a `disabled` textarea, the rule the
 * inventory toggles already follow: a column of dead boxes is what a player
 * meets when they open somebody else's sheet, and "nothing written yet" says
 * more than an empty grey rectangle.
 */
function Prose({
  label,
  hint,
  value,
  editable,
  rows = 3,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  editable: boolean;
  rows?: number;
  placeholder?: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1 block text-[11px] tracking-wide text-ink-400 uppercase">{label}</span>
      )}

      {/* The hint is the placeholder and the tooltip, never a standing line
          above the box. Printed both ways it read as the same sentence twice,
          and a line of grey under every label is the wall of prose the map
          panel was stripped of for the same reason. */}
      {editable ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          title={hint}
          placeholder={placeholder ?? hint}
          className="w-full resize-y rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-200 placeholder:text-ink-500 focus:border-arcane-400 focus:outline-none"
        />
      ) : (
        <p className="rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-2 text-sm whitespace-pre-line text-ink-300">
          {value || <span className="text-ink-600">Nothing written yet.</span>}
        </p>
      )}
    </label>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card id={sectionId(title)} className="scroll-mt-20 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-display text-lg text-ink-100">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

function Identity({
  actor,
  editable,
  onChange,
  publishedSubclass,
}: {
  actor: ReturnType<typeof useSheet.getState>['actor'] & object;
  editable: boolean;
  onChange: (fields: Record<string, unknown>) => void;
  /** What the compendium calls this class's subclass, for the field to suggest. */
  publishedSubclass: string | null;
}) {
  const [uploading, setUploading] = useState(false);

  async function uploadPortrait(file: File) {
    setUploading(true);
    try {
      const res = await api.upload<{ portraitUrl: string }>(
        `/api/actors/${actor.id}/portrait`,
        file,
      );
      onChange({ portraitUrl: res.portraitUrl });
    } finally {
      setUploading(false);
    }
  }

  const field =
    'rounded border border-transparent bg-transparent px-1 py-0.5 text-ink-200 hover:border-ink-700 focus:border-arcane-400 focus:bg-ink-850 focus:outline-none disabled:hover:border-transparent';

  /**
   * A recognised class carries its hit die, casting ability and saving throws
   * with it.
   *
   * None of these are editable anywhere else, so before this they kept the
   * schema defaults forever: every character short-rested on `1d8` whatever
   * their class, `spellcastingAbility` stayed null, which made the spell save
   * DC header return null and never render, and the two saves the class grants
   * had to be found in the handbook and toggled by hand. Typing homebrew still
   * works - an unrecognised class simply leaves all of it alone.
   *
   * Saves are only ever added here, never cleared: a multiclass or a house rule
   * has to be able to keep a proficiency this table does not know about.
   */
  function withClassDefaults(className: string, level: number): Record<string, unknown> {
    const info = classInfo(className);
    if (!info) return {};

    const saves = { ...actor.saveProficiencies };
    for (const ability of classSaves(className)) saves[ability] = true;

    return {
      hitDiceTotal: hitDicePool(className, level),
      saveProficiencies: saves,
      ...(info.casting ? { spellcastingAbility: info.casting } : {}),
    };
  }

  return (
    <Card className="flex flex-wrap items-center gap-4 p-4">
      <label className="group relative size-20 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-ink-700 bg-ink-800">
        {actor.portraitUrl ? (
          <img src={actor.portraitUrl} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center font-display text-2xl text-ink-500">
            {actor.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        {editable && (
          <>
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadPortrait(file);
              }}
            />
            <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-ink-100 opacity-0 transition-opacity group-hover:opacity-100">
              {uploading ? 'Uploading…' : 'Change'}
            </span>
          </>
        )}
      </label>

      <div className="min-w-0 flex-1">
        <input
          disabled={!editable}
          aria-label="Character name"
          value={actor.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className={`w-full font-display text-2xl font-bold ${field}`}
        />
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Suggest
            disabled={!editable}
            options={SPECIES}
            value={actor.race}
            onChange={(e) => onChange({ race: e.target.value })}
            placeholder="Species"
            aria-label="Species"
            className={`w-24 ${field}`}
          />
          <Suggest
            disabled={!editable}
            options={CLASS_NAMES}
            value={actor.className}
            onChange={(e) =>
              onChange({
                className: e.target.value,
                ...withClassDefaults(e.target.value, actor.level),
              })
            }
            placeholder="Class"
            aria-label="Class"
            className={`w-28 ${field}`}
          />
          {/* The column has existed for the life of the project with nothing to
              set it, which is why the level-up panel could not tell a Battle
              Master from a Champion. The suggestion comes from the compendium
              rather than a list here, because the editions spell it
              differently - 2014 says "Berserker" where 2024 says "Path of the
              Berserker". */}
          <Suggest
            disabled={!editable}
            options={publishedSubclass ? [publishedSubclass] : []}
            value={actor.subclass}
            onChange={(e) => onChange({ subclass: e.target.value })}
            placeholder="Subclass"
            aria-label="Subclass"
            title="Your archetype, domain, circle or oath. Anything may be typed; only the one the SRD publishes is suggested."
            className={`w-32 ${field}`}
          />
          {/* Labelled: an unlabelled number box between class and background
              reads as a mystery, and it is the one number people look for. */}
          <span className="flex items-center gap-1 text-ink-500">
            Level
            <input
              type="number"
              min={1}
              max={20}
              aria-label="Level"
              disabled={!editable}
              value={actor.level}
              onChange={(e) => {
                const level = Math.max(1, Math.min(20, Number(e.target.value) || 1));
                // The pool is level-many dice, so it has to follow the level.
                onChange({ level, ...withClassDefaults(actor.className, level) });
              }}
              className={`w-12 ${field}`}
            />
          </span>
          {/*
            * A tally, not a gauge.
            *
            * What this character has earned *since the last level*, reset when
            * the DM levels the party. There is no bar because there is nothing
            * to fill: levels are declared by story here, so no amount of this
            * causes one, and drawing a threshold would promise a rule the
            * table does not play by.
            *
            * This replaces a "Level up to N" button that read the DMG
            * thresholds and could never appear - nothing had ever written
            * `experience`, so its own condition was never true. Left in place
            * it would have come alive the moment fights started paying out,
            * and begun offering XP-driven level-ups against the whole point.
            */}
          <span className="flex items-center gap-1 text-ink-500" title="Earned since the last level. Reset when the party levels. Levels are declared, never earned.">
            EXP
            <input
              type="number"
              min={0}
              aria-label="Experience this level"
              disabled={!editable}
              value={actor.experience}
              onChange={(e) => onChange({ experience: Math.max(0, Number(e.target.value) || 0) })}
              className={`w-20 ${field}`}
            />
          </span>
          <Suggest
            disabled={!editable}
            options={BACKGROUNDS}
            value={actor.background}
            onChange={(e) => onChange({ background: e.target.value })}
            placeholder="Background"
            aria-label="Background"
            className={`w-32 ${field}`}
          />
          {/* Alignment is on the actor and was never editable, so it stayed
              blank on every sheet in the database. */}
          <Suggest
            disabled={!editable}
            options={ALIGNMENTS}
            value={actor.alignment}
            onChange={(e) => onChange({ alignment: e.target.value })}
            placeholder="Alignment"
            aria-label="Alignment"
            className={`w-32 ${field}`}
          />
        </div>
      </div>

      {actor.type === 'npc' && <Badge>NPC</Badge>}
    </Card>
  );
}
