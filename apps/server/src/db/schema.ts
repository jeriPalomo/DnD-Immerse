import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type {
  ActiveEffectInput,
  Currency,
  DamageModifiers,
  ItemSystem,
  PrototypeToken,
  RollResult,
  SaveProficiencies,
  SkillProficiencies,
  SpellSlots,
} from '@dnd/shared';

const id = () => text('id').primaryKey();
const epoch = (name: string) =>
  integer(name)
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

/* ------------------------------------------------------------ users/auth */

export const users = sqliteTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  avatarUrl: text('avatar_url'),
  createdAt: epoch('created_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    createdAt: epoch('created_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/* ------------------------------------------------------------- campaigns */

export const campaigns = sqliteTable('campaigns', {
  id: id(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  dmUserId: text('dm_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  activeSceneId: text('active_scene_id'),
  inviteCode: text('invite_code').notNull().unique(),
  /**
   * Which edition the compendium offers. 2024 covers equipment and weapon
   * mastery; its spells and monsters are not published in the SRD dataset yet,
   * so those still come from 2014 whichever is selected.
   */
  ruleset: text('ruleset', { enum: ['2014', '2024'] })
    .notNull()
    .default('2014'),
  bannerUrl: text('banner_url'),
  /**
   * What happened last time, in the DM's own words. Written rather than
   * generated: a summary of the chat log reads back the dice, not the story,
   * and "you left the duke's study through the window" is the useful half.
   */
  recap: text('recap').notNull().default(''),
  createdAt: epoch('created_at'),
});

export const campaignMembers = sqliteTable(
  'campaign_members',
  {
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['dm', 'player'] })
      .notNull()
      .default('player'),
    joinedAt: epoch('joined_at'),
  },
  (t) => [primaryKey({ columns: [t.campaignId, t.userId] }), index('members_user_idx').on(t.userId)],
);

/* ---------------------------------------------------------------- actors */

/**
 * A creature: player character or NPC. Actors belong to a USER (or to the DM
 * for NPCs), not to a campaign - they are assigned in via actorCampaigns, so a
 * player keeps a persistent roster and a character survives a campaign ending.
 *
 * Hot scalars are real columns because the party panel and token HUD read them
 * constantly. Everything a creature *owns* lives in `items`.
 */
export const actors = sqliteTable(
  'actors',
  {
    id: id(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Set for NPCs authored inside one campaign; null for portable PCs. */
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['character', 'npc'] })
      .notNull()
      .default('character'),
    name: text('name').notNull(),
    portraitUrl: text('portrait_url'),

    className: text('class_name').notNull().default(''),
    subclass: text('subclass').notNull().default(''),
    level: integer('level').notNull().default(1),
    race: text('race').notNull().default(''),
    background: text('background').notNull().default(''),
    alignment: text('alignment').notNull().default(''),
    experience: integer('experience').notNull().default(0),
    challengeRating: text('challenge_rating').notNull().default(''),

    str: integer('str').notNull().default(10),
    dex: integer('dex').notNull().default(10),
    con: integer('con').notNull().default(10),
    int: integer('int').notNull().default(10),
    wis: integer('wis').notNull().default(10),
    cha: integer('cha').notNull().default(10),

    armorClass: integer('armor_class').notNull().default(10),
    speed: integer('speed').notNull().default(30),
    hpCurrent: integer('hp_current').notNull().default(1),
    hpMax: integer('hp_max').notNull().default(1),
    hpTemp: integer('hp_temp').notNull().default(0),
    hitDiceTotal: text('hit_dice_total').notNull().default('1d8'),
    hitDiceUsed: integer('hit_dice_used').notNull().default(0),
    deathSaveSuccesses: integer('death_save_successes').notNull().default(0),
    deathSaveFailures: integer('death_save_failures').notNull().default(0),
    inspiration: integer('inspiration', { mode: 'boolean' }).notNull().default(false),

    spellcastingAbility: text('spellcasting_ability'),

    skillProficiencies: text('skill_proficiencies', { mode: 'json' })
      .$type<SkillProficiencies>()
      .notNull(),
    saveProficiencies: text('save_proficiencies', { mode: 'json' })
      .$type<SaveProficiencies>()
      .notNull(),
    spellSlots: text('spell_slots', { mode: 'json' }).$type<SpellSlots>().notNull(),
    currency: text('currency', { mode: 'json' }).$type<Currency>().notNull(),
    damageModifiers: text('damage_modifiers', { mode: 'json' }).$type<DamageModifiers>().notNull(),
    /** Default token settings stamped onto new tokens for this actor. */
    prototypeToken: text('prototype_token', { mode: 'json' }).$type<PrototypeToken>().notNull(),

    otherProficiencies: text('other_proficiencies').notNull().default(''),
    notes: text('notes').notNull().default(''),
    appearance: text('appearance').notNull().default(''),
    backstory: text('backstory').notNull().default(''),

    createdAt: epoch('created_at'),
    updatedAt: epoch('updated_at'),
  },
  (t) => [index('actors_owner_idx').on(t.ownerUserId), index('actors_campaign_idx').on(t.campaignId)],
);

