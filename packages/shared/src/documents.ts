import { z } from 'zod';
import {
  abilityKeySchema,
  currencySchema,
  saveProficienciesSchema,
  skillProficienciesSchema,
  spellSlotsSchema,
} from './schemas.js';

/**
 * Foundry's document model, adapted.
 *
 * An Actor is a creature (PC or NPC). Everything an Actor owns - weapons,
 * spells, class features, gear - is an Item document attached to it, rather
 * than a JSON array on the actor row. That is what makes dragging a spell from
 * the SRD compendium onto a sheet, and posting per-item chat cards, natural
 * instead of awkward.
 */

/* ------------------------------------------------------------- ownership */

/** Per-user, per-document access. Mirrors Foundry's ownership levels. */
export const OWNERSHIP = {
  none: 0,
  /** Can see the name and portrait only. */
  limited: 1,
  /** Can read the full sheet but not edit. */
  observer: 2,
  /** Full control. */
  owner: 3,
} as const;

export type OwnershipLevel = (typeof OWNERSHIP)[keyof typeof OWNERSHIP];

export const ownershipLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const documentTypeSchema = z.enum(['actor', 'item', 'journal', 'scene']);
export type DocumentType = z.infer<typeof documentTypeSchema>;

/* ----------------------------------------------------------------- range */

/**
 * Spell and weapon ranges, parsed rather than left as prose, so the target
 * action panel can decide whether something is legal against a given token.
 */
export const rangeTypeSchema = z.enum(['self', 'touch', 'ranged', 'sight', 'unlimited']);

export const rangeSchema = z.object({
  type: rangeTypeSchema.default('ranged'),
  /** Feet. Ignored for self/touch/sight/unlimited. */
  value: z.number().min(0).default(0),
  /** Long range for thrown and ranged weapons, feet. */
  long: z.number().min(0).nullable().default(null),
});

export type SpellRange = z.infer<typeof rangeSchema>;

/** Parses SRD range prose into structured form. */
export function parseRange(text: string): SpellRange {
  const raw = (text ?? '').trim().toLowerCase();
  if (!raw) return { type: 'ranged', value: 0, long: null };
  if (raw.startsWith('self')) return { type: 'self', value: 0, long: null };
  if (raw.startsWith('touch')) return { type: 'touch', value: 5, long: null };
  if (raw.startsWith('sight')) return { type: 'sight', value: 0, long: null };
  if (raw.startsWith('unlimited') || raw.startsWith('special')) {
    return { type: 'unlimited', value: 0, long: null };
  }

  const feet = raw.match(/(\d+)\s*(?:feet|foot|ft)/);
  if (feet) return { type: 'ranged', value: Number(feet[1]), long: null };

  const miles = raw.match(/(\d+)\s*mile/);
  if (miles) return { type: 'ranged', value: Number(miles[1]) * 5280, long: null };

  return { type: 'ranged', value: 0, long: null };
}

/* ------------------------------------------------------ area of effect */

export const aoeShapeSchema = z.enum(['circle', 'cone', 'ray', 'rect', 'cube', 'cylinder']);

export const areaOfEffectSchema = z.object({
  shape: aoeShapeSchema,
  /** Radius, length or edge, in feet. */
  size: z.number().min(0).default(0),
  /** Ray width in feet, where applicable. */
  width: z.number().min(0).nullable().default(null),
});

/* ------------------------------------------------------------ item types */

export const itemTypeSchema = z.enum([
  'weapon',
  'spell',
  'feature',
  'equipment',
  'consumable',
  'class',
  'background',
  'race',
]);

export type ItemType = z.infer<typeof itemTypeSchema>;

/** Limited-use resources: "3 per long rest", "1 per turn". */
export const usesSchema = z.object({
  value: z.number().int().min(0).default(0),
  max: z.number().int().min(0).default(0),
  per: z.enum(['turn', 'round', 'encounter', 'short', 'long', 'day', 'charges']).default('long'),
});

