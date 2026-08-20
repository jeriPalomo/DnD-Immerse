import { z } from 'zod';
import {
  cardActionSchema,
  cardRequestSchema,
  rollRequestSchema,
  sendMessageSchema,
  tokenInputSchema,
  tokenQuantitySchema,
} from './schemas.js';
import type { ChatKind, MemberRole, RollResult, TokenLayer } from './schemas.js';
import { TERRAIN_BRUSHES } from './terrain.js';
import type { TerrainKind } from './terrain.js';

/**
 * The socket contract, shared by client and server.
 *
 * Every payload is defined once here so a protocol change surfaces as a
 * compile error on both sides rather than a runtime mystery.
 */

/* ------------------------------------------------------------ wire types */

export interface PublicUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/**
 * One effect on a token, as the HUD lists it.
 *
 * `roundsRemaining` is resolved by the server from the encounter's current
 * round rather than counted down in a stored field, which would drift the
 * moment a turn is rewound. Null means it lasts until someone removes it.
 */
export interface WireEffect {
  id: string;
  name: string;
  /** Names a 5e condition when this is one; null for a custom buff. */
  statusId: string | null;
  disabled: boolean;
  roundsRemaining: number | null;
}

export interface WireToken {
  id: string;
  sceneId: string;
  name: string;
  imageUrl: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  layer: TokenLayer;
  ownerUserId: string | null;
  actorId: string | null;
  /** Linked tokens share HP with their actor; unlinked keep a private copy. */
  actorLinked: boolean;
  disposition: 'friendly' | 'neutral' | 'hostile';
  /** Sight and light, all in feet. Drive the vision computation server-side. */
  visionRange: number;
  darkvisionRange: number;
  lightBright: number;
  lightDim: number;
  lightColor: string;
  /** Chosen by whoever owns it; null means wear the allegiance colour. */
  ringColor: string | null;
  hp: number | null;
  maxHp: number | null;
  ac: number | null;
  /** Derived from the token's effect rows, never stored on the token. */
  conditions: string[];
  /** The same effects with their names and countdowns, for the HUD. */
  effects: WireEffect[];
  /**
   * Whether this viewer may open the creature's stat block. Decided on the
   * server from the campaign setting and the token's own override, and sent so
   * the client knows whether to offer the button - never so it can decide. The
   * route re-checks; an honest client is not a security assumption.
   */
  statsVisible: boolean;
  /**
   * The DM's per-creature override. Sent as `false` to players whatever it
   * really is: telling them the DM has closed *this* creature marks it as the
   * interesting one, which is most of what closing it was meant to withhold.
   */
  statsHidden: boolean;
  /** Only ever true in a DM payload; hidden tokens are stripped for players. */
  hidden: boolean;
  locked: boolean;
}

export interface WireScene {
  id: string;
  campaignId: string;
  name: string;
  mapImageUrl: string | null;
  /** Natural pixel dimensions of the map image. */
  mapWidth: number;
  mapHeight: number;
  /** Pixel size of one grid square on the source image. */
  gridSize: number;
  gridOffsetX: number;
  gridOffsetY: number;
  gridVisible: boolean;
  feetPerSquare: number;
  visionEnabled: boolean;
  globalIllumination: boolean;
  darkness: number;
  /** Cosmetic overlay; never affects who can see what. */
  weather: 'none' | 'rain' | 'storm' | 'snow' | 'fog' | 'ash';
  weatherIntensity: number;
  /** Whether players may draw and ping here. Enforced on the server. */
  playerDrawing: boolean;
}

export interface WireCard {
  itemId: string;
  actorId: string;
  itemType: string;
  itemName: string;
  subtitle: string;
  description: string;
  /** Buttons the viewer may press, already filtered by what the item supports. */
  actions: ('attack' | 'damage' | 'critical' | 'save' | 'versatile' | 'heal')[];
  saveAbility: string | null;
  saveDC: number | null;
  /** The token this was aimed at when it was posted, if any. */
  targetTokenId: string | null;
}

/**
 * One check rolled for several creatures at once.
 *
 * Structured rather than a block of text, for the reason `rollData` and
 * `cardData` already are: the totals are the thing being read, and eight lines
 * of "Goblin 3: 1d20+2: [11]+2 = 13" buries them in their own arithmetic. The
 * body is still written out underneath, so a log that predates this column, or
 * a client that has not been rebuilt, loses nothing.
 */