export const actorCampaigns = sqliteTable(
  'actor_campaigns',
  {
    actorId: text('actor_id')
      .notNull()
      .references(() => actors.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    assignedAt: epoch('assigned_at'),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.campaignId] }),
    index('actor_campaigns_campaign_idx').on(t.campaignId),
  ],
);

/* ----------------------------------------------------------------- items */

/**
 * Everything an actor owns: weapons, spells, features, gear. `ownerActorId`
 * null means the item lives in a campaign's compendium, unattached, ready to
 * be dragged onto a sheet.
 */
export const items = sqliteTable(
  'items',
  {
    id: id(),
    ownerActorId: text('owner_actor_id').references(() => actors.id, { onDelete: 'cascade' }),
    campaignId: text('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: ['weapon', 'spell', 'feature', 'equipment', 'consumable', 'class', 'background', 'race'],
    }).notNull(),
    name: text('name').notNull(),
    imageUrl: text('image_url'),
    /** Shape validated against the schema for `type` before every write. */
    system: text('system', { mode: 'json' }).$type<ItemSystem>().notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: epoch('created_at'),
  },
  (t) => [
    index('items_owner_actor_idx').on(t.ownerActorId),
    index('items_campaign_type_idx').on(t.campaignId, t.type),
  ],
);

/* ------------------------------------------------------------- ownership */

/**
 * Per-user access to a document: 0 none, 1 limited, 2 observer, 3 owner.
 * A row, not a boolean, so "share this one NPC with one player" is ordinary
 * data rather than a special case.
 */
export const ownership = sqliteTable(
  'ownership',
  {
    documentType: text('document_type', { enum: ['actor', 'item', 'journal', 'scene'] }).notNull(),
    documentId: text('document_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    level: integer('level').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.documentType, t.documentId, t.userId] }),
    index('ownership_user_idx').on(t.userId),
  ],
);

/* ---------------------------------------------------------------- scenes */

export const scenes = sqliteTable(
  'scenes',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mapImageUrl: text('map_image_url'),
    mapWidth: integer('map_width').notNull().default(0),
    mapHeight: integer('map_height').notNull().default(0),

    gridSize: real('grid_size').notNull().default(70),
    gridOffsetX: real('grid_offset_x').notNull().default(0),
    gridOffsetY: real('grid_offset_y').notNull().default(0),
    gridVisible: integer('grid_visible', { mode: 'boolean' }).notNull().default(true),
    feetPerSquare: integer('feet_per_square').notNull().default(5),

    /** With vision off, everyone sees the whole map - the default for battle maps. */
    visionEnabled: integer('vision_enabled', { mode: 'boolean' }).notNull().default(false),
    /** Lights the whole scene regardless of token vision radius (daylight). */
    globalIllumination: integer('global_illumination', { mode: 'boolean' })
      .notNull()
      .default(true),
    darkness: real('darkness').notNull().default(0),
    /** Cosmetic overlay; has no mechanical effect. */
    weather: text('weather', { enum: ['none', 'rain', 'storm', 'snow', 'fog', 'ash'] })
      .notNull()
      .default('none'),
    weatherIntensity: real('weather_intensity').notNull().default(0.5),

    /**
     * Whether players may draw and ping on this scene. On by default - pointing
     * at the map is how a table talks - but the DM can close it while they are
     * describing something, or during a puzzle where the party scribbling over
     * the board gets in the way.
     */
    playerDrawing: integer('player_drawing', { mode: 'boolean' }).notNull().default(true),

    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: epoch('created_at'),
  },
  (t) => [index('scenes_campaign_idx').on(t.campaignId)],
);

