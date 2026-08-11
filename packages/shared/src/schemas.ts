import { z } from 'zod';

/* ------------------------------------------------------------------ auth */

export const registerSchema = z.object({
  email: z.string().email().max(255),
  displayName: z.string().min(2).max(40).trim(),
  password: z.string().min(8).max(200),
});

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().max(200),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

/* ------------------------------------------------------- character sheet */

export const abilityKeySchema = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);

/** 0 = not proficient, 1 = proficient, 2 = expertise (double proficiency). */
export const proficiencyLevelSchema = z
  .union([z.literal(0), z.literal(1), z.literal(2)])
  .default(0);

export const skillProficienciesSchema = z.object({
  acrobatics: proficiencyLevelSchema,
  animalHandling: proficiencyLevelSchema,
  arcana: proficiencyLevelSchema,
  athletics: proficiencyLevelSchema,
  deception: proficiencyLevelSchema,
  history: proficiencyLevelSchema,
  insight: proficiencyLevelSchema,
  intimidation: proficiencyLevelSchema,
  investigation: proficiencyLevelSchema,
  medicine: proficiencyLevelSchema,
  nature: proficiencyLevelSchema,
  perception: proficiencyLevelSchema,
  performance: proficiencyLevelSchema,
  persuasion: proficiencyLevelSchema,
  religion: proficiencyLevelSchema,
  sleightOfHand: proficiencyLevelSchema,
  stealth: proficiencyLevelSchema,
  survival: proficiencyLevelSchema,
});

export const saveProficienciesSchema = z.object({
  str: z.boolean().default(false),
  dex: z.boolean().default(false),
  con: z.boolean().default(false),
  int: z.boolean().default(false),
  wis: z.boolean().default(false),
  cha: z.boolean().default(false),
});

/** Slots for spell levels 1-9; index 0 is 1st level. Cantrips are unlimited. */
export const spellSlotsSchema = z.object({
  max: z.array(z.number().int().min(0)).length(9),
  used: z.array(z.number().int().min(0)).length(9),
});

export const currencySchema = z.object({
  cp: z.number().int().min(0).default(0),
  sp: z.number().int().min(0).default(0),
  ep: z.number().int().min(0).default(0),
  gp: z.number().int().min(0).default(0),
  pp: z.number().int().min(0).default(0),
});

/* ------------------------------------------------------------- campaigns */

export const campaignInputSchema = z.object({
  name: z.string().min(1).max(80).trim(),
  description: z.string().max(5000).default(''),
});

export const memberRoleSchema = z.enum(['dm', 'player']);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const visibilitySchema = z.enum(['dm_only', 'shared']);
export type Visibility = z.infer<typeof visibilitySchema>;

/* ------------------------------------------------------- scenes & tokens */

export const sceneInputSchema = z.object({
  name: z.string().min(1).max(80).trim(),
  gridSize: z.number().min(4).max(512).default(70),
  gridOffsetX: z.number().default(0),
  gridOffsetY: z.number().default(0),
  gridVisible: z.boolean().default(true),
  fogEnabled: z.boolean().default(false),
  feetPerSquare: z.number().min(1).max(100).default(5),
});

export const tokenLayerSchema = z.enum(['background', 'token', 'gm']);
export type TokenLayer = z.infer<typeof tokenLayerSchema>;

export const tokenInputSchema = z.object({
  name: z.string().max(60).default(''),
  imageUrl: z.string().max(500).nullable().default(null),
  actorId: z.string().nullable().default(null),
  /** Linked tokens share HP with their actor; unlinked ones own a private copy. */
  actorLinked: z.boolean().default(false),
  disposition: z.enum(['friendly', 'neutral', 'hostile']).default('hostile'),
  visionRange: z.number().min(0).default(0),
  darkvisionRange: z.number().min(0).default(0),
  lightBright: z.number().min(0).default(0),
  lightDim: z.number().min(0).default(0),
  x: z.number().default(0),
  y: z.number().default(0),
  w: z.number().min(0.25).max(40).default(1),
  h: z.number().min(0.25).max(40).default(1),
  rotation: z.number().default(0),
  layer: tokenLayerSchema.default('token'),
  ownerUserId: z.string().nullable().default(null),
  hp: z.number().int().nullable().default(null),
  maxHp: z.number().int().nullable().default(null),
  ac: z.number().int().nullable().default(null),
  conditions: z.array(z.string().max(40)).max(30).default([]),
  hidden: z.boolean().default(false),
  locked: z.boolean().default(false),
});

export type TokenInput = z.infer<typeof tokenInputSchema>;

export const CONDITIONS = [
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
  'concentrating',
] as const;

export type Condition = (typeof CONDITIONS)[number];

/* ------------------------------------------------------------------ chat */

export const chatKindSchema = z.enum(['text', 'roll', 'card', 'system']);
export type ChatKind = z.infer<typeof chatKindSchema>;

export const sendMessageSchema = z.object({
  body: z.string().min(1).max(4000),
  /** Whisper target; null is public to the whole campaign. */
  whisperToUserId: z.string().nullable().default(null),
  actorId: z.string().nullable().default(null),
});

export const rollRequestSchema = z.object({
  expression: z.string().min(1).max(200),
  label: z.string().max(80).default(''),
  actorId: z.string().nullable().default(null),
  /** Secret rolls are visible only to the roller and the DM. */
  secret: z.boolean().default(false),
});

/** Posts an item's card to chat, with buttons for its actions. */
export const cardRequestSchema = z.object({
  itemId: z.string(),
  actorId: z.string(),
});

/** Presses a button on a posted card; the server rolls and replies. */
export const cardActionSchema = z.object({
  itemId: z.string(),
  actorId: z.string(),
  action: z.enum(['attack', 'damage', 'critical', 'save', 'versatile']),
  mode: z.enum(['normal', 'advantage', 'disadvantage']).default('normal'),
});

export type CardRequest = z.infer<typeof cardRequestSchema>;
export type CardAction = z.infer<typeof cardActionSchema>;

export type RollRequest = z.infer<typeof rollRequestSchema>;

export const rollResultSchema = z.object({
  expression: z.string(),
  total: z.number(),
  output: z.string(),
  label: z.string(),
  /** Individual die faces, for highlighting nat 20s in the UI. */
  rolls: z.array(z.number()).default([]),
  isCritical: z.boolean().default(false),
  isFumble: z.boolean().default(false),
});

export type RollResult = z.infer<typeof rollResultSchema>;

export type SkillProficiencies = z.infer<typeof skillProficienciesSchema>;
export type SaveProficiencies = z.infer<typeof saveProficienciesSchema>;
export type SpellSlots = z.infer<typeof spellSlotsSchema>;
export type Currency = z.infer<typeof currencySchema>;