export interface WireGroupRoll {
  /** "Group DEX saving throw", "Group Stealth check". */
  label: string;
  dc: number | null;
  rows: {
    name: string;
    /**
     * Whose row it is to answer, when it is still waiting on somebody.
     *
     * A creature the DM already rolled carries null: the row is finished and
     * there is nobody left to ask. This is what the prompt on a player's screen
     * matches against, so it is the actor rather than the user - a player with
     * two characters is asked twice, which is correct.
     */
    actorId: string | null;
    /** The d20 faces. Empty while the row is still waiting. */
    dice: number[];
    modifier: number;
    /** Null until somebody has actually rolled it. */
    total: number | null;
    /** Null when no DC was named, or when the row has not been rolled yet. */
    passed: boolean | null;
  }[];
}

export interface WireChatMessage {
  id: string;
  campaignId: string;
  userId: string;
  authorName: string;
  actorName: string | null;
  kind: ChatKind;
  body: string;
  rollData: RollResult | null;
  cardData: WireCard | null;
  groupData: WireGroupRoll | null;
  whisperToUserId: string | null;
  /** Belongs to the battle log rather than the conversation. */
  combat: boolean;
  createdAt: number;
}

export interface WireInitiativeEntry {
  id: string;
  tokenId: string | null;
  name: string;
  initiative: number;
  /**
   * Waiting on whoever runs this creature to roll it.
   *
   * The DM's monsters are rolled when the fight starts - they have nobody to
   * ask - and a character is asked, the same split the group roll makes. A
   * pending entry sorts last until it is answered.
   */
  pending: boolean;
  /**
   * What the d20 will have added to it, on an entry that is still waiting.
   *
   * Null on anything already rolled, so there is no path for a monster's
   * numbers to ride along here - the DM's creatures roll the moment the fight
   * starts and are never pending. A pending entry is therefore always a
   * character, whose Dexterity modifier the party list already prints.
   */
  initiativeBonus: number | null;
  sortOrder: number;
  /** Shown in the tracker so the DM can see who is hurt at a glance. */
  hp: number | null;
  maxHp: number | null;
  conditions: string[];
  /**
   * The token's art, so a twelve-creature fight is scannable by face rather
   * than by reading twelve names. Carries no secret: `name` above is already
   * sent unredacted, so a goblin's picture says nothing the word "Goblin" did
   * not. If names are ever redacted, this must be redacted with them.
   */
  imageUrl: string | null;
  /** Players do not see enemy hit points, only a rough state. */
  hpRedacted: boolean;
}

export interface WireEncounter {
  id: string;
  sceneId: string | null;
  round: number;
  activeIndex: number;
  isActive: boolean;
  entries: WireInitiativeEntry[];
}

/** A pin on the map. Hidden pins are absent from a player's payload. */
export interface WireMapNote {
  id: string;
  sceneId: string;
  label: string;
  icon: string;
  x: number;
  y: number;
  journalPageId: string | null;
  hidden: boolean;
}

export interface WireDrawing {
  id: string;
  sceneId: string;
  ownerUserId: string | null;
  kind: 'freehand' | 'arrow' | 'text';
  /** Flat x,y pairs in grid units, as Konva wants them. */
  points: number[];
  color: string;
  text: string;
  width: number;
}

export interface WireTemplate {
  id: string;
  sceneId: string;
  ownerUserId: string | null;
  shape: 'circle' | 'cone' | 'ray' | 'rect';
  x: number;
  y: number;
  direction: number;
  distance: number;
  width: number;
  color: string;
}

/** Sent only to the DM. Wall geometry is a map of the dungeon. */
export interface WireWall {
  id: string;
  sceneId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  blocksMovement: number;
  blocksSight: number;
  door: number;
  doorState: number;
}

/**
 * What a player is allowed to know about their own sight. The polygons are
 * handed over so the client can draw fog; the walls that produced them are not.
 */
export interface WireVision {
  /** Currently visible regions, in grid units. */
  polygons: { x: number; y: number }[][];
  /** Squares explored previously - drawn dimmed rather than black. */
  explored: [number, number][];
  gridWidth: number;
  gridHeight: number;
}

/** A door a player may click, without revealing the wall network around it. */
export interface WireDoor {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  door: number;
  doorState: number;
}

export interface WirePresence {
  user: PublicUser;
  role: MemberRole;
  online: boolean;
}