export const activationSchema = z.object({
  type: z
    .enum(['action', 'bonus', 'reaction', 'minute', 'hour', 'legendary', 'lair', 'special', 'none'])
    .default('action'),
  cost: z.number().int().min(0).default(1),
});

const physicalFields = {
  quantity: z.number().int().min(0).default(1),
  weight: z.number().min(0).default(0),
  equipped: z.boolean().default(false),
  magical: z.boolean().default(false),
  attunement: z.enum(['none', 'required', 'attuned']).default('none'),
  price: z.string().max(30).default(''),
};

export const weaponSystemSchema = z.object({
  ...physicalFields,
  ability: abilityKeySchema.default('str'),
  proficient: z.boolean().default(true),
  attackBonus: z.number().int().default(0),
  damageDice: z.string().max(30).default('1d6'),
  damageBonus: z.number().int().default(0),
  damageType: z.string().max(30).default('slashing'),
  /** Finesse lets the sheet automatically pick the better of STR and DEX. */
  finesse: z.boolean().default(false),
  versatile: z.boolean().default(false),
  versatileDice: z.string().max(30).default(''),
  twoHanded: z.boolean().default(false),
  thrown: z.boolean().default(false),
  range: rangeSchema.default({ type: 'touch', value: 5, long: null }),
  properties: z.array(z.string().max(30)).default([]),
  activation: activationSchema.default({}),
  description: z.string().max(8000).default(''),
});

export const spellSystemSchema = z.object({
  srdSpellId: z.string().nullable().default(null),
  level: z.number().int().min(0).max(9).default(0),
  school: z.string().max(30).default(''),
  castingTime: z.string().max(60).default('1 action'),
  activation: activationSchema.default({}),
  rangeText: z.string().max(60).default(''),
  range: rangeSchema.default({}),
  components: z
    .object({
      verbal: z.boolean().default(false),
      somatic: z.boolean().default(false),
      material: z.boolean().default(false),
      materialText: z.string().max(300).default(''),
    })
    .default({}),
  duration: z.string().max(60).default('Instantaneous'),
  concentration: z.boolean().default(false),
  ritual: z.boolean().default(false),
  /** How many creatures can be targeted; null means an area or self spell. */
  targetCount: z.number().int().min(0).nullable().default(1),
  areaOfEffect: areaOfEffectSchema.nullable().default(null),
  damageDice: z.string().max(60).default(''),
  damageType: z.string().max(30).default(''),
  /** Present when the spell allows a save instead of an attack roll. */
  save: z
    .object({ ability: abilityKeySchema, halfOnSuccess: z.boolean().default(false) })
    .nullable()
    .default(null),
  attackRoll: z.boolean().default(false),
  prepared: z.boolean().default(false),
  alwaysPrepared: z.boolean().default(false),
  higherLevel: z.string().max(4000).default(''),
  description: z.string().max(20000).default(''),
});

export const featureSystemSchema = z.object({
  source: z.string().max(60).default(''),
  requirements: z.string().max(120).default(''),
  uses: usesSchema.nullable().default(null),
  activation: activationSchema.default({ type: 'none', cost: 0 }),
  description: z.string().max(20000).default(''),
});

export const equipmentSystemSchema = z.object({
  ...physicalFields,
  armorType: z.enum(['none', 'light', 'medium', 'heavy', 'shield']).default('none'),
  baseAC: z.number().int().min(0).default(0),
  /** Medium armor caps the DEX bonus at +2; heavy armor allows none. */
  dexCap: z.number().int().nullable().default(null),
  strengthRequirement: z.number().int().min(0).default(0),
  stealthDisadvantage: z.boolean().default(false),
  description: z.string().max(8000).default(''),
});

export const consumableSystemSchema = z.object({
  ...physicalFields,
  consumableType: z.enum(['potion', 'scroll', 'ammunition', 'food', 'other']).default('other'),
  uses: usesSchema.nullable().default(null),
  description: z.string().max(8000).default(''),
});