/**
 * Token x/y/w/h are in GRID UNITS (fractional), never pixels, so recalibrating
 * a scene's grid never scrambles the board. A 4x4 token is Gargantuan.
 */
export const tokens = sqliteTable(
  'tokens',
  {
    id: id(),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default(''),
    imageUrl: text('image_url'),

    actorId: text('actor_id').references(() => actors.id, { onDelete: 'set null' }),
    /**
     * Linked tokens read and write HP straight through to the actor (player
     * characters). Unlinked tokens carry their own copy, so five goblins have
     * five independent HP pools.
     */
    actorLinked: integer('actor_linked', { mode: 'boolean' }).notNull().default(false),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),

    x: real('x').notNull().default(0),
    y: real('y').notNull().default(0),
    w: real('w').notNull().default(1),
    h: real('h').notNull().default(1),
    rotation: real('rotation').notNull().default(0),
    layer: text('layer', { enum: ['background', 'token', 'gm'] })
      .notNull()
      .default('token'),

    disposition: text('disposition', { enum: ['friendly', 'neutral', 'hostile'] })
      .notNull()
      .default('hostile'),
    visionRange: real('vision_range').notNull().default(0),
    darkvisionRange: real('darkvision_range').notNull().default(0),
    lightBright: real('light_bright').notNull().default(0),
    lightDim: real('light_dim').notNull().default(0),
    /** Torchlight is warm, a spell might not be. Cosmetic, like weather. */
    lightColor: text('light_color').notNull().default('#ffb46b'),

    hp: integer('hp'),
    maxHp: integer('max_hp'),
    ac: integer('ac'),
    conditions: text('conditions', { mode: 'json' }).$type<string[]>().notNull(),

    /** Hidden tokens are stripped from player payloads entirely, server-side. */
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
    locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
    createdAt: epoch('created_at'),
  },
  (t) => [index('tokens_scene_idx').on(t.sceneId)],
);

/**
 * Wall segments, in grid units. Never sent to player clients - wall geometry
 * is a map of the dungeon.
 */
export const walls = sqliteTable(
  'walls',
  {
    id: id(),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    x1: real('x1').notNull(),
    y1: real('y1').notNull(),
    x2: real('x2').notNull(),
    y2: real('y2').notNull(),
    /** 0 none, 1 blocks. */
    blocksMovement: integer('blocks_movement').notNull().default(1),
    /** 0 none, 1 blocks, 2 terrain (blocks only beyond one square). */
    blocksSight: integer('blocks_sight').notNull().default(1),
    blocksSound: integer('blocks_sound').notNull().default(0),
    /** 0 wall, 1 door, 2 secret door. */
    door: integer('door').notNull().default(0),
    /** 0 closed, 1 open, 2 locked. */
    doorState: integer('door_state').notNull().default(0),
  },
  (t) => [index('walls_scene_idx').on(t.sceneId)],
);

/**
 * Persistent per-player fog exploration, as a coarse bitmap of one bit per
 * grid square, base64-encoded. Unioning accumulated polygons would grow
 * without bound; a bitmap is fixed-size and merges with a bitwise OR.
 */
export const fogExploration = sqliteTable(
  'fog_exploration',
  {
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Bitmap width in grid squares, needed to decode the rows. */
    gridWidth: integer('grid_width').notNull().default(0),
    gridHeight: integer('grid_height').notNull().default(0),
    exploredBitmap: text('explored_bitmap').notNull().default(''),
    updatedAt: epoch('updated_at'),
  },
  (t) => [primaryKey({ columns: [t.sceneId, t.userId] })],
);