/* --------------------------------------------------------- event payloads */

export const tokenMoveSchema = z.object({
  tokenId: z.string(),
  x: z.number(),
  y: z.number(),
});

export const tokenCommitSchema = z.object({
  tokenId: z.string(),
  x: z.number(),
  y: z.number(),
  rotation: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
});

export const tokenCreateSchema = tokenInputSchema.extend({
  sceneId: z.string(),
  quantity: tokenQuantitySchema,
});

export const tokenUpdateSchema = tokenInputSchema.partial().extend({ tokenId: z.string() });

export const wallCreateSchema = z.object({
  sceneId: z.string(),
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
  blocksMovement: z.number().int().min(0).max(1).default(1),
  blocksSight: z.number().int().min(0).max(2).default(1),
  door: z.number().int().min(0).max(2).default(0),
  doorState: z.number().int().min(0).max(2).default(0),
});

export const wallUpdateSchema = wallCreateSchema
  .partial()
  .extend({ wallId: z.string() });

export type WallCreatePayload = z.infer<typeof wallCreateSchema>;
export type WallUpdatePayload = z.infer<typeof wallUpdateSchema>;

/**
 * Ask where something can move.
 *
 * A query rather than a command, answered only to the socket that asked -
 * reachability depends on walls, and players are never sent those, so this is
 * the only way a client can know. `threat` asks for the union of every hostile
 * the asker can see instead of one token's own range.
 */
export const movementQuerySchema = z.object({
  tokenId: z.string().nullable().default(null),
  threat: z.boolean().default(false),
});

/**
 * Doubles this turn's movement for one creature.
 *
 * The app has no action economy, so it cannot know a creature took the Dash
 * action - and enforcing a budget with no way to say so makes a legal turn
 * impossible, which is a worse kind of wrong than not counting at all. A toggle
 * rather than a counter: a mis-click has to be undoable.
 */
export const movementDashSchema = z.object({
  tokenId: z.string(),
  on: z.boolean(),
});

export const pingSchema = z.object({
  sceneId: z.string(),
  x: z.number(),
  y: z.number(),
  /**
   * An optional stroke, in GRID UNITS, when the ping was dragged rather than
   * clicked: "he came round *this* way" is a line, not a dot. Capped well below
   * the persisted drawing limit because a ping is thrown away seconds later.
   */
  points: z.array(z.number()).max(600).default([]),
  /**
   * Who is pointing. The colour is derived from this on the SERVER, after
   * checking the sender actually controls the character - otherwise anyone
   * could point in someone else's colour.
   */
  actorId: z.string().nullable().default(null),
});

export const damageApplySchema = z.object({
  tokenIds: z.array(z.string()).min(1).max(50),
  amount: z.number().int().min(0).max(1000),
  damageType: z.string().max(30).default(''),
  /** Healing shares the path so one flow covers both directions. */
  healing: z.boolean().default(false),
  /** Half on a successful save, for area spells. */
  halved: z.boolean().default(false),
});

export const initiativeAddSchema = z.object({
  tokenIds: z.array(z.string()).min(1).max(50),
  /** Roll initiative automatically rather than entering it by hand. */
  roll: z.boolean().default(true),
  /**
   * Leave the characters unrolled for their players to answer.
   *
   * Only ever applies to creatures somebody else runs: the DM's own monsters
   * have nobody to ask and roll immediately, so a fight is never held up
   * waiting on a goblin.
   */
  askPlayers: z.boolean().default(false),
});

/** One person rolling an initiative entry that is waiting on them. */
export const initiativeRollSchema = z.object({ entryId: z.string() });

export type DamageApplyPayload = z.infer<typeof damageApplySchema>;
export type InitiativeAddPayload = z.infer<typeof initiativeAddSchema>;
export type InitiativeRollPayload = z.infer<typeof initiativeRollSchema>;

/**
 * Putting a condition on a token, with an optional timer.
 *
 * `rounds` null means it lasts until someone removes it, which is what a
 * hand-toggled condition has always been. A number starts a countdown measured
 * from the encounter's current round — so nothing ticks outside combat, because
 * rounds only advance in a fight. That is a stated limit, not an oversight.
 */