export const classSystemSchema = z.object({
  levels: z.number().int().min(1).max(20).default(1),
  hitDie: z.string().max(10).default('d8'),
  subclass: z.string().max(60).default(''),
  spellcastingAbility: abilityKeySchema.nullable().default(null),
  /** Full, half, third or none - drives slot progression. */
  spellcastingProgression: z.enum(['none', 'third', 'half', 'full', 'pact']).default('none'),
  description: z.string().max(8000).default(''),
});

export const originSystemSchema = z.object({
  description: z.string().max(20000).default(''),
  grantedProficiencies: z.array(z.string().max(60)).default([]),
});

/** Discriminated on the item's type, so `system` is always correctly shaped. */
export const itemSystemSchemas = {
  weapon: weaponSystemSchema,
  spell: spellSystemSchema,
  feature: featureSystemSchema,
  equipment: equipmentSystemSchema,
  consumable: consumableSystemSchema,
  class: classSystemSchema,
  background: originSystemSchema,
  race: originSystemSchema,
} as const;

export type WeaponSystem = z.infer<typeof weaponSystemSchema>;
export type SpellSystem = z.infer<typeof spellSystemSchema>;
export type FeatureSystem = z.infer<typeof featureSystemSchema>;
export type EquipmentSystem = z.infer<typeof equipmentSystemSchema>;
export type ConsumableSystem = z.infer<typeof consumableSystemSchema>;
export type ClassSystem = z.infer<typeof classSystemSchema>;
export type OriginSystem = z.infer<typeof originSystemSchema>;

export type ItemSystem =
  | WeaponSystem
  | SpellSystem
  | FeatureSystem
  | EquipmentSystem
  | ConsumableSystem
  | ClassSystem
  | OriginSystem;

/** Validates an item's `system` blob against the schema for its declared type. */
export function parseItemSystem(type: ItemType, system: unknown): ItemSystem {
  return itemSystemSchemas[type].parse(system ?? {}) as ItemSystem;
}

/* ----------------------------------------------------------------- actor */

export const actorTypeSchema = z.enum(['character', 'npc']);
export type ActorType = z.infer<typeof actorTypeSchema>;

export const dispositionSchema = z.enum(['friendly', 'neutral', 'hostile']);
export type Disposition = z.infer<typeof dispositionSchema>;

/**
 * Default token settings for an actor. Dropping the actor on a scene stamps a
 * token from this.
 */
export const prototypeTokenSchema = z.object({
  imageUrl: z.string().max(500).nullable().default(null),
  /** Footprint in grid units: 1 = Medium, 2 = Large, 4 = Gargantuan. */
  w: z.number().min(0.25).max(40).default(1),
  h: z.number().min(0.25).max(40).default(1),
  /**
   * Linked tokens share HP with the actor (player characters). Unlinked tokens
   * copy the actor's data on creation, so five goblins have five independent
   * HP pools.
   */
  actorLinked: z.boolean().default(false),
  disposition: dispositionSchema.default('hostile'),
  visionRange: z.number().min(0).default(0),
  darkvisionRange: z.number().min(0).default(0),
  lightBright: z.number().min(0).default(0),
  lightDim: z.number().min(0).default(0),
  hidden: z.boolean().default(false),
});

export type PrototypeToken = z.infer<typeof prototypeTokenSchema>;

export const damageModifiersSchema = z.object({
  resistances: z.array(z.string().max(30)).default([]),
  vulnerabilities: z.array(z.string().max(30)).default([]),
  immunities: z.array(z.string().max(30)).default([]),
  conditionImmunities: z.array(z.string().max(30)).default([]),
});

export type DamageModifiers = z.infer<typeof damageModifiersSchema>;

/* -------------------------------------------------------- active effects */

/**
 * How a change combines with the base value. Order matters: multiply applies
 * before add, and override wins outright.
 */
export const effectModeSchema = z.enum([
  'add',
  'multiply',
  'override',
  'upgrade',
  'downgrade',
]);

export type EffectMode = z.infer<typeof effectModeSchema>;