/** Spell area-of-effect templates placed on the map. */
export const templates = sqliteTable(
  'templates',
  {
    id: id(),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    shape: text('shape', { enum: ['circle', 'cone', 'ray', 'rect'] }).notNull(),
    x: real('x').notNull(),
    y: real('y').notNull(),
    /** Degrees, for cones and rays. */
    direction: real('direction').notNull().default(0),
    /** Length or radius, in feet. */
    distance: real('distance').notNull().default(0),
    angle: real('angle').notNull().default(53),
    width: real('width').notNull().default(0),
    color: text('color').notNull().default('#4a9eff'),
  },
  (t) => [index('templates_scene_idx').on(t.sceneId)],
);

/**
 * Freehand annotation on the map: terrain the map does not show, arrows for
 * "he ran that way", labels for improvised rooms.
 */
export const drawings = sqliteTable(
  'drawings',
  {
    id: id(),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['freehand', 'arrow', 'text'] })
      .notNull()
      .default('freehand'),
    /** Points in GRID UNITS, like everything else on the board. */
    points: text('points', { mode: 'json' }).$type<number[]>().notNull(),
    color: text('color').notNull().default('#e8853f'),
    text: text('text').notNull().default(''),
    width: real('width').notNull().default(3),
    createdAt: epoch('created_at'),
  },
  (t) => [index('drawings_scene_idx').on(t.sceneId)],
);

/* ------------------------------------------------------------------ chat */

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').references(() => actors.id, { onDelete: 'set null' }),
    kind: text('kind', { enum: ['text', 'roll', 'card', 'system'] })
      .notNull()
      .default('text'),
    body: text('body').notNull().default(''),
    rollData: text('roll_data', { mode: 'json' }).$type<RollResult | null>(),
    /** Item card payload: buttons for attack, damage, save. */
    cardData: text('card_data', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    whisperToUserId: text('whisper_to_user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: epoch('created_at'),
  },
  (t) => [index('chat_campaign_created_idx').on(t.campaignId, t.createdAt)],
);

/* ------------------------------------------------------------ encounters */

export const encounters = sqliteTable(
  'encounters',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    sceneId: text('scene_id').references(() => scenes.id, { onDelete: 'set null' }),
    round: integer('round').notNull().default(1),
    activeIndex: integer('active_index').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
    createdAt: epoch('created_at'),
  },
  (t) => [index('encounters_campaign_idx').on(t.campaignId)],
);