export const effectApplySchema = z.object({
  tokenIds: z.array(z.string()).min(1).max(50),
  /** One of `CONDITIONS`. The server refuses anything it cannot model. */
  condition: z.string().max(40),
  rounds: z.number().int().min(1).max(1000).nullable().default(null),
  /** The item that inflicted it, for the log. */
  itemId: z.string().nullable().default(null),
});

/** Editing a running effect: shorten it, extend it, or suspend it. */
export const effectUpdateSchema = z.object({
  effectId: z.string(),
  /** Rounds remaining from now. Null makes it last until removed. */
  rounds: z.number().int().min(0).max(1000).nullable().optional(),
  disabled: z.boolean().optional(),
});

export const effectRemoveSchema = z.object({
  effectId: z.string(),
});

export type EffectApplyPayload = z.infer<typeof effectApplySchema>;
export type EffectUpdatePayload = z.infer<typeof effectUpdateSchema>;
export type EffectRemovePayload = z.infer<typeof effectRemoveSchema>;

export const drawingCreateSchema = z.object({
  sceneId: z.string(),
  kind: z.enum(['freehand', 'arrow', 'text']),
  points: z.array(z.number()).min(2).max(2000),
  color: z.string().max(20).default('#e8853f'),
  text: z.string().max(120).default(''),
  width: z.number().min(1).max(20).default(3),
});

export type DrawingCreatePayload = z.infer<typeof drawingCreateSchema>;

export const groupRollSchema = z.object({
  /** Which kind of check each creature makes. */
  kind: z.enum(['skill', 'save', 'ability']),
  /** A skill key, an ability key, or an ability key for a raw check. */
  key: z.string().max(30),
  /** Optional target number; each line is marked pass or fail against it. */
  dc: z.number().int().min(1).max(40).nullable().default(null),
  /** Secret rolls go to the DM alone - a stealth check nobody should see. */
  secret: z.boolean().default(false),
  /**
   * Who rolls: the campaign's characters, or creatures the DM names.
   *
   * The creatures half is the one that earns this feature. Six goblins in a
   * fireball is six saves the DM rolls by hand off a stat block, where the
   * party half rolls dice on the players' behalf and takes the moment off them.
   */
  who: z.enum(['party', 'creatures']).default('party'),
  /**
   * `creatures` rolls at once; `party` posts the request and waits.
   *
   * That difference is the whole point of having both. Rolling the players'
   * dice for them takes the moment off them, which is why asking the party was
   * cut once already - so the party half asks, and each player presses their
   * own button. The DM's own monsters have nobody to ask.
   */
  /**
   * Tokens to roll for when `who` is `creatures`.
   *
   * Ids from a client are a claim: these are looked up through the scene's
   * campaign, so one borrowed from another table is simply not found.
   *
   * Capped well above any real scene rather than at a tidy number: a horde of
   * forty zombies is a fight somebody runs, and a payload that trips the cap
   * fails as "not something the table understood", which explains nothing.
   */
  tokenIds: z.array(z.string()).max(60).default([]),
});

export type GroupRollPayload = z.infer<typeof groupRollSchema>;

/** One person answering a group roll that is waiting on them. */
export const groupAnswerSchema = z.object({
  messageId: z.string(),
  /** Which row - a player with two characters can be asked for both. */
  actorId: z.string(),
});

export type GroupAnswerPayload = z.infer<typeof groupAnswerSchema>;

export const templateCreateSchema = z.object({
  sceneId: z.string(),
  shape: z.enum(['circle', 'cone', 'ray', 'rect']),
  x: z.number(),
  y: z.number(),
  direction: z.number().default(0),
  /** Radius or length, in feet. */
  distance: z.number().min(0).max(1000),
  width: z.number().min(0).max(200).default(5),
  color: z.string().max(20).default('#4a9eff'),
});

export type TemplateCreatePayload = z.infer<typeof templateCreateSchema>;

export const initiativeUpdateSchema = z.object({
  encounterId: z.string(),
  round: z.number().int().min(1).optional(),
  activeIndex: z.number().int().min(0).optional(),
  entries: z
    .array(
      z.object({
        id: z.string(),
        initiative: z.number(),
      }),
    )
    .optional(),
});

export type TokenMovePayload = z.infer<typeof tokenMoveSchema>;
export type TokenCommitPayload = z.infer<typeof tokenCommitSchema>;
export type TokenCreatePayload = z.infer<typeof tokenCreateSchema>;
export type TokenUpdatePayload = z.infer<typeof tokenUpdateSchema>;
export type PingPayload = z.infer<typeof pingSchema>;
export type InitiativeUpdatePayload = z.infer<typeof initiativeUpdateSchema>;

