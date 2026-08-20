import { and, asc, desc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import {
  encounterDifficulty,
  howManyFit,
  itemCategorySchema,
  itemTypeSchema,
  parseItemSystem,
  partyThresholds,
} from '@dnd/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import {
  actorCampaigns,
  actors,
  campaignMembers,
  items,
  srdItems,
  srdMonsters,
  srdSpells,
} from '../db/schema.js';
import { HttpError, assertUser, requireAuth } from '../auth/guards.js';
import { requireActorRead, requireActorWrite } from '../lib/access.js';
import { newId } from '../lib/id.js';
import type { ItemCategory, ItemType } from '@dnd/shared';

const createSchema = z.object({
  type: itemTypeSchema,
  name: z.string().min(1).max(80),
  imageUrl: z.string().max(500).nullable().default(null),
  system: z.unknown().optional(),
  sortOrder: z.number().int().default(0),
});

/**
 * Maps a browsable category onto the SRD's own category strings.
 *
 * Those strings are inconsistent by source, not by our doing - "Weapon" and
 * "Weapons", "Ring" and "Rings", "Staff" and "Staffs" all appear, because the
 * 2014 and 2024 datasets name their shelves differently. Matching on substrings
 * here means the mess is confined to one function next to the data, rather than
 * leaking into a dropdown the player has to read.
 */
function categoryFilter(category: ItemCategory): SQL {
  /**
   * Matches a needle at the start of a word, not anywhere in the string.
   *
   * A bare `%ring%` puts every piece of adventu-RING gear in the magic ring
   * drawer. Padding the category with spaces and requiring one before the
   * needle fixes that while still catching plurals, which is the reason the
   * match is not exact in the first place: the shelf is "Ring" in one dataset
   * and "Rings" in the other.
   */
  const anyOf = (...needles: string[]) =>
    or(
      ...needles.map(
        (n) => sql`' ' || lower(${srdItems.category}) || ' ' like ${`% ${n}%`}`,
      ),
    )!;

  switch (category) {
    // Weapons are the one group the importer already types reliably.
    case 'weapon':
      return eq(srdItems.itemType, 'weapon');
    case 'armor':
      return anyOf('armor', 'armour', 'shield');
    case 'gear':
      return anyOf('gear', 'ammunition', 'equipment pack');
    case 'tools':
      return anyOf('tool', 'instrument', 'gaming', 'foci', 'focus', 'kit');
    case 'consumable':
      return anyOf('potion', 'scroll');
    case 'magic':
      return anyOf('wondrous', 'ring', 'wand', 'staff', 'rod');
    case 'vehicle':
      return anyOf('mount', 'vehicle', 'tack', 'harness');
  }
}

