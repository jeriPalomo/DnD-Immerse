import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ABILITIES,
  ABILITY_ROLL,
  OWNERSHIP,
  levelFromXP,
  type AbilityKey,
  type ProficiencyLevel,
  type SkillKey,
} from '@dnd/shared';
import { Alert, Badge, Button, Card, Spinner } from '../components/ui.js';
import { CompendiumPicker } from '../components/CompendiumPicker.js';
import {
  AbilityScoresBlock,
  DerivedStats,
  SavingThrows,
  SkillList,
} from '../components/sheet/Abilities.js';
import { AttackList, CombatStats, SpellcastingHeader } from '../components/sheet/Combat.js';
import { FeaturePanel, InventoryPanel, SpellPanel } from '../components/sheet/ItemPanels.js';
import { ShareSheet } from '../components/sheet/ShareSheet.js';
import { useSheet } from '../store/sheet.js';
import { useTable } from '../store/table.js';
import { api } from '../lib/api.js';

export default function CharacterSheet() {
  const { id } = useParams<{ id: string }>();
  const sheet = useSheet();
  const [picker, setPicker] = useState<'spell' | 'item' | null>(null);

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
        <Link to="/characters" className="mt-4 inline-block text-sm text-ember-400 hover:underline">
          Back to characters
        </Link>
      </div>
    );
  }

  const actor = sheet.actor;
  if (!actor) return null;

  const editable = sheet.access >= OWNERSHIP.owner;
  const weapons = sheet.items.filter((i) => i.type === 'weapon');
  const spells = sheet.items.filter((i) => i.type === 'spell');
  const gear = sheet.items.filter((i) => i.type === 'equipment' || i.type === 'consumable');
  const features = sheet.items.filter((i) => i.type === 'feature');

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <Link to="/characters" className="text-sm text-ink-400 hover:text-ink-200">
          &larr; All characters
        </Link>
        <span className="text-xs text-ink-500">
          {sheet.saving ? 'Saving…' : editable ? 'Saved' : 'View only'}
        </span>
      </div>

      <Identity actor={actor} editable={editable} onChange={sheet.patch} />

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        {/* Left rail: the derived numbers */}
        <div className="space-y-4">
          {editable && (
            <button
              onClick={() => {
                // Rolled in chat rather than locally, so the table can see the
                // stats were genuinely rolled and not chosen.
                for (const ability of ABILITIES) {
                  useTable.getState().roll(ABILITY_ROLL, `${actor.name} — ${ability.toUpperCase()}`);
                }
              }}
              className="w-full rounded-lg border border-ink-700 px-2 py-1.5 text-xs text-ink-400 transition-colors hover:border-ember-500 hover:text-ember-300"
              title="Rolls 4d6 drop lowest for each ability, in the table chat"
            >
              Roll ability scores ({ABILITY_ROLL})
            </button>
          )}

          <AbilityScoresBlock
            actor={actor}
            editable={editable}
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
          <CombatStats actor={actor} editable={editable} onChange={sheet.patch} />

          <Section
            title="Attacks"
            action={
              editable && (
                <Button size="sm" variant="secondary" onClick={() => setPicker('item')}>
                  Add weapon
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
                <Button size="sm" variant="secondary" onClick={() => setPicker('spell')}>
                  Add spell
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
                <Button size="sm" variant="secondary" onClick={() => setPicker('item')}>
                  Add item
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
          </Section>

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

          <Section title="Notes">
            <textarea
              disabled={!editable}
              value={actor.notes}
              onChange={(e) => sheet.patch({ notes: e.target.value })}
              rows={6}
              placeholder="Backstory, session notes, anything you want to remember…"
              className="w-full resize-y rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-200 placeholder:text-ink-500 focus:border-arcane-400 focus:outline-none disabled:opacity-70"
            />
          </Section>
        </div>
      </div>

      {picker && (
        <CompendiumPicker
          kind={picker}
          onAdd={async (srdId) => sheet.addFromSrd(picker, srdId)}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
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
    <Card className="p-4">
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
}: {
  actor: ReturnType<typeof useSheet.getState>['actor'] & object;
  editable: boolean;
  onChange: (fields: Record<string, unknown>) => void;
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
          <input
            disabled={!editable}
            value={actor.race}
            onChange={(e) => onChange({ race: e.target.value })}
            placeholder="Race"
            className={`w-24 ${field}`}
          />
          <input
            disabled={!editable}
            value={actor.className}
            onChange={(e) => onChange({ className: e.target.value })}
            placeholder="Class"
            className={`w-28 ${field}`}
          />
          <input
            type="number"
            min={1}
            max={20}
            aria-label="Level"
            disabled={!editable}
            value={actor.level}
            onChange={(e) => onChange({ level: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
            className={`w-14 ${field}`}
          />
          {/* Experience is already tracked, so say when it has earned a level
              rather than leaving the player to check the table. */}
          {actor.experience > 0 && levelFromXP(actor.experience) > actor.level && (
            <button
              type="button"
              disabled={!editable}
              onClick={() => onChange({ level: levelFromXP(actor.experience) })}
              className="rounded border border-ember-500/50 bg-ember-500/10 px-1.5 py-0.5 text-[10px] text-ember-300"
            >
              Level up to {levelFromXP(actor.experience)}
            </button>
          )}
          <input
            disabled={!editable}
            value={actor.background}
            onChange={(e) => onChange({ background: e.target.value })}
            placeholder="Background"
            className={`w-32 ${field}`}
          />
        </div>
      </div>

      {actor.type === 'npc' && <Badge>NPC</Badge>}
    </Card>
  );
}