/**
 * One stroke of the ground brush.
 *
 * Parsed rather than cast. `brush` indexes into the terrain map by name, so an
 * unknown one reached `markExplored(undefined, ...)` and threw inside the
 * handler; fractional coordinates would have truncated into a *different*
 * square's bit than the one asked for. The cap is the largest grid the fog
 * bitmaps use, so a whole scene can be painted in one stroke and no more.
 */
export const terrainPaintSchema = z.object({
  sceneId: z.string(),
  brush: z.enum(TERRAIN_BRUSHES),
  cells: z.array(z.tuple([z.number().int(), z.number().int()])).max(40000),
});

export type TerrainPaintPayload = z.infer<typeof terrainPaintSchema>;

/* ---------------------------------------------------------------- events */

/**
 * One list of squares per painted kind. Keyed off `TerrainKind` rather than
 * spelled out, so adding a brush is a change in one file rather than four.
 */
export type TerrainCells = Record<TerrainKind, [number, number][]> & {
  /** False when it was painted at a different grid, so the panel can say so. */
  matchesGrid: boolean;
};

export interface ServerToClientEvents {
  /** DM room only. Players are never sent painted ground. */
  'terrain:state': (payload: { sceneId: string; terrain: TerrainCells }) => void;
  'scene:state': (payload: {
    scene: WireScene | null;
    tokens: WireToken[];
    /** Null when the scene has vision disabled - everyone sees everything. */
    vision: WireVision | null;
    /** Doors are shown to players so they can be opened; walls are not. */
    doors: WireDoor[];
    notes: WireMapNote[];
    drawings: WireDrawing[];
    /** DM only. Absent from every player payload. */
    walls?: WireWall[];
  }) => void;

  'token:moved': (payload: TokenMovePayload & { byUserId: string }) => void;
  'token:created': (payload: { token: WireToken }) => void;
  'token:updated': (payload: { token: WireToken }) => void;
  'token:deleted': (payload: { tokenId: string }) => void;

  'chat:message': (payload: { message: WireChatMessage }) => void;
  'chat:history': (payload: { messages: WireChatMessage[] }) => void;
  /** The DM cleared the log; everyone drops what they are holding. */
  'chat:cleared': (payload: Record<string, never>) => void;

  'initiative:state': (payload: { encounter: WireEncounter | null }) => void;
  /** Result of applying damage, so chat can explain resistances. */
  'damage:applied': (payload: {
    results: { tokenId: string; name: string; before: number; after: number; reason: string }[];
  }) => void;

  'template:state': (payload: { templates: WireTemplate[] }) => void;
  /** Shown large on every screen for a moment, then it settles into the journal. */
  'handout:reveal': (payload: { imageUrl: string; title: string }) => void;
  /**
   * A journal entry was shown to the party or taken back. Carries nothing: the
   * panel refetches, so what a player may read is still decided server-side.
   */
  'journal:changed': (payload: Record<string, never>) => void;

  'ping:map': (payload: PingPayload & { byUserId: string; color: string }) => void;

  /**
   * Squares a token can reach, or the union of what every visible hostile can
   * reach. Sent only to the socket that asked, and clipped for a player to what
   * they have explored - a threat range flowing round a corner would otherwise
   * draw them a corridor they have not found.
   */
  'movement:range': (payload: {
    tokenId: string | null;
    threat: boolean;
    squares: [number, number][];
    /**
     * What this creature has left of its turn, and what a full turn is worth.
     *
     * Null outside combat, and null for a threat union - a turn's movement
     * belongs to one creature. Sent only in the reply to the socket that asked,
     * which is already gated on control or `mayReadStats`, so this does not
     * widen who can work out a monster's speed.
     */
    leftFeet: number | null;
    maxFeet: number | null;
    /** Whether the Dash has already been taken, so the toggle reads true. */
    dashed: boolean;
  }) => void;

  /**
   * Live sight during a drag. Carries polygons and the tokens now in view, but
   * no explored cells - fog exploration is persisted once, on drop, rather than
   * written thirty times a second.
   */
  'vision:update': (payload: { polygons: { x: number; y: number }[][]; tokens: WireToken[] }) => void;