export async function itemRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /* ------------------------------------------------------- actor's items */

  app.get('/api/actors/:actorId/items', async (request) => {
    const user = assertUser(request);
    const { actorId } = request.params as { actorId: string };
    await requireActorRead(actorId, user.id);

    const rows = await db
      .select()
      .from(items)
      .where(eq(items.ownerActorId, actorId))
      .orderBy(asc(items.sortOrder), asc(items.name));

    return { items: rows };
  });

  app.post('/api/actors/:actorId/items', async (request) => {
    const user = assertUser(request);
    const { actorId } = request.params as { actorId: string };
    await requireActorWrite(actorId, user.id);

    const input = createSchema.parse(request.body);

    const item = {
      id: newId(),
      ownerActorId: actorId,
      campaignId: null,
      type: input.type,
      name: input.name,
      imageUrl: input.imageUrl,
      // Validated against the schema for this item's declared type, so `system`
      // is never an arbitrary blob.
      system: parseItemSystem(input.type, input.system),
      sortOrder: input.sortOrder,
      createdAt: Date.now(),
    };

    await db.insert(items).values(item);
    return { item };
  });

  app.patch('/api/items/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(items).where(eq(items.id, id)).limit(1);
    const existing = rows[0];
    if (!existing?.ownerActorId) throw new HttpError(404, 'Item not found');
    await requireActorWrite(existing.ownerActorId, user.id);

    const patch = z
      .object({
        name: z.string().min(1).max(80).optional(),
        imageUrl: z.string().max(500).nullable().optional(),
        system: z.unknown().optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(request.body);

    // Every field is optional, so an empty body would reach .set({}), which
    // Drizzle throws on - a 500 for a request that should simply do nothing.
    if (Object.keys(patch).length === 0) return { item: existing };

    await db
      .update(items)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.imageUrl !== undefined ? { imageUrl: patch.imageUrl } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        // Merge rather than replace, so a partial update cannot silently drop
        // fields the client did not send.
        ...(patch.system !== undefined
          ? {
              system: parseItemSystem(existing.type as ItemType, {
                ...(existing.system as object),
                ...(patch.system as object),
              }),
            }
          : {}),
      })
      .where(eq(items.id, id));

    const updated = await db.select().from(items).where(eq(items.id, id)).limit(1);
    return { item: updated[0] };
  });

  app.delete('/api/items/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };

    const rows = await db.select().from(items).where(eq(items.id, id)).limit(1);
    const existing = rows[0];
    if (!existing?.ownerActorId) throw new HttpError(404, 'Item not found');
    await requireActorWrite(existing.ownerActorId, user.id);

    await db.delete(items).where(eq(items.id, id));
    return { ok: true };
  });

  /* ------------------------------------------- granting from the compendium */

  /**
   * Copies a compendium entry onto a sheet. The SRD rows already store their
   * `system` in Item shape, so this is a copy rather than a conversion - which
   * is the payoff of pre-parsing at import time.
   */
  app.post('/api/actors/:actorId/items/from-srd', async (request) => {
    const user = assertUser(request);
    const { actorId } = request.params as { actorId: string };
    await requireActorWrite(actorId, user.id);

    const { kind, srdId } = z
      .object({ kind: z.enum(['spell', 'item']), srdId: z.string() })
      .parse(request.body);

    let name: string;
    let type: ItemType;
    let system: unknown;

    if (kind === 'spell') {
      const found = await db.select().from(srdSpells).where(eq(srdSpells.id, srdId)).limit(1);
      if (!found[0]) throw new HttpError(404, 'Spell not found');
      name = found[0].name;
      type = 'spell';
      system = found[0].system;
    } else {
      const found = await db.select().from(srdItems).where(eq(srdItems.id, srdId)).limit(1);
      if (!found[0]) throw new HttpError(404, 'Item not found');
      name = found[0].name;
      type = found[0].itemType as ItemType;
      system = found[0].system;
    }

    const item = {
      id: newId(),
      ownerActorId: actorId,
      campaignId: null,
      type,
      name,
      imageUrl: null,
      system: parseItemSystem(type, system),
      sortOrder: 0,
      createdAt: Date.now(),
    };

    await db.insert(items).values(item);
    return { item };
  });

  /* ------------------------------------------------------------ compendium */

  app.get('/api/compendium/spells', async (request) => {
    const query = z
      .object({
        q: z.string().max(80).optional(),
        level: z.coerce.number().int().min(0).max(9).optional(),
        class: z.string().max(30).optional(),
        school: z.string().max(30).optional(),
        ruleset: z.enum(['2014', '2024']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
        offset: z.coerce.number().int().min(0).max(5000).default(0),
      })
      .parse(request.query);

    const filters = [];
    if (query.q) filters.push(like(srdSpells.name, `%${query.q}%`));
    if (query.level !== undefined) filters.push(eq(srdSpells.level, query.level));
    // classes is a JSON array; match it as text rather than joining a table.
    if (query.class) filters.push(sql`lower(${srdSpells.classes}) like ${`%${query.class.toLowerCase()}%`}`);
    if (query.school) filters.push(sql`lower(${srdSpells.school}) = ${query.school.toLowerCase()}`);
    // 2024 spells are not published, so a 2024 campaign still gets the 2014
    // list rather than an empty one.
    filters.push(eq(srdSpells.ruleset, '2014'));

    const rows = await db
      .select({
        id: srdSpells.id,
        name: srdSpells.name,
        level: srdSpells.level,
        school: srdSpells.school,
        castingTime: srdSpells.castingTime,
        range: srdSpells.range,
        duration: srdSpells.duration,
        concentration: srdSpells.concentration,
        ritual: srdSpells.ritual,
        classes: srdSpells.classes,
      })
      .from(srdSpells)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(srdSpells.level), asc(srdSpells.name))
      .limit(query.limit)
      .offset(query.offset);

    // A short page is the end of the list; the client stops offering "more"
    // rather than issuing a request that comes back empty.
    return { spells: rows, more: rows.length === query.limit };
  });

  app.get('/api/compendium/items', async (request) => {
    const query = z
      .object({
        q: z.string().max(80).optional(),
        category: itemCategorySchema.optional(),
        ruleset: z.enum(['2014', '2024']).default('2014'),
        limit: z.coerce.number().int().min(1).max(200).default(60),
        offset: z.coerce.number().int().min(0).max(5000).default(0),
      })
      .parse(request.query);

    const filters = [eq(srdItems.ruleset, query.ruleset)];
    if (query.q) filters.push(like(srdItems.name, `%${query.q}%`));
    if (query.category) filters.push(categoryFilter(query.category));

    const rows = await db
      .select({
        id: srdItems.id,
        name: srdItems.name,
        category: srdItems.category,
        itemType: srdItems.itemType,
        cost: srdItems.cost,
        weight: srdItems.weight,
        system: srdItems.system,
      })
      .from(srdItems)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(srdItems.name))
      .limit(query.limit)
      .offset(query.offset);

    return { items: rows, more: rows.length === query.limit };
  });

  /**
   * The bestiary.
   *
   * Paged like spells and items: without `offset` and `more` the browser showed
   * the first 60 of 337 and had no way to know, let alone say, that the rest
   * existed. There is no `ruleset` filter on purpose - only three 2024 monsters
   * are published, so both editions are always offered.
   */
  app.get('/api/compendium/monsters', async (request) => {
    const query = z
      .object({
        q: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
        offset: z.coerce.number().int().min(0).max(5000).default(0),
      })
      .parse(request.query);

    const rows = await db
      .select({
        id: srdMonsters.id,
        ruleset: srdMonsters.ruleset,
        name: srdMonsters.name,
        size: srdMonsters.size,
        type: srdMonsters.type,
        armorClass: srdMonsters.armorClass,
        hitPoints: srdMonsters.hitPoints,
        challengeRating: srdMonsters.challengeRating,
        tokenSize: srdMonsters.tokenSize,
        imageUrl: srdMonsters.imageUrl,
      })
      .from(srdMonsters)
      .where(query.q ? like(srdMonsters.name, `%${query.q}%`) : undefined)
      .orderBy(asc(srdMonsters.name))
      .limit(query.limit)
      .offset(query.offset);

    return { monsters: rows, more: rows.length === query.limit };
  });

  /**
   * What to throw at this party, from the bestiary, at a difficulty you name.
   *
   * The question a DM has in front of a list of 337 monsters is never "is one
   * ogre hard" - it is "what fits tonight", and answering it by hand means the
   * DMG's threshold table, its multiplier table, and arithmetic per creature.
   *
   * The party is read from the campaign rather than taken from the client: it
   * is the campaign's characters and their levels, which the server already
   * knows and a browser has no business asserting. DM-only, because the
   * bestiary is prep - and because the suggestion names creatures the players
   * have not met.
   *
   * `count` is the answer, not the question. A creature is offered at a
   * difficulty if *some* number of them lands there, and the number is what
   * gets shown: "Goblin x7" is useful where "Goblin, medium" is a riddle.
   */
  app.get('/api/campaigns/:campaignId/encounter-suggestions', async (request) => {
    const user = assertUser(request);
    const { campaignId } = request.params as { campaignId: string };

    const membership = await db
      .select({ role: campaignMembers.role })
      .from(campaignMembers)
      .where(
        and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, user.id)),
      )
      .limit(1);

    if (membership[0]?.role !== 'dm') {
      throw new HttpError(403, 'Only the DM can build encounters');
    }

    const query = z
      .object({
        difficulty: z.enum(['easy', 'medium', 'hard', 'deadly']).default('medium'),
        limit: z.coerce.number().int().min(1).max(60).default(24),
      })
      .parse(request.query);

    const party = await db
      .select({ level: actors.level, name: actors.name })
      .from(actorCampaigns)
      .innerJoin(actors, eq(actorCampaigns.actorId, actors.id))
      .where(and(eq(actorCampaigns.campaignId, campaignId), eq(actors.type, 'character')));

    if (party.length === 0) {
      // Said rather than guessed at. A default party of four level ones would
      // be a confident recommendation about a table that does not exist.
      return { party: [], thresholds: null, suggestions: [] };
    }

    const thresholds = partyThresholds(party.map((row) => row.level));

    const rows = await db
      .select({
        id: srdMonsters.id,
        name: srdMonsters.name,
        type: srdMonsters.type,
        challengeRating: srdMonsters.challengeRating,
        xp: srdMonsters.xp,
        hitPoints: srdMonsters.hitPoints,
        armorClass: srdMonsters.armorClass,
        tokenSize: srdMonsters.tokenSize,
        imageUrl: srdMonsters.imageUrl,
      })
      .from(srdMonsters)
      .where(sql`${srdMonsters.xp} > 0`)
      .orderBy(desc(srdMonsters.xp));

    const suggestions = rows
      .map((monster) => {
        const count = howManyFit(monster.xp, thresholds, query.difficulty);
        if (count === 0) return null;

        // Only creatures that actually LAND on the difficulty asked for. A rat
        // fits under "hard" a thousand at a time, and offering it would bury
        // every real answer under vermin.
        const { difficulty, adjustedXp } = encounterDifficulty(
          Array(count).fill(monster.xp),
          thresholds,
        );
        if (difficulty !== query.difficulty) return null;

        return { ...monster, count, adjustedXp };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      // Fewest creatures first: one thing worth fighting reads better than
      // twelve of something, and the DM can scroll for a horde.
      .sort((a, b) => a.count - b.count || b.xp - a.xp)
      .slice(0, query.limit);

    return {
      party: party.map((row) => ({ name: row.name, level: row.level })),
      thresholds,
      suggestions,
    };
  });

  app.get('/api/compendium/monsters/:id', async (request) => {
    const { id } = request.params as { id: string };
    const rows = await db.select().from(srdMonsters).where(eq(srdMonsters.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Monster not found');
    return { monster: rows[0] };
  });
}
