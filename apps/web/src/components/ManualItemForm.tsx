import { useState } from 'react';
import {
  CONDITIONS,
  DAMAGE_TYPES,
  SPELL_SCHOOLS,
  WEAPON_PROPERTIES,
  type AppliedCondition,
  type ItemCategory,
  type ItemType,
} from '@dnd/shared';
import { Button, Input } from './ui.js';

/**
 * Hand-entry for things the compendium does not have.
 *
 * The fields are the ones the rest of the app actually reads, not a generic
 * name-and-description box: a weapon needs `damageDice`, `ability`, `proficient`
 * and `range` or the attack table shows a blank to-hit and the target panel
 * refuses it as out of reach. An item you cannot swing is decorative, which is
 * the failure this form exists to avoid.
 *
 * Everything below maps onto the same Zod `system` schemas in
 * `packages/shared/src/documents.ts` that the SRD importer fills, so a
 * hand-made longsword and an imported one are the same kind of row. Fields left
 * alone fall back to those schemas' defaults on the server.
 */
export function ManualItemForm({
  kind,
  initialCategory,
  onCreate,
  onCancel,
}: {
  kind: 'spell' | 'item';
  initialCategory?: ItemCategory | null;
  onCreate: (type: ItemType, name: string, system: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [type, setType] = useState<ItemType>(
    kind === 'spell' ? 'spell' : initialCategory === 'weapon' ? 'weapon' : 'equipment',
  );
  const [name, setName] = useState('');
  const [system, setSystem] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(key: string, value: unknown) {
    setSystem((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;

    setSaving(true);
    setError(null);
    try {
      await onCreate(type, name.trim(), system);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that');
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="flex gap-2">
          <Field label="Name" className="flex-1">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Longsword +1" />
          </Field>
          {kind === 'item' && (
            <Field label="Kind">
              <Select
                value={type}
                onChange={(v) => {
                  // The system blob is type-specific; keeping it across a switch
                  // would send weapon fields to an equipment schema.
                  setSystem({});
                  setType(v as ItemType);
                }}
              >
                <option value="weapon">Weapon</option>
                <option value="equipment">Armour / gear</option>
                <option value="consumable">Potion / scroll</option>
                <option value="feature">Feature</option>
              </Select>
            </Field>
          )}
        </div>

        {type === 'weapon' && <WeaponFields system={system} set={set} />}
        {type === 'spell' && <SpellFields system={system} set={set} />}
        {type === 'equipment' && <EquipmentFields system={system} set={set} />}
        {type === 'consumable' && <ConsumableFields system={system} set={set} />}
        {type === 'feature' && <FeatureFields system={system} set={set} />}

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      <div className="flex items-center gap-2 border-t border-ink-800 px-4 py-3">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Back to the list
        </Button>
        <Button type="submit" size="sm" loading={saving} disabled={!name.trim()} className="ml-auto">
          Add to sheet
        </Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------- per type */

type Setter = (key: string, value: unknown) => void;
type Blob = Record<string, unknown>;

/**
 * What this inflicts when it lands.
 *
 * The curated `SPELL_CONDITIONS` table covers the SRD spells by name, so this is
 * for everything it cannot know: homebrew, a magic weapon, a net. Without it a
 * hand-made item can roll damage and nothing else, which is the same "decorative
 * item" failure the rest of this form exists to avoid.
 *
 * One condition rather than a list. The schema accepts up to six; an item that
 * inflicts two is rare enough to be worth editing by hand, and a repeater here
 * would be more form than anyone fills in.
 */
function ConditionField({ system, set }: { system: Blob; set: Setter }) {
  const applied = ((system.appliesConditions as AppliedCondition[]) ?? [])[0] ?? null;

  function update(patch: Partial<AppliedCondition>) {
    const next: AppliedCondition = {
      condition: applied?.condition ?? '',
      rounds: applied?.rounds ?? null,
      save: applied?.save ?? null,
      ...patch,
    };
    // Clearing the condition clears the whole entry - a duration with nothing to
    // count down is not a state worth storing.
    set('appliesConditions', next.condition ? [next] : []);
  }

  return (
    <Row>
      <Field label="Inflicts" hint="On a failed save">
        <Select value={applied?.condition ?? ''} onChange={(v) => update({ condition: v })}>
          <option value="">— nothing —</option>
          {CONDITIONS.map((condition) => (
            <option key={condition} value={condition}>
              {condition}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Save" hint="Needed for the card to roll it">
        <Select
          value={applied?.save ?? ''}
          onChange={(v) => update({ save: (v || null) as AppliedCondition['save'] })}
        >
          {/* No save means no button to press, so the DM would have to apply it
              by hand -- which is what leaving the condition blank already does. */}
          <option value="">— none, applied by hand —</option>
          <option value="str">Strength</option>
          <option value="dex">Dexterity</option>
          <option value="con">Constitution</option>
          <option value="int">Intelligence</option>
          <option value="wis">Wisdom</option>
          <option value="cha">Charisma</option>
        </Select>
      </Field>
      <Field label="Rounds" hint="Blank lasts until removed">
        <Input
          type="number"
          min={1}
          value={applied?.rounds === null || applied?.rounds === undefined ? '' : String(applied.rounds)}
          onChange={(e) => update({ rounds: e.target.value ? Number(e.target.value) : null })}
          placeholder="—"
        />
      </Field>
    </Row>
  );
}

function WeaponFields({ system, set }: { system: Blob; set: Setter }) {
  const range = (system.range as { type?: string; value?: number; long?: number | null }) ?? {};
  const ranged = range.type === 'ranged';
  const properties = (system.properties as string[]) ?? [];

  return (
    <>
      <Row>
        <Field label="Damage dice" hint="e.g. 1d8">
          <Input
            value={(system.damageDice as string) ?? ''}
            onChange={(e) => set('damageDice', e.target.value)}
            placeholder="1d8"
          />
        </Field>
        <Field label="Damage bonus">
          <Input
            type="number"
            value={String((system.damageBonus as number) ?? 0)}
            onChange={(e) => set('damageBonus', Number(e.target.value))}
          />
        </Field>
        <Field label="Damage type">
          <Select value={(system.damageType as string) ?? 'slashing'} onChange={(v) => set('damageType', v)}>
            {DAMAGE_TYPES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
      </Row>

      <Row>
        <Field label="Ability">
          <Select value={(system.ability as string) ?? 'str'} onChange={(v) => set('ability', v)}>
            <option value="str">Strength</option>
            <option value="dex">Dexterity</option>
          </Select>
        </Field>
        <Field label="Attack bonus" hint="Magic weapons: +1, +2, +3">
          <Input
            type="number"
            value={String((system.attackBonus as number) ?? 0)}
            onChange={(e) => set('attackBonus', Number(e.target.value))}
          />
        </Field>
        <Field label="Weight (lb)">
          <Input
            type="number"
            step="0.1"
            value={String((system.weight as number) ?? 0)}
            onChange={(e) => set('weight', Number(e.target.value))}
          />
        </Field>
      </Row>

      <Row>
        <Field label="Reach">
          <Select
            value={range.type ?? 'touch'}
            onChange={(v) =>
              set('range', v === 'ranged' ? { type: 'ranged', value: 30, long: 120 } : { type: 'touch', value: 5, long: null })
            }
          >
            <option value="touch">Melee (5 ft)</option>
            <option value="ranged">Ranged</option>
          </Select>
        </Field>
        {ranged && (
          <>
            <Field label="Normal range (ft)">
              <Input
                type="number"
                value={String(range.value ?? 30)}
                onChange={(e) => set('range', { ...range, type: 'ranged', value: Number(e.target.value) })}
              />
            </Field>
            <Field label="Long range (ft)">
              <Input
                type="number"
                value={String(range.long ?? 0)}
                onChange={(e) => set('range', { ...range, type: 'ranged', long: Number(e.target.value) })}
              />
            </Field>
          </>
        )}
      </Row>

      <Check
        label="Proficient"
        hint="Adds your proficiency bonus to the attack"
        checked={(system.proficient as boolean) ?? true}
        onChange={(v) => set('proficient', v)}
      />

      <Field label="Properties">
        <div className="flex flex-wrap gap-1.5">
          {WEAPON_PROPERTIES.map((property) => {
            const on = properties.includes(property);
            return (
              <button
                key={property}
                type="button"
                onClick={() => {
                  const next = on ? properties.filter((p) => p !== property) : [...properties, property];
                  set('properties', next);
                  // Finesse and two-handed are read as flags elsewhere, so keep
                  // them in step with the tag rather than storing them twice.
                  if (property === 'finesse') set('finesse', !on);
                  if (property === 'two-handed') set('twoHanded', !on);
                  if (property === 'thrown') set('thrown', !on);
                  if (property === 'versatile') set('versatile', !on);
                }}
                className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                  on
                    ? 'border-arcane-400 bg-arcane-500/20 text-arcane-200'
                    : 'border-ink-700 text-ink-400 hover:border-ink-500'
                }`}
              >
                {property}
              </button>
            );
          })}
        </div>
      </Field>

      {properties.includes('versatile') && (
        <Field label="Versatile dice" hint="Two-handed damage, e.g. 1d10">
          <Input
            value={(system.versatileDice as string) ?? ''}
            onChange={(e) => set('versatileDice', e.target.value)}
            placeholder="1d10"
          />
        </Field>
      )}

      <ConditionField system={system} set={set} />

      <Description system={system} set={set} />
    </>
  );
}

function SpellFields({ system, set }: { system: Blob; set: Setter }) {
  const save = (system.save as { ability?: string; halfOnSuccess?: boolean } | null) ?? null;

  return (
    <>
      <Row>
        <Field label="Level">
          <Select value={String((system.level as number) ?? 0)} onChange={(v) => set('level', Number(v))}>
            <option value="0">Cantrip</option>
            {Array.from({ length: 9 }, (_, i) => i + 1).map((l) => (
              <option key={l} value={l}>
                Level {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="School">
          <Select value={(system.school as string) ?? ''} onChange={(v) => set('school', v)}>
            <option value="">—</option>
            {SPELL_SCHOOLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Casting time">
          <Input
            value={(system.castingTime as string) ?? ''}
            onChange={(e) => set('castingTime', e.target.value)}
            placeholder="1 action"
          />
        </Field>
      </Row>

      <Row>
        <Field label="Range" hint="Feet; 0 for self or touch">
          <Input
            type="number"
            value={String(((system.range as { value?: number }) ?? {}).value ?? 0)}
            onChange={(e) => {
              const value = Number(e.target.value);
              set('range', { type: value > 0 ? 'ranged' : 'self', value, long: null });
              set('rangeText', value > 0 ? `${value} feet` : 'Self');
            }}
          />
        </Field>
        <Field label="Duration">
          <Input
            value={(system.duration as string) ?? ''}
            onChange={(e) => set('duration', e.target.value)}
            placeholder="Instantaneous"
          />
        </Field>
        <Field label="Damage dice" hint="Blank if it deals none">
          <Input
            value={(system.damageDice as string) ?? ''}
            onChange={(e) => set('damageDice', e.target.value)}
            placeholder="8d6"
          />
        </Field>
      </Row>

      <Row>
        <Field label="Damage type">
          <Select value={(system.damageType as string) ?? ''} onChange={(v) => set('damageType', v)}>
            <option value="">—</option>
            {DAMAGE_TYPES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Saving throw" hint="Sets the DC from your spellcasting ability">
          <Select
            value={save?.ability ?? ''}
            onChange={(v) => set('save', v ? { ability: v, halfOnSuccess: save?.halfOnSuccess ?? false } : null)}
          >
            <option value="">No save</option>
            {['str', 'dex', 'con', 'int', 'wis', 'cha'].map((a) => (
              <option key={a} value={a}>
                {a.toUpperCase()}
              </option>
            ))}
          </Select>
        </Field>
      </Row>

      {save && (
        <Check
          label="Half damage on a success"
          checked={Boolean(save.halfOnSuccess)}
          onChange={(v) => set('save', { ability: save.ability, halfOnSuccess: v })}
        />
      )}

      <ConditionField system={system} set={set} />

      <Check
        label="Attack roll"
        hint="Ray and touch spells that roll to hit rather than forcing a save"
        checked={(system.attackRoll as boolean) ?? false}
        onChange={(v) => set('attackRoll', v)}
      />
      <Check
        label="Concentration"
        checked={(system.concentration as boolean) ?? false}
        onChange={(v) => set('concentration', v)}
      />
      <Check label="Ritual" checked={(system.ritual as boolean) ?? false} onChange={(v) => set('ritual', v)} />

      <Description system={system} set={set} />
    </>
  );
}

function EquipmentFields({ system, set }: { system: Blob; set: Setter }) {
  const armorType = (system.armorType as string) ?? 'none';

  return (
    <>
      <Row>
        <Field label="Armour type">
          <Select
            value={armorType}
            onChange={(v) => {
              set('armorType', v);
              // Medium armour caps DEX at +2, heavy allows none. Filling it here
              // means the AC on the sheet is right without a second form.
              set('dexCap', v === 'medium' ? 2 : v === 'heavy' ? 0 : null);
            }}
          >
            <option value="none">Not armour</option>
            <option value="light">Light</option>
            <option value="medium">Medium</option>
            <option value="heavy">Heavy</option>
            <option value="shield">Shield</option>
          </Select>
        </Field>
        {armorType !== 'none' && (
          <Field label="Base AC" hint="Shields: the bonus, e.g. 2">
            <Input
              type="number"
              value={String((system.baseAC as number) ?? 0)}
              onChange={(e) => set('baseAC', Number(e.target.value))}
            />
          </Field>
        )}
        <Field label="Weight (lb)">
          <Input
            type="number"
            step="0.1"
            value={String((system.weight as number) ?? 0)}
            onChange={(e) => set('weight', Number(e.target.value))}
          />
        </Field>
      </Row>

      {armorType !== 'none' && armorType !== 'shield' && (
        <Check
          label="Stealth disadvantage"
          checked={(system.stealthDisadvantage as boolean) ?? false}
          onChange={(v) => set('stealthDisadvantage', v)}
        />
      )}

      <Row>
        <Field label="Quantity">
          <Input
            type="number"
            value={String((system.quantity as number) ?? 1)}
            onChange={(e) => set('quantity', Number(e.target.value))}
          />
        </Field>
        <Field label="Price">
          <Input
            value={(system.price as string) ?? ''}
            onChange={(e) => set('price', e.target.value)}
            placeholder="50 gp"
          />
        </Field>
      </Row>

      <Description system={system} set={set} />
    </>
  );
}

function ConsumableFields({ system, set }: { system: Blob; set: Setter }) {
  const uses = (system.uses as { value?: number; max?: number; per?: string } | null) ?? null;

  return (
    <>
      <Row>
        <Field label="Sort">
          <Select value={(system.consumableType as string) ?? 'other'} onChange={(v) => set('consumableType', v)}>
            <option value="potion">Potion</option>
            <option value="scroll">Scroll</option>
            <option value="ammunition">Ammunition</option>
            <option value="food">Food</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Quantity">
          <Input
            type="number"
            value={String((system.quantity as number) ?? 1)}
            onChange={(e) => set('quantity', Number(e.target.value))}
          />
        </Field>
        <Field label="Weight (lb)">
          <Input
            type="number"
            step="0.1"
            value={String((system.weight as number) ?? 0)}
            onChange={(e) => set('weight', Number(e.target.value))}
          />
        </Field>
      </Row>

      <Row>
        <Field label="Charges" hint="0 for none">
          <Input
            type="number"
            value={String(uses?.max ?? 0)}
            onChange={(e) => {
              const max = Number(e.target.value);
              set('uses', max > 0 ? { value: max, max, per: uses?.per ?? 'charges' } : null);
            }}
          />
        </Field>
        {uses && (
          <Field label="Recharges">
            <Select value={uses.per ?? 'charges'} onChange={(v) => set('uses', { ...uses, per: v })}>
              <option value="charges">Never (charges)</option>
              <option value="short">Short rest</option>
              <option value="long">Long rest</option>
              <option value="day">Dawn</option>
            </Select>
          </Field>
        )}
      </Row>

      <Description system={system} set={set} />
    </>
  );
}

function FeatureFields({ system, set }: { system: Blob; set: Setter }) {
  const uses = (system.uses as { value?: number; max?: number; per?: string } | null) ?? null;

  return (
    <>
      <Row>
        <Field label="Source" hint="Class, race or background">
          <Input
            value={(system.source as string) ?? ''}
            onChange={(e) => set('source', e.target.value)}
            placeholder="Fighter 3"
          />
        </Field>
        <Field label="Uses" hint="0 for at-will">
          <Input
            type="number"
            value={String(uses?.max ?? 0)}
            onChange={(e) => {
              const max = Number(e.target.value);
              set('uses', max > 0 ? { value: max, max, per: uses?.per ?? 'long' } : null);
            }}
          />
        </Field>
        {uses && (
          <Field label="Per">
            <Select value={uses.per ?? 'long'} onChange={(v) => set('uses', { ...uses, per: v })}>
              <option value="short">Short rest</option>
              <option value="long">Long rest</option>
              <option value="day">Day</option>
              <option value="encounter">Encounter</option>
              <option value="turn">Turn</option>
            </Select>
          </Field>
        )}
      </Row>

      <Description system={system} set={set} />
    </>
  );
}

/* ------------------------------------------------------------- primitives */

function Description({ system, set }: { system: Blob; set: Setter }) {
  return (
    <Field label="Description">
      <textarea
        rows={3}
        value={(system.description as string) ?? ''}
        onChange={(e) => set('description', e.target.value)}
        placeholder="What it does, in your own words."
        className="w-full resize-y rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-200 placeholder:text-ink-500 focus:border-arcane-400 focus:outline-none"
      />
    </Field>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-3">{children}</div>;
}

function Field({
  label,
  hint,
  className = '',
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block min-w-32 flex-1 ${className}`}>
      <span className="mb-1 block text-[10px] font-semibold tracking-wider text-ink-400 uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="mt-0.5 block text-[10px] text-ink-500">{hint}</span>}
    </label>
  );
}

function Select({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-ink-600 bg-ink-850 px-3 py-1.5 text-sm text-ink-100 focus:border-arcane-400 focus:outline-none"
    >
      {children}
    </select>
  );
}

function Check({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 accent-arcane-500"
      />
      <span>
        <span className="text-sm text-ink-200">{label}</span>
        {hint && <span className="block text-[10px] text-ink-500">{hint}</span>}
      </span>
    </label>
  );
}