  'wall:created': (payload: { wall: WireWall }) => void;
  'wall:updated': (payload: { wall: WireWall }) => void;
  'wall:deleted': (payload: { wallId: string }) => void;
  'door:updated': (payload: { door: WireDoor }) => void;

  presence: (payload: { members: WirePresence[] }) => void;

  error: (payload: { message: string; code?: string }) => void;
}

export interface ClientToServerEvents {
  'campaign:join': (payload: { campaignId: string }) => void;
  'campaign:leave': (payload: { campaignId: string }) => void;

  'scene:activate': (payload: { sceneId: string }) => void;
  /** DM-only. Opens the whole scene to every player, or forgets it entirely. */
  'fog:reveal': (payload: { sceneId: string }) => void;
  'fog:reset': (payload: { sceneId: string }) => void;
  /**
   * DM-only. Paints ground impassable or difficult.
   *
   * The painted map itself never travels to a player - it is a map of the
   * dungeon, like wall geometry. They feel it through the movement overlay and
   * through a refused drag, both answered on the server.
   */
  'terrain:paint': (payload: TerrainPaintPayload) => void;

  'token:move': (payload: TokenMovePayload) => void;
  'token:commit': (payload: TokenCommitPayload) => void;
  'token:create': (payload: TokenCreatePayload) => void;
  'token:update': (payload: TokenUpdatePayload) => void;
  'token:delete': (payload: { tokenId: string }) => void;

  'chat:send': (payload: z.infer<typeof sendMessageSchema>) => void;
  'chat:roll': (payload: z.infer<typeof rollRequestSchema>) => void;
  'chat:groupRoll': (payload: GroupRollPayload) => void;
  'chat:groupAnswer': (payload: GroupAnswerPayload) => void;
  'chat:card': (payload: z.infer<typeof cardRequestSchema>) => void;
  'chat:cardAction': (payload: z.infer<typeof cardActionSchema>) => void;
  /** DM only. Deletes the campaign's log outright - chat and battle alike. */
  'chat:clear': (payload: Record<string, never>) => void;
  'movement:query': (payload: z.infer<typeof movementQuerySchema>) => void;
  /** Doubles this turn's movement; see `movementDashSchema`. */
  'movement:dash': (payload: z.infer<typeof movementDashSchema>) => void;

  'initiative:update': (payload: InitiativeUpdatePayload) => void;
  'encounter:start': (payload: { sceneId: string | null }) => void;
  'encounter:end': (payload: Record<string, never>) => void;
  'initiative:add': (payload: InitiativeAddPayload) => void;
  'initiative:roll': (payload: InitiativeRollPayload) => void;
  'initiative:remove': (payload: { entryId: string }) => void;
  'turn:next': (payload: Record<string, never>) => void;
  'turn:previous': (payload: Record<string, never>) => void;
  'damage:apply': (payload: DamageApplyPayload) => void;
  'death:save': (payload: { tokenId: string }) => void;

  /**
   * Conditions and buffs. A player may condition a monster and never another
   * character - the same `isFairGame` rule damage:apply follows - and removal is
   * the DM's, except on a token the player owns.
   */
  'effect:apply': (payload: EffectApplyPayload) => void;
  'effect:update': (payload: EffectUpdatePayload) => void;
  'effect:remove': (payload: EffectRemovePayload) => void;
  'handout:show': (payload: { pageId: string }) => void;

  'template:create': (payload: TemplateCreatePayload) => void;
  'template:delete': (payload: { templateId: string }) => void;
  'drawing:create': (payload: DrawingCreatePayload) => void;
  'drawing:delete': (payload: { drawingId: string | 'mine' | 'all' }) => void;

  'ping:map': (payload: PingPayload) => void;

  'wall:create': (payload: WallCreatePayload) => void;
  'wall:update': (payload: WallUpdatePayload) => void;
  'wall:delete': (payload: { wallId: string }) => void;
  /** Any player may open a door they can see; that is the point of doors. */
  'door:toggle': (payload: { wallId: string }) => void;
}

/** Room naming. The `:dm` room is what keeps DM-only data structurally separate. */
export function campaignRoom(campaignId: string): string {
  return `campaign:${campaignId}`;
}

export function campaignDmRoom(campaignId: string): string {
  return `campaign:${campaignId}:dm`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** How often a dragging client emits position updates, in ms (~30Hz). */
export const TOKEN_MOVE_THROTTLE_MS = 33;
