import { and, asc, desc, eq, like, or, sql } from 'drizzle-orm';
import { itemTypeSchema, parseItemSystem } from '@dnd/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { items, srdItems, srdMonsters, srdSpells } from '../db/schema.js';
import { HttpError, assertUser, requireAuth } from '../auth/guards.js';
import { requireActorRead, requireActorWrite } from '../lib/access.js';
import { newId } from '../lib/id.js';
import type { ItemType } from '@dnd/shared';

const createSchema = z.object({
  type: itemTypeSchema,
  name: z.string().min(1).max(80),
  imageUrl: z.string().max(500).nullable().default(null),
  system: z.unknown().optional(),
  sortOrder: z.number().int().default(0),
});

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
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .parse(request.query);

    const filters = [];
    if (query.q) filters.push(like(srdSpells.name, `%${query.q}%`));
    if (query.level !== undefined) filters.push(eq(srdSpells.level, query.level));
    // classes is a JSON array; match it as text rather than joining a table.
    if (query.class) filters.push(sql`lower(${srdSpells.classes}) like ${`%${query.class.toLowerCase()}%`}`);

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
      .limit(query.limit);

    return { spells: rows };
  });

  app.get('/api/compendium/spells/:id', async (request) => {
    const { id } = request.params as { id: string };
    const rows = await db.select().from(srdSpells).where(eq(srdSpells.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Spell not found');
    return { spell: rows[0] };
  });

  app.get('/api/compendium/items', async (request) => {
    const query = z
      .object({
        q: z.string().max(80).optional(),
        type: z.string().max(30).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .parse(request.query);

    const filters = [];
    if (query.q) filters.push(like(srdItems.name, `%${query.q}%`));
    if (query.type) filters.push(eq(srdItems.itemType, query.type));

    const rows = await db
      .select({
        id: srdItems.id,
        name: srdItems.name,
        category: srdItems.category,
        itemType: srdItems.itemType,
        cost: srdItems.cost,
        weight: srdItems.weight,
      })
      .from(srdItems)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(srdItems.name))
      .limit(query.limit);

    return { items: rows };
  });

  app.get('/api/compendium/monsters', async (request) => {
    const query = z
      .object({
        q: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(60),
      })
      .parse(request.query);

    const rows = await db
      .select({
        id: srdMonsters.id,
        name: srdMonsters.name,
        size: srdMonsters.size,
        type: srdMonsters.type,
        armorClass: srdMonsters.armorClass,
        hitPoints: srdMonsters.hitPoints,
        challengeRating: srdMonsters.challengeRating,
        tokenSize: srdMonsters.tokenSize,
      })
      .from(srdMonsters)
      .where(query.q ? like(srdMonsters.name, `%${query.q}%`) : undefined)
      .orderBy(asc(srdMonsters.name))
      .limit(query.limit);

    return { monsters: rows };
  });

  app.get('/api/compendium/monsters/:id', async (request) => {
    const { id } = request.params as { id: string };
    const rows = await db.select().from(srdMonsters).where(eq(srdMonsters.id, id)).limit(1);
    if (!rows[0]) throw new HttpError(404, 'Monster not found');
    return { monster: rows[0] };
  });
}