export const effectChangeSchema = z.object({
  /** Dotted path into the derived actor, e.g. "abilities.str" or "ac". */
  key: z.string().max(120),
  mode: effectModeSchema.default('add'),
  value: z.union([z.number(), z.string(), z.boolean()]),
  /** Lower priority applies first. */
  priority: z.number().int().default(20),
});

export const effectDurationSchema = z.object({
  rounds: z.number().int().min(0).nullable().default(null),
  turns: z.number().int().min(0).nullable().default(null),
  startRound: z.number().int().min(0).nullable().default(null),
  startTurn: z.number().int().min(0).nullable().default(null),
});

export const activeEffectInputSchema = z.object({
  name: z.string().min(1).max(80),
  icon: z.string().max(200).default(''),
  changes: z.array(effectChangeSchema).max(40).default([]),
  duration: effectDurationSchema.default({}),
  disabled: z.boolean().default(false),
  /** Whether the effect transfers to the actor when the item is equipped. */
  transfer: z.boolean().default(true),
  /** Marks effects created from a 5e condition, so the HUD can toggle them. */
  statusId: z.string().max(40).nullable().default(null),
});

export type EffectChange = z.infer<typeof effectChangeSchema>;
export type ActiveEffectInput = z.infer<typeof activeEffectInputSchema>;

/* ----------------------------------------------------------------- actor */

/**
 * The actor sheet. Hot scalars stay as real columns so the party panel and
 * token HUD can query them; the long tail (weapons, spells, features) lives in
 * attached Items rather than here.
 */
export const actorInputSchema = z.object({
  type: actorTypeSchema.default('character'),
  name: z.string().min(1).max(60).trim(),
  portraitUrl: z.string().max(500).nullable().default(null),

  className: z.string().max(40).default(''),
  subclass: z.string().max(40).default(''),
  level: z.number().int().min(1).max(20).default(1),
  race: z.string().max(40).default(''),
  background: z.string().max(40).default(''),
  alignment: z.string().max(30).default(''),
  experience: z.number().int().min(0).default(0),

  str: z.number().int().min(1).max(30).default(10),
  dex: z.number().int().min(1).max(30).default(10),
  con: z.number().int().min(1).max(30).default(10),
  int: z.number().int().min(1).max(30).default(10),
  wis: z.number().int().min(1).max(30).default(10),
  cha: z.number().int().min(1).max(30).default(10),

  armorClass: z.number().int().min(0).max(40).default(10),
  speed: z.number().int().min(0).max(200).default(30),
  hpCurrent: z.number().int().default(1),
  hpMax: z.number().int().min(0).default(1),
  hpTemp: z.number().int().min(0).default(0),
  hitDiceTotal: z.string().max(20).default('1d8'),
  hitDiceUsed: z.number().int().min(0).default(0),
  deathSaveSuccesses: z.number().int().min(0).max(3).default(0),
  deathSaveFailures: z.number().int().min(0).max(3).default(0),
  inspiration: z.boolean().default(false),

  spellcastingAbility: abilityKeySchema.nullable().default(null),
  skillProficiencies: skillProficienciesSchema.default({}),
  saveProficiencies: saveProficienciesSchema.default({}),
  spellSlots: spellSlotsSchema.default({ max: Array(9).fill(0), used: Array(9).fill(0) }),
  currency: currencySchema.default({}),
  damageModifiers: damageModifiersSchema.default({}),
  prototypeToken: prototypeTokenSchema.default({}),

  /** NPC-only: challenge rating, shown on the stat block. */
  challengeRating: z.string().max(10).default(''),

  otherProficiencies: z.string().max(2000).default(''),
  notes: z.string().max(20000).default(''),
  appearance: z.string().max(4000).default(''),
  backstory: z.string().max(20000).default(''),
});

export type ActorInput = z.infer<typeof actorInputSchema>;

/** A blank character sheet. */
export function emptyActor(name: string, type: ActorType = 'character'): ActorInput {
  return actorInputSchema.parse({
    name,
    type,
    prototypeToken: { actorLinked: type === 'character', disposition: type === 'character' ? 'friendly' : 'hostile' },
  });
}