export const initiativeEntries = sqliteTable(
  'initiative_entries',
  {
    id: id(),
    encounterId: text('encounter_id')
      .notNull()
      .references(() => encounters.id, { onDelete: 'cascade' }),
    tokenId: text('token_id').references(() => tokens.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Fractional to allow DEX tiebreakers like 17.2. */
    initiative: real('initiative').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('initiative_encounter_idx').on(t.encounterId)],
);

/* -------------------------------------------------------- active effects */

/**
 * Buffs, debuffs and conditions. Applied by a pure derive function rather than
 * written into the actor, so they can always be removed cleanly.
 */
export const activeEffects = sqliteTable(
  'active_effects',
  {
    id: id(),
    ownerActorId: text('owner_actor_id').references(() => actors.id, { onDelete: 'cascade' }),
    ownerItemId: text('owner_item_id').references(() => items.id, { onDelete: 'cascade' }),
    ownerTokenId: text('owner_token_id').references(() => tokens.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icon: text('icon').notNull().default(''),
    changes: text('changes', { mode: 'json' }).$type<ActiveEffectInput['changes']>().notNull(),
    duration: text('duration', { mode: 'json' }).$type<ActiveEffectInput['duration']>().notNull(),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    transfer: integer('transfer', { mode: 'boolean' }).notNull().default(true),
    statusId: text('status_id'),
  },
  (t) => [
    index('effects_actor_idx').on(t.ownerActorId),
    index('effects_token_idx').on(t.ownerTokenId),
  ],
);

/* ----------------------------------------------------------------- audio */

export const playlists = sqliteTable(
  'playlists',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mode: text('mode', { enum: ['sequential', 'shuffle', 'simultaneous'] })
      .notNull()
      .default('sequential'),
    /** Marking one as combat music lets an encounter switch to it by itself. */
    role: text('role', { enum: ['none', 'combat'] })
      .notNull()
      .default('none'),
    fadeMs: integer('fade_ms').notNull().default(1500),
    createdAt: epoch('created_at'),
  },
  (t) => [index('playlists_campaign_idx').on(t.campaignId)],
);

export const playlistTracks = sqliteTable(
  'playlist_tracks',
  {
    id: id(),
    playlistId: text('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    fileUrl: text('file_url').notNull(),
    volume: real('volume').notNull().default(0.7),
    loop: integer('loop', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('playlist_tracks_playlist_idx').on(t.playlistId)],
);

/**
 * Positional audio emitters. The client computes falloff from its own tokens'
 * distance, which is why volume is not synced from the server.
 */
export const ambientSounds = sqliteTable(
  'ambient_sounds',
  {
    id: id(),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default(''),
    fileUrl: text('file_url').notNull(),
    x: real('x').notNull(),
    y: real('y').notNull(),
    /** Audible radius in grid units. */
    radius: real('radius').notNull().default(10),
    volume: real('volume').notNull().default(0.7),
    /** Whether walls muffle this sound. */
    blockedByWalls: integer('blocked_by_walls', { mode: 'boolean' }).notNull().default(true),
    easing: integer('easing', { mode: 'boolean' }).notNull().default(true),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('ambient_sounds_scene_idx').on(t.sceneId)],
);

/** One row per campaign, tracking what the DM is currently playing. */
export const audioState = sqliteTable('audio_state', {
  campaignId: text('campaign_id')
    .primaryKey()
    .references(() => campaigns.id, { onDelete: 'cascade' }),
  playlistId: text('playlist_id').references(() => playlists.id, { onDelete: 'set null' }),
  trackId: text('track_id').references(() => playlistTracks.id, { onDelete: 'set null' }),
  playing: integer('playing', { mode: 'boolean' }).notNull().default(false),
  /** Server epoch ms; clients derive their own seek offset from this. */
  startedAt: integer('started_at'),
  volume: real('volume').notNull().default(0.6),
  /** What to go back to when combat ends. */
  resumePlaylistId: text('resume_playlist_id'),
  resumeTrackId: text('resume_track_id'),
});

/* --------------------------------------------------------------- journal */

export const journalEntries = sqliteTable(
  'journal_entries',
  {
    id: id(),
    campaignId: text('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /**
     * Whether the party can read this. Stored rather than inferred from
     * ownership grants: a campaign the DM has not filled yet has no other
     * members to grant to, so the grant-counting version reported every entry
     * as unshared and the show button snapped straight back.
     */
    shared: integer('shared', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: epoch('created_at'),
  },
  (t) => [index('journal_campaign_idx').on(t.campaignId)],
);

export const journalPages = sqliteTable(
  'journal_pages',
  {
    id: id(),
    entryId: text('entry_id')
      .notNull()
      .references(() => journalEntries.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    type: text('type', { enum: ['text', 'image', 'pdf'] })
      .notNull()
      .default('text'),
    bodyMarkdown: text('body_markdown').notNull().default(''),
    fileUrl: text('file_url'),
    sortOrder: integer('sort_order').notNull().default(0),
    updatedAt: epoch('updated_at'),
  },
  (t) => [index('journal_pages_entry_idx').on(t.entryId)],
);

/** Map pins that open a journal page. */
export const mapNotes = sqliteTable(
  'map_notes',
  {
    id: id(),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    journalPageId: text('journal_page_id').references(() => journalPages.id, {
      onDelete: 'cascade',
    }),
    label: text('label').notNull().default(''),
    icon: text('icon').notNull().default('pin'),
    x: real('x').notNull(),
    y: real('y').notNull(),
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [index('map_notes_scene_idx').on(t.sceneId)],
);

/* ------------------------------------------------------------------- SRD */

export const srdSpells = sqliteTable(
  'srd_spells',
  {
    id: id(),
    ruleset: text('ruleset', { enum: ['2014', '2024'] })
      .notNull()
      .default('2014'),
    name: text('name').notNull(),
    level: integer('level').notNull(),
    school: text('school').notNull().default(''),
    castingTime: text('casting_time').notNull().default(''),
    range: text('range').notNull().default(''),
    components: text('components').notNull().default(''),
    duration: text('duration').notNull().default(''),
    concentration: integer('concentration', { mode: 'boolean' }).notNull().default(false),
    ritual: integer('ritual', { mode: 'boolean' }).notNull().default(false),
    description: text('description').notNull().default(''),
    higherLevel: text('higher_level').notNull().default(''),
    classes: text('classes', { mode: 'json' }).$type<string[]>().notNull(),
    /** Pre-parsed into the Item spell system shape, ready to attach to a sheet. */
    system: text('system', { mode: 'json' }).$type<ItemSystem>().notNull(),
  },
  (t) => [index('srd_spells_level_idx').on(t.level), index('srd_spells_name_idx').on(t.name)],
);

export const srdMonsters = sqliteTable(
  'srd_monsters',
  {
    id: id(),
    ruleset: text('ruleset', { enum: ['2014', '2024'] })
      .notNull()
      .default('2014'),
    name: text('name').notNull(),
    size: text('size').notNull().default(''),
    type: text('type').notNull().default(''),
    alignment: text('alignment').notNull().default(''),
    armorClass: integer('armor_class').notNull().default(10),
    hitPoints: integer('hit_points').notNull().default(1),
    hitDice: text('hit_dice').notNull().default(''),
    speed: text('speed').notNull().default(''),
    str: integer('str').notNull().default(10),
    dex: integer('dex').notNull().default(10),
    con: integer('con').notNull().default(10),
    int: integer('int').notNull().default(10),
    wis: integer('wis').notNull().default(10),
    cha: integer('cha').notNull().default(10),
    challengeRating: text('challenge_rating').notNull().default('0'),
    xp: integer('xp').notNull().default(0),
    /** Token footprint in grid units, derived from `size` on import. */
    tokenSize: real('token_size').notNull().default(1),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index('srd_monsters_name_idx').on(t.name), index('srd_monsters_cr_idx').on(t.challengeRating)],
);

export const srdItems = sqliteTable(
  'srd_items',
  {
    id: id(),
    ruleset: text('ruleset', { enum: ['2014', '2024'] })
      .notNull()
      .default('2014'),
    name: text('name').notNull(),
    category: text('category').notNull().default(''),
    itemType: text('item_type').notNull().default('equipment'),
    cost: text('cost').notNull().default(''),
    weight: real('weight').notNull().default(0),
    description: text('description').notNull().default(''),
    system: text('system', { mode: 'json' }).$type<ItemSystem>().notNull(),
  },
  (t) => [index('srd_items_name_idx').on(t.name)],
);

/* ----------------------------------------------------------------- types */

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignMember = typeof campaignMembers.$inferSelect;
export type Actor = typeof actors.$inferSelect;
export type Item = typeof items.$inferSelect;
export type Ownership = typeof ownership.$inferSelect;
export type Scene = typeof scenes.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type Wall = typeof walls.$inferSelect;
export type FogExploration = typeof fogExploration.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type Encounter = typeof encounters.$inferSelect;
export type InitiativeEntry = typeof initiativeEntries.$inferSelect;
export type ActiveEffect = typeof activeEffects.$inferSelect;
export type Playlist = typeof playlists.$inferSelect;
export type PlaylistTrack = typeof playlistTracks.$inferSelect;
export type AmbientSound = typeof ambientSounds.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type JournalPage = typeof journalPages.$inferSelect;
export type MapNote = typeof mapNotes.$inferSelect;
export type Drawing = typeof drawings.$inferSelect;
export type SrdSpell = typeof srdSpells.$inferSelect;
export type SrdMonster = typeof srdMonsters.$inferSelect;
export type SrdItem = typeof srdItems.$inferSelect;
