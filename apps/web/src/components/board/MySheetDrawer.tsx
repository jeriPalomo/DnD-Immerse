import { useEffect } from 'react';
import { OWNERSHIP, type AbilityKey, type ProficiencyLevel, type SkillKey } from '@dnd/shared';
import { AbilityScoresBlock, DerivedStats, SavingThrows, SkillList } from '../sheet/Abilities.js';
import { AttackList, CombatStats, DamageModifierPanel, SpellcastingHeader } from '../sheet/Combat.js';
import { FeaturePanel, InventoryPanel, SpellPanel } from '../sheet/ItemPanels.js';
import { RestControl } from '../sheet/RestControl.js';
import { useSheet } from '../../store/sheet.js';
import { Spinner } from '../ui.js';

/**
 * Your own sheet, at the table, and yours to write on.
 *
 * Checking what a spell does used to mean leaving the board: the target panel
 * only offers items while you are aiming at something, and the sheet itself is
 * a different page - which during someone else's turn costs you the map, the
 * chat and your scroll position.
 *
 * It was read-only, on the grounds that a drawer which can change hit points is
 * one that can lose an edit when a damage roll arrives over the top of it. That
 * was the wrong trade: marking a spell prepared, spending a hit die and ticking
 * off a torch are all things you do *during* a session, and sending a player to
 * another page for them costs exactly what this drawer was built to save. The
 * hazard is answered instead by going through `useSheet`, the same debounced
 * store the sheet page uses - so an edit here and an edit there cannot disagree,
 * and the drawer reloads from the server each time it opens rather than reading
 * a snapshot taken when the table did.
 *
 * Every panel is the one the sheet page already uses. Two renderings of one
 * spell list is how a table ends up with two descriptions of one spell.
 */
export function MySheetDrawer({ actorId, onClose }: { actorId: string; onClose: () => void }) {
  const sheet = useSheet();

  // Loaded fresh on open. The table holds a copy of the actor taken when the
  // page mounted, and by mid-session that copy is behind - the DM's damage, a
  // level, an item picked up an hour ago.
  useEffect(() => {
    void sheet.load(actorId);
    return () => {
      // Anything typed in the last 600ms is still sitting in the debounce.
      void useSheet.getState().flush();
      useSheet.getState().clear();
    };
    // Reload only when the character changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId]);

  const actor = sheet.actor;
  const editable = sheet.access >= OWNERSHIP.owner;

  const weapons = sheet.items.filter((i) => i.type === 'weapon');
  const spells = sheet.items.filter((i) => i.type === 'spell');
  const gear = sheet.items.filter((i) => i.type === 'equipment' || i.type === 'consumable');
  const features = sheet.items.filter((i) => i.type === 'feature');

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-ink-800 p-4">
          <div className="size-10 shrink-0 overflow-hidden rounded-lg border border-ink-700 bg-ink-800">
            {actor?.portraitUrl ? (
              <img src={actor.portraitUrl} alt="" className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center text-sm text-ink-500">
                {(actor?.name ?? '?').slice(0, 1).toUpperCase()}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-lg text-ink-100">{actor?.name ?? 'Sheet'}</h2>
            <p className="truncate text-xs text-ink-500">
              {[actor?.race, actor?.className, actor?.level ? `level ${actor.level}` : '']
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          {/* The same indicator the sheet page carries. An edit that is saving
              and an edit that failed look identical without it. */}
          <span className="shrink-0 text-[11px] text-ink-500">
            {sheet.saving ? 'Saving…' : editable ? 'Saved' : 'View only'}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded px-2 py-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          {!actor ? (
            <Spinner />
          ) : (
            <>
              {sheet.error && <p className="text-xs text-red-400">{sheet.error}</p>}

              <CombatStats
                actor={actor}
                editable={editable}
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

              <DerivedStats actor={actor} />

              <DamageModifierPanel actor={actor} editable={editable} onChange={sheet.patch} />

              <AbilityScoresBlock
                actor={actor}
                editable={editable}
                ruleset={sheet.ruleset}
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

              <Block title="Attacks">
                <AttackList actor={actor} weapons={weapons} />
              </Block>

              {actor.spellcastingAbility && (
                <Block title="Spells">
                  <SpellcastingHeader actor={actor} editable={editable} onChange={sheet.patch} />
                  <SpellPanel
                    spells={spells}
                    editable={editable}
                    onTogglePrepared={(itemId, prepared) =>
                      void sheet.patchItem(itemId, { system: { prepared } })
                    }
                    onRemove={(itemId) => void sheet.removeItem(itemId)}
                  />
                </Block>
              )}

              <Block title="Inventory">
                <InventoryPanel
                  items={gear}
                  editable={editable}
                  strength={actor.str}
                  onToggleEquipped={(itemId, equipped) =>
                    void sheet.patchItem(itemId, { system: { equipped } })
                  }
                  onRemove={(itemId) => void sheet.removeItem(itemId)}
                />
              </Block>

              <Block title="Features & Traits">
                <FeaturePanel
                  features={features}
                  editable={editable}
                  onAdd={(name) => void sheet.addItem('feature', name)}
                  onRemove={(itemId) => void sheet.removeItem(itemId)}
                />
              </Block>

              {/* Adding a spell or a weapon means browsing the compendium, and
                  that is a modal on top of a drawer on top of the board - two
                  layers too many mid-session. The full page is one click away
                  and is where a shopping trip belongs. */}
              <p className="border-t border-ink-800 pt-3 text-[11px] text-ink-600">
                Rolling up, browsing the compendium and your backstory live on the full
                sheet, under Characters.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] tracking-wider text-ink-500 uppercase">{title}</h3>
      {children}
    </section>
  );
}
