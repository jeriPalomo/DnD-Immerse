import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import {
  ABILITIES,
  ABILITY_ROLL,
  OWNERSHIP,
  abilityModifier,
  actorInputSchema,
  applyRest,
  classInfo,
  emptyActor,
  hitPointsForLevel,
  hitPointsGained,
  levelGains,
  ownershipLevelSchema,
  parseHitDicePool,
  parseItemSystem,
} from '@dnd/shared';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import {
  actorCampaigns,
  actors,
  campaignMembers,
  campaigns,
  items,
  actorSubclassFeatures,
  ownership,
  srdClassLevels,
  srdFeatures,
  srdMonsters,
  srdTraits,
} from '../db/schema.js';
import type { Actor } from '../db/schema.js';
import { campaignAllowsStats, mayReadStats, tokenIn } from '../realtime/scene.js';
import { HttpError, assertUser, requireAuth, requireDM, requireMembership } from '../auth/guards.js';
import { readCharacterPdf } from '../lib/sheetPdf.js';
import { getActorAccess, getBulkActorAccess, requireActorRead, requireActorWrite } from '../lib/access.js';
import { rollExpression } from '../lib/dice.js';
import { newId } from '../lib/id.js';
import { syncLinkedTokens } from '../lib/linkedTokens.js';
import { itemNumbers } from '../lib/itemNumbers.js';
import { itemsFromMonster } from '../lib/monsterItems.js';
import { storeImage } from '../lib/uploads.js';
import { deleteOrphanedUploads } from '../lib/orphans.js';
import type { ActorInput } from '@dnd/shared';

/** Maps a validated ActorInput onto the column set the table expects. */
function toRow(input: ActorInput) {
  const { skillProficiencies, saveProficiencies, spellSlots, currency, damageModifiers, prototypeToken, ...rest } =
    input;
  return {
    ...rest,
    skillProficiencies,
    saveProficiencies,
    spellSlots,
    currency,
    damageModifiers,
    prototypeToken,
  };
}

/**
 * Creates an NPC from a compendium row.
 *
 * Shared by the `from-monster` route and by `npm run seed`, because the seed
 * used to build one of these by hand and drifted: its NPCs arrived with no
 * portrait, no `srdMonsterId` and - worst - **no actions at all**, which is
 * precisely the state the stamping was written to fix. A DM poking at the demo
 * met a goblin with an empty attack table and an editable stat block, and
 * learned the opposite of how the app behaves.
 *
 * Anything that creates a creature from the bestiary belongs here rather than
 * beside here.
 */
export async function stampMonster(
  monster: typeof srdMonsters.$inferSelect,
  campaignId: string,
  ownerUserId: string,
): Promise<typeof actors.$inferSelect> {
  const input = actorInputSchema.parse({
    ...emptyActor(monster.name, 'npc'),
    name: monster.name,
    type: 'npc',
    str: monster.str,
    dex: monster.dex,
    con: monster.con,
    int: monster.int,
    wis: monster.wis,
    cha: monster.cha,
    armorClass: monster.armorClass,
    hpCurrent: monster.hitPoints,
    hpMax: monster.hitPoints,
    hitDiceTotal: monster.hitDice,
    challengeRating: monster.challengeRating,
    race: monster.type,
    alignment: monster.alignment,
    // Bestiary art, where upstream published any. This is a `/srd-images/`
    // URL shared by every copy of the monster, not an upload - deleting one
    // goblin must not take the goblin picture away from the other four.
    portraitUrl: monster.imageUrl,
    // Monsters are unlinked so each copy tracks its own HP, and sized from
    // the stat block: a Gargantuan dragon lands as a 4x4 token.
    prototypeToken: {
      // No `imageUrl` here on purpose: `token:create` stamps board art from
      // `actor.portraitUrl`, and nothing has ever read the prototype's own
      // image. Setting it would be a value with no reader, and one that a
      // later portrait upload could never override.
      w: monster.tokenSize,
      h: monster.tokenSize,
      actorLinked: false,
      disposition: 'hostile',
    },
  });

  const actor = {
    id: newId(),
    ownerUserId,
    campaignId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...toRow(input),
    // Set here rather than through `actorInputSchema`: this is provenance the
    // server knows, not a field a client may claim. Routing it through the
    // input schema would let anyone POST an actor asserting it is an ancient
    // dragon's stat block.
    srdMonsterId: monster.id,
  };

  await db.insert(actors).values(actor);
  await db.insert(actorCampaigns).values({ actorId: actor.id, campaignId, assignedAt: Date.now() });

  // Its attacks, traits and legendary actions. Without these the NPC arrives
  // with an empty attack table and the DM rolls a goblin's scimitar by hand
  // off a stat block the app would not show them.
  const stamped = itemsFromMonster(monster.data as Record<string, unknown>, monster.str);
  if (stamped.length > 0) {
    await db.insert(items).values(
      stamped.map((entry, index) => ({
        id: newId(),
        ownerActorId: actor.id,
        campaignId: null,
        type: entry.type,
        name: entry.name,
        imageUrl: null,
        // Validated like every other item write, so a malformed action in the
        // compendium fails here rather than at the first attack roll.
        system: parseItemSystem(entry.type, entry.system),
        sortOrder: index,
        createdAt: Date.now(),
      })),
    );
  }

  return actor as typeof actors.$inferSelect;
}

export async function actorRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  /* -------------------------------------------------------------- roster */

  /** Every actor the signed-in user personally owns. */
  app.get('/api/actors', async (request) => {
    const user = assertUser(request);

    const rows = await db
      .select()
      .from(actors)
      .where(eq(actors.ownerUserId, user.id))
      .orderBy(asc(actors.name));

    const assignments =
      rows.length === 0
        ? []
        : await db
            .select({ actorId: actorCampaigns.actorId, campaignId: actorCampaigns.campaignId, name: campaigns.name })
            .from(actorCampaigns)
            .innerJoin(campaigns, eq(actorCampaigns.campaignId, campaigns.id))
            .where(inArray(actorCampaigns.actorId, rows.map((r) => r.id)));

    return {
      actors: rows.map((actor) => ({
        ...actor,
        campaigns: assignments
          .filter((a) => a.actorId === actor.id)
          .map((a) => ({ id: a.campaignId, name: a.name })),
      })),
    };
  });

  /** The party roster for a campaign, filtered by what the viewer may see. */
  app.get('/api/campaigns/:campaignId/actors', async (request) => {
    const user = assertUser(request);
    const { campaignId } = request.params as { campaignId: string };
    const membership = await requireMembership(campaignId, user.id);

    const rows = await db
      .select({ actor: actors })
      .from(actorCampaigns)
      .innerJoin(actors, eq(actorCampaigns.actorId, actors.id))
      .where(eq(actorCampaigns.campaignId, campaignId))
      .orderBy(asc(actors.name));

    if (membership.isDM) {
      return { actors: rows.map((r) => ({ ...r.actor, access: OWNERSHIP.owner })) };
    }

    const dmCampaigns = new Set<string>();
    const levels = await getBulkActorAccess(rows.map((r) => r.actor.id), user.id, dmCampaigns);

    // Players see their own sheets in full, other player characters at name
    // level, and NPCs not at all.
    //
    // NPCs default to `none` rather than `limited` because a roster listing
    // "Ancient Red Dragon" spoils the encounter before the party has met it -
    // the name alone is the leak, even with every stat hidden. The DM shares an
    // NPC deliberately, by granting ownership.
    const visible = rows.filter(({ actor }) => {
      const level = levels.get(actor.id) ?? OWNERSHIP.none;
      return actor.type === 'character' || level >= OWNERSHIP.limited;
    });

    return {
      actors: visible.map(({ actor }) => {
        const level = levels.get(actor.id) ?? OWNERSHIP.limited;
        if (level >= OWNERSHIP.observer) return { ...actor, access: level };
        return {
          id: actor.id,
          name: actor.name,
          portraitUrl: actor.portraitUrl,
          type: actor.type,
          className: actor.className,
          level: actor.level,
          access: OWNERSHIP.limited,
        };
      }),
    };
  });

  /* ------------------------------------------------------------- read/write */

  app.get('/api/actors/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor, level } = await requireActorRead(id, user.id);

    const ownedItems = await db
      .select()
      .from(items)
      .where(eq(items.ownerActorId, id))
      .orderBy(asc(items.sortOrder), asc(items.name));

    // `ruleset` travels so the sheet's compendium picker offers the edition the
    // campaign actually plays - it used to browse 2014 equipment regardless.
    const assignments = await db
      .select({ id: campaigns.id, name: campaigns.name, ruleset: campaigns.ruleset })
      .from(actorCampaigns)
      .innerJoin(campaigns, eq(actorCampaigns.campaignId, campaigns.id))
      .where(eq(actorCampaigns.actorId, id));

    // Who this sheet is shared with, so the sharing control can show the
    // truth rather than assume nothing has been granted.
    const grants = await db
      .select({ userId: ownership.userId, level: ownership.level })
      .from(ownership)
      .where(and(eq(ownership.documentType, 'actor'), eq(ownership.documentId, id)));

    // What this sheet's subclass grants, if somebody wrote it down. Travels
    // with the sheet like items do, so the editor has it without a second
    // request - and so the panel and the editor read one answer.
    const subclassFeatures = await db
      .select({
        subclassName: actorSubclassFeatures.subclassName,
        level: actorSubclassFeatures.level,
        name: actorSubclassFeatures.name,
        description: actorSubclassFeatures.description,
      })
      .from(actorSubclassFeatures)
      .where(eq(actorSubclassFeatures.actorId, id))
      .orderBy(asc(actorSubclassFeatures.level), asc(actorSubclassFeatures.sortOrder));

    /**
     * The subclass the compendium publishes for this class, so the field can
     * suggest the right spelling.
     *
     * Read from the data rather than a curated list because the editions
     * disagree: 2014 says "Berserker" where 2024 says "Path of the Berserker",
     * and a hardcoded name would be wrong for half the campaigns.
     */
    const published = actor.className
      ? await db
          .select({ name: srdFeatures.subclassName })
          .from(srdFeatures)
          .where(
            and(
              eq(srdFeatures.ruleset, assignments[0]?.ruleset ?? '2014'),
              eq(srdFeatures.className, actor.className),
              ne(srdFeatures.subclassName, ''),
            ),
          )
          .limit(1)
      : [];

    return {
      actor,
      items: ownedItems,
      campaigns: assignments,
      access: level,
      grants,
      subclassFeatures,
      publishedSubclass: published[0]?.name ?? null,
    };
  });

  app.post('/api/actors', async (request) => {
    const user = assertUser(request);
    const body = (request.body ?? {}) as Record<string, unknown>;

    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'New Character';
    const type = body.type === 'npc' ? 'npc' : 'character';
    const campaignId = typeof body.campaignId === 'string' ? body.campaignId : null;

    // An NPC is campaign content, and campaign content is the DM's. This was
    // the one creation path left open to players: tokens, scenes and
    // `from-monster` have always been DM-gated, so a player could not place an
    // NPC but could fill their own roster with them.
    //
    // Refused rather than quietly downgraded to a character. Silently making
    // something other than what was asked for is how you end up debugging a
    // report that a character "turned into" an NPC.
    if (type === 'npc') {
      if (!campaignId) throw new HttpError(400, 'An NPC needs a campaign');
      await requireDM(campaignId, user.id);
    }

    // Start from a fully defaulted sheet, then layer any supplied fields over it.
    const input = actorInputSchema.parse({ ...emptyActor(name, type), ...body, name, type });

    const actor = {
      id: newId(),
      ownerUserId: user.id,
      campaignId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...toRow(input),
    };

    await db.insert(actors).values(actor);
    return { actor };
  });

/**
 * What a bestiary sheet will not let you change.
 *
 * Its name, portrait and notes are yours - "Grix the goblin" is a perfectly
 * reasonable thing to write on a stamped goblin. The numbers are the
 * compendium's.
 *
 * **Hit points are not among them.** They are the one published figure the
 * handbook itself expects a DM to vary - every stat block gives hit dice
 * beside the average, and "this one is the chieftain's bodyguard on 12" is
 * ordinary play rather than a sheet disagreeing with the bestiary. The rest
 * change what the creature *is*: retyping a goblin's Dexterity leaves the sheet
 * claiming to be a goblin while every token stamped from the entry afterwards
 * still carries the published number.
 */
const STAT_BLOCK_FIELDS = [
  'str', 'dex', 'con', 'int', 'wis', 'cha',
  'armorClass', 'speed',
] as const;

  app.patch('/api/actors/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    const patch = actorInputSchema.partial().parse(request.body);

    // A stamped monster's numbers are the compendium's, not the DM's. Editing
    // them here would make the sheet disagree with the bestiary it came from
    // while still claiming to be that creature - and every token stamped from
    // it afterwards would carry the published numbers anyway. Refused rather
    // than dropped: a save that silently keeps the old value is a save that
    // looks like it worked.
    // A patch that writes all six scores is the roller being applied; that is
    // the moment the dice stop being available. Typing one score by hand is
    // not, so a sheet built by point-buy or the standard array is untouched.
    const rolledSet =
      !actor.abilitiesRolled &&
      (['str', 'dex', 'con', 'int', 'wis', 'cha'] as const).every(
        (key) => patch[key] !== undefined,
      );

    if (actor.srdMonsterId) {
      const locked = STAT_BLOCK_FIELDS.filter((field) => patch[field] !== undefined);
      if (locked.length > 0) {
        throw new HttpError(
          400,
          `${actor.name} came from the bestiary, so its stat block is the compendium's. Write an NPC by hand to change these.`,
        );
      }
    }

    await db
      .update(actors)
      .set({ ...patch, ...(rolledSet ? { abilitiesRolled: true } : {}), updatedAt: Date.now() })
      .where(eq(actors.id, id));

    // A linked token is the same creature as its sheet; keep the board in step.
    if (patch.hpCurrent !== undefined || patch.hpMax !== undefined || patch.armorClass !== undefined) {
      await syncLinkedTokens(app, id);
    }

    const rows = await db.select().from(actors).where(eq(actors.id, id)).limit(1);
    return { actor: rows[0] };
  });

  app.delete('/api/actors/:id', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    // Deleting someone else's character is the DM overstepping; only the
    // creator can destroy a sheet.
    if (actor.ownerUserId !== user.id) {
      throw new HttpError(403, 'Only the character owner can delete it');
    }

    await db.delete(actors).where(eq(actors.id, id));
    // Reference-checked, not deleted outright: `tokens.actorId` is `set null`,
    // so tokens stamped from this actor OUTLIVE it while still holding the
    // portrait they inherited. Deleting the file unconditionally left broken
    // images on every board the actor had ever appeared on.
    await deleteOrphanedUploads([actor.portraitUrl]);
    return { ok: true };
  });

  app.post('/api/actors/:id/portrait', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    await requireActorWrite(id, user.id);

    const file = await request.file();
    if (!file) throw new HttpError(400, 'No file uploaded');

    const stored = await storeImage(await file.toBuffer(), 'avatars', { maxDimension: 800 });

    const previous = await db.select({ url: actors.portraitUrl }).from(actors).where(eq(actors.id, id)).limit(1);
    await db.update(actors).set({ portraitUrl: stored.url }).where(eq(actors.id, id));
    // Replacing a portrait should not leave the old one on disk forever - but
    // tokens inherit that URL by value, so only remove it once nothing else
    // points at it.
    await deleteOrphanedUploads([previous[0]?.url ?? null]);

    return { portraitUrl: stored.url };
  });

  /**
   * Reads a filled-in character sheet PDF, and writes nothing.
   *
   * The answer is handed back for the player to look at and confirm, exactly as
   * the ability roller shows a set before it is kept. An import that wrote
   * straight to the sheet would be one bad parse away from replacing a
   * character somebody had spent an evening on, and the fields it gets wrong
   * are the ones nobody thinks to check.
   *
   * Applying is an ordinary PATCH afterwards, which means it goes through
   * `actorInputSchema` and the bestiary lock like every other edit.
   */
  app.post('/api/actors/:id/import-pdf', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    await requireActorWrite(id, user.id);

    const file = await request.file();
    if (!file) throw new HttpError(400, 'No file uploaded');

    const bytes = await file.toBuffer();
    // The same ceiling the uploads take, checked before parsing rather than
    // after: decoding twenty megabytes to discover it is twenty megabytes is
    // the expensive way round.
    if (bytes.byteLength > 20 * 1024 * 1024) {
      throw new HttpError(413, 'That file is too large (max 20MB)');
    }

    const found = await readCharacterPdf(bytes);
    return {
      values: found.values,
      unread: found.unread,
      fieldCount: found.fieldCount,
      read: Object.keys(found.values).length,
    };
  });

  /* -------------------------------------------------------- campaign assignment */

  app.post('/api/actors/:id/campaigns/:campaignId', async (request) => {
    const user = assertUser(request);
    const { id, campaignId } = request.params as { id: string; campaignId: string };

    const { actor } = await requireActorWrite(id, user.id);
    if (actor.ownerUserId !== user.id) {
      throw new HttpError(403, 'Only the character owner can bring it into a campaign');
    }
    // Assigning requires being in the campaign, not just owning the character.
    await requireMembership(campaignId, user.id);

    await db
      .insert(actorCampaigns)
      .values({ actorId: id, campaignId, assignedAt: Date.now() })
      .onConflictDoNothing();

    return { ok: true };
  });

  app.delete('/api/actors/:id/campaigns/:campaignId', async (request) => {
    const user = assertUser(request);
    const { id, campaignId } = request.params as { id: string; campaignId: string };
    await requireActorWrite(id, user.id);

    await db
      .delete(actorCampaigns)
      .where(and(eq(actorCampaigns.actorId, id), eq(actorCampaigns.campaignId, campaignId)));

    return { ok: true };
  });

  /* ------------------------------------------------------------- sharing */

  /** The DM grants a player visibility into a sheet they do not own. */
  app.put('/api/actors/:id/ownership/:userId', async (request) => {
    const user = assertUser(request);
    const { id, userId } = request.params as { id: string; userId: string };
    const { actor } = await requireActorWrite(id, user.id);

    const { level } = z.object({ level: ownershipLevelSchema }).parse(request.body);

    // The target must share a campaign with this actor, so sharing cannot leak
    // a sheet to an arbitrary account.
    const shared = await db
      .select({ campaignId: actorCampaigns.campaignId })
      .from(actorCampaigns)
      .innerJoin(campaignMembers, eq(actorCampaigns.campaignId, campaignMembers.campaignId))
      .where(and(eq(actorCampaigns.actorId, id), eq(campaignMembers.userId, userId)))
      .limit(1);

    if (shared.length === 0 && actor.ownerUserId !== userId) {
      throw new HttpError(400, 'That player is not in a campaign with this character');
    }

    if (level === OWNERSHIP.none) {
      await db
        .delete(ownership)
        .where(
          and(
            eq(ownership.documentType, 'actor'),
            eq(ownership.documentId, id),
            eq(ownership.userId, userId),
          ),
        );
    } else {
      await db
        .insert(ownership)
        .values({ documentType: 'actor', documentId: id, userId, level })
        .onConflictDoUpdate({
          target: [ownership.documentType, ownership.documentId, ownership.userId],
          set: { level },
        });
    }

    return { ok: true };
  });

  /**
   * Rests. Resolved here rather than on the client because hit dice are dice,
   * and every other die in the app is rolled on the server.
   */
  app.post('/api/actors/:id/rest', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    const input = z
      .object({
        type: z.enum(['short', 'long']),
        hitDiceSpent: z.number().int().min(0).max(20).default(0),
      })
      .parse(request.body);

    const owned = await db.select().from(items).where(eq(items.ownerActorId, id));
    const features = owned.map((item) => {
      const uses = (item.system as { uses?: { value: number; max: number; per: string } }).uses;
      return {
        id: item.id,
        name: item.name,
        uses: uses ? { value: uses.value, max: uses.max, per: uses.per as never } : null,
      };
    });

    // Roll the spent hit dice here, so the table sees real numbers.
    const pool = parseHitDicePool(actor.hitDiceTotal);
    const available = Math.max(0, pool.count - actor.hitDiceUsed);
    const spending = input.type === 'short' ? Math.min(input.hitDiceSpent, available) : 0;

    let healing = 0;
    const conMod = Math.floor((actor.con - 10) / 2);
    if (spending > 0 && pool.die > 0) {
      const roll = rollExpression(`${spending}d${pool.die}`, `${actor.name} hit dice`);
      // Constitution applies per die, and a die never heals less than one.
      healing = Math.max(spending, roll.total + conMod * spending);
    }

    const result = applyRest({
      actor: {
        level: actor.level,
        hpCurrent: actor.hpCurrent,
        hpMax: actor.hpMax,
        hpTemp: actor.hpTemp,
        hitDiceTotal: actor.hitDiceTotal,
        hitDiceUsed: actor.hitDiceUsed,
        spellSlots: actor.spellSlots,
      },
      features,
      type: input.type,
      hitDiceSpent: spending,
      hitDiceHealing: healing,
    });

    await db
      .update(actors)
      .set({
        hpCurrent: result.hpCurrent,
        hpTemp: result.hpTemp,
        hitDiceUsed: result.hitDiceUsed,
        spellSlots: result.spellSlots,
        updatedAt: Date.now(),
      })
      .where(eq(actors.id, id));

    await syncLinkedTokens(app, id);

    for (const entry of result.restored) {
      const item = owned.find((candidate) => candidate.id === entry.id);
      if (!item) continue;

      const system = item.system as { uses?: { value: number } };
      await db
        .update(items)
        .set({ system: { ...item.system, uses: { ...system.uses, value: entry.to } } as never })
        .where(eq(items.id, entry.id));
    }

    return { result };
  });

  /**
   * Rolls a fresh set of ability scores.
   *
   * Over HTTP rather than the table socket: the character sheet is not the
   * table page and holds no socket, so the socket version emitted into the void
   * and looked like a dead button. The roll still happens on the server, and is
   * still posted to the chat of every campaign the character belongs to - the
   * point was always that the table can see the scores were genuinely rolled.
   */
  app.post('/api/actors/:id/roll-abilities', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    // Rolling until the numbers are good is not rolling. The roller closes once
    // its result has been kept, and the refusal lives here rather than in the
    // page, because a page can be reloaded and a disabled button is a layout
    // decision. Applying a set is what sets the flag - a roll you throw away
    // costs nothing, which is the point of seeing it before you keep it.
    if (actor.abilitiesRolled) {
      throw new HttpError(400, `${actor.name}'s scores have already been rolled and kept.`);
    }

    const results = ABILITIES.map((ability) => ({
      ability,
      result: rollExpression(ABILITY_ROLL, `${actor.name} — ${ability.toUpperCase()}`),
    }));

    const assigned = await db
      .select({ campaignId: actorCampaigns.campaignId })
      .from(actorCampaigns)
      .where(eq(actorCampaigns.actorId, id));

    if (app.io) {
      const { persistAndDeliver } = await import('../realtime/chat.js');
      for (const row of assigned) {
        for (const { result } of results) {
          await persistAndDeliver(
            app.io,
            row.campaignId,
            { userId: user.id, actorId: actor.id, kind: 'roll', body: result.label, rollData: result },
            { authorName: user.displayName, actorName: actor.name },
          );
        }
      }
    }

    // Returned as well as posted, so a character with no campaign yet still
    // sees its numbers.
    return { rolls: results.map((r) => ({ ability: r.ability, total: r.result.total, dice: r.result.rolls })) };
  });

  /**
   * Gains a level's worth of hit points.
   *
   * The handbook offers two ways and this offers both: roll the class hit die,
   * or take the fixed average. Either is added to the Constitution modifier,
   * and a level never grants less than one hit point however bad the
   * constitution. Rolled on the server like every other roll, and posted to the
   * table so the number is not simply asserted.
   *
   * `hpMax` was previously only ever typed in by hand, so levelling up healed
   * nobody and the sheet quietly disagreed with the hit dice pool beside it.
   */
  /**
   * What this character gained by reaching their level.
   *
   * Read-only, and read through `requireActorRead` like every other sheet
   * question - a briefing about somebody's character is their sheet's business,
   * not a public compendium lookup.
   *
   * The ruleset comes from the campaign the sheet is assigned to, the same
   * resolution the compendium picker already uses. A sheet assigned nowhere
   * falls back to 2014, which is also the only edition with a full spell list.
   */
  app.get('/api/actors/:id/level-gains', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorRead(id, user.id);

    const query = z
      .object({
        from: z.coerce.number().int().min(0).max(20).optional(),
        to: z.coerce.number().int().min(1).max(20).optional(),
      })
      .parse(request.query);

    const to = query.to ?? actor.level;
    // Defaults to the levels not yet read, which is what the panel wants and
    // handles a DM moving somebody two levels at once.
    const from = query.from ?? Math.min(actor.levelAcknowledged, to - 1);

    const assigned = await db
      .select({ ruleset: campaigns.ruleset })
      .from(actorCampaigns)
      .innerJoin(campaigns, eq(actorCampaigns.campaignId, campaigns.id))
      .where(eq(actorCampaigns.actorId, id))
      .limit(1);
    const ruleset = assigned[0]?.ruleset ?? '2014';

    const [classLevels, features, traits, customFeatures] = await Promise.all([
      db.select().from(srdClassLevels).where(eq(srdClassLevels.ruleset, ruleset)),
      db.select().from(srdFeatures).where(eq(srdFeatures.ruleset, ruleset)),
      db.select().from(srdTraits).where(eq(srdTraits.ruleset, ruleset)),
      db
        .select()
        .from(actorSubclassFeatures)
        .where(eq(actorSubclassFeatures.actorId, id))
        .orderBy(asc(actorSubclassFeatures.level), asc(actorSubclassFeatures.sortOrder)),
    ]);

    return {
      gains: levelGains({
        className: actor.className,
        subclass: actor.subclass,
        race: actor.race,
        from,
        to,
        classLevels,
        features,
        traits,
        customFeatures,
      }),
      // So the panel can say "nothing is published yet" rather than "this level
      // grants nothing", which are very different messages.
      compendiumEmpty: classLevels.length === 0 && features.length === 0,
    };
  });

  /**
   * Writes chosen features onto the sheet.
   *
   * Idempotent on name, which is the whole point: pressing Add twice, or the DM
   * levelling the party a second time, must not leave two Extra Attacks on a
   * sheet nobody will think to tidy. Offered rather than applied automatically,
   * the rule a stamped monster and a rolled heal both already follow.
   */
  app.post('/api/actors/:id/level-features', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    const input = z
      .object({
        features: z
          .array(z.object({ name: z.string().min(1).max(200), description: z.string().max(8000) }))
          .max(20),
      })
      .parse(request.body);

    const existing = await db
      .select({ name: items.name })
      .from(items)
      .where(and(eq(items.ownerActorId, id), eq(items.type, 'feature')));
    const already = new Set(existing.map((row) => row.name.trim().toLowerCase()));

    const fresh = input.features.filter((feature) => !already.has(feature.name.trim().toLowerCase()));
    if (fresh.length > 0) {
      await db.insert(items).values(
        fresh.map((feature, index) => ({
          id: newId(),
          ownerActorId: id,
          type: 'feature' as const,
          name: feature.name,
          description: feature.description,
          sortOrder: existing.length + index,
          system: {} as never,
        })),
      );
    }

    return { added: fresh.length, skipped: input.features.length - fresh.length, actorId: actor.id };
  });

  /**
   * Marks the gains as read.
   *
   * A column rather than React state, because the DM sets the level from their
   * own screen: transient state is gone before the player ever opens the sheet,
   * which is exactly the case this exists for.
   */
  app.post('/api/actors/:id/acknowledge-level', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    await db
      .update(actors)
      .set({ levelAcknowledged: actor.level, updatedAt: Date.now() })
      .where(eq(actors.id, id));

    return { levelAcknowledged: actor.level };
  });

  /**
   * The subclass this sheet wrote for itself.
   *
   * Replaced wholesale rather than edited row by row: the editor holds the
   * whole list, one person edits their own sheet, and one route with one guard
   * is less to get wrong than three with per-row id scoping.
   *
   * The subclass name is taken from the sheet rather than from the payload, so
   * a definition cannot be filed under a subclass the character does not play.
   */
  app.put('/api/actors/:id/subclass-features', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    const input = z
      .object({
        features: z
          .array(
            z.object({
              level: z.number().int().min(1).max(20),
              name: z.string().min(1).max(200),
              description: z.string().max(8000).default(''),
            }),
          )
          .max(40),
      })
      .parse(request.body);

    const subclassName = actor.subclass.trim();
    if (!subclassName && input.features.length > 0) {
      throw new HttpError(400, 'Set the subclass on this sheet before writing what it grants.');
    }

    await db.delete(actorSubclassFeatures).where(eq(actorSubclassFeatures.actorId, id));

    if (input.features.length > 0) {
      await db.insert(actorSubclassFeatures).values(
        input.features.map((feature, index) => ({
          id: newId(),
          actorId: id,
          subclassName,
          level: feature.level,
          name: feature.name,
          description: feature.description,
          sortOrder: index,
        })),
      );
    }

    return { subclassName, count: input.features.length };
  });

  app.post('/api/actors/:id/level-hit-points', async (request) => {
    const user = assertUser(request);
    const { id } = request.params as { id: string };
    const { actor } = await requireActorWrite(id, user.id);

    const input = z.object({ method: z.enum(['roll', 'average']) }).parse(request.body);

    const info = classInfo(actor.className);
    if (!info) throw new HttpError(400, `No hit die known for "${actor.className}"`);

    const { roll, average } = hitPointsForLevel(info.hitDie);
    const conMod = abilityModifier(actor.con);

    let dieResult = average;
    let rolled = null;
    if (input.method === 'roll') {
      rolled = rollExpression(roll, `${actor.name} — hit points`);
      dieResult = rolled.total;
    }

    const gained = hitPointsGained(dieResult, conMod);
    const hpMax = actor.hpMax + gained;

    await db
      .update(actors)
      .set({ hpMax, hpCurrent: actor.hpCurrent + gained, updatedAt: Date.now() })
      .where(eq(actors.id, id));

    await syncLinkedTokens(app, id);

    if (app.io && rolled) {
      const assigned = await db
        .select({ campaignId: actorCampaigns.campaignId })
        .from(actorCampaigns)
        .where(eq(actorCampaigns.actorId, id));

      const { persistAndDeliver } = await import('../realtime/chat.js');
      for (const row of assigned) {
        await persistAndDeliver(
          app.io,
          row.campaignId,
          { userId: user.id, actorId: actor.id, kind: 'roll', body: rolled.label, rollData: rolled },
          { authorName: user.displayName, actorName: actor.name },
        );
      }
    }

    return { gained, hpMax, dieResult, conMod, method: input.method };
  });

  /* ----------------------------------------------------------- NPC creation */

  /** Stamps an NPC sheet from an SRD monster, for the DM's bestiary. */
  app.post('/api/campaigns/:campaignId/actors/from-monster', async (request) => {
    const user = assertUser(request);
    const { campaignId } = request.params as { campaignId: string };
    await requireDM(campaignId, user.id);

    const { monsterId } = z.object({ monsterId: z.string() }).parse(request.body);

    const found = await db.select().from(srdMonsters).where(eq(srdMonsters.id, monsterId)).limit(1);
    const monster = found[0];
    if (!monster) throw new HttpError(404, 'Monster not found');

    return { actor: await stampMonster(monster, campaignId, user.id) };
  });

  /**
   * What a creature can actually do, with the numbers behind it.
   *
   * Clicking a token used to answer with a list of names - `Longsword
   * (weapon)` - which says nothing a player wants to know when it is not their
   * turn and they are working out what the thing across the room is capable of.
   * The numbers come from `itemNumbers`, the same function that fills an item
   * card, so what this panel promises and what the dice do are one answer.
   *
   * Permission is decided before this is ever called: the route it serves gates
   * on `mayReadStats` and, for a player character, on the sheet being shared.
   * Nothing is filtered here, because a row that is drawn is a row the caller
   * was already entitled to.
   */
  async function actionRows(actor: Actor) {
    const owned = await db
      .select()
      .from(items)
      .where(eq(items.ownerActorId, actor.id))
      .orderBy(asc(items.sortOrder));

    return owned
      .map((item) => ({ item, numbers: itemNumbers(item, actor) }))
      // An item with nothing to roll is carried, not done: a suit of plate
      // belongs on the Carried list rather than among the attacks.
      .filter(({ numbers }) => numbers !== null)
      .map(({ item, numbers }) => {
        const system = item.system as Record<string, any>;
        return {
          id: item.id,
          name: item.name,
          type: item.type,
          numbers,
          /** `1st level`, `Cantrip`, or empty for anything that is not a spell. */
          spellLevel:
            item.type === 'spell'
              ? system.level === 0
                ? 'Cantrip'
                : `Level ${system.level}`
              : '',
          // `80/320 ft` for a bow, plain `5 ft` for a blade. A stamped
          // monster files its melee reach as `ranged` with no long range -
          // `reachOf` clamps touch to 5 ft and would halve a dragon's bite -
          // so a bare `-` for the second figure is the common case here, not
          // the exception.
          range:
            system.range?.type === 'ranged'
              ? system.range.long
                ? `${system.range.value}/${system.range.long} ft`
                : `${system.range.value} ft`
              : system.rangeText || '5 ft',
        };
      });
  }

  /* ------------------------------------------------------------ stat block */

  /**
   * What a creature on the board *is*: abilities, speed, actions, CR.
   *
   * Authorised on the server, never by the client: `mayReadStats` is the same
   * function the token payload uses, so the button the player sees and the
   * answer they get cannot disagree. The token id is looked up through
   * `tokenIn`, which joins to `scenes.campaignId`, so an id borrowed from
   * another table is simply not found.
   *
   * **Hit points are stripped from every branch.** They are a separate
   * decision, they stay the DM's, and a stat block is the obvious place for
   * them to leak back in.
   */
  app.get('/api/campaigns/:campaignId/tokens/:tokenId/statblock', async (request) => {
    const user = assertUser(request);
    const { campaignId, tokenId } = request.params as { campaignId: string; tokenId: string };
    const membership = await requireMembership(campaignId, user.id);

    const token = await tokenIn(tokenId, campaignId);
    if (!token) throw new HttpError(404, 'No such creature');

    // A hidden token does not exist as far as a player is concerned, and must
    // not become discoverable by asking this route about it.
    if (!membership.isDM && token.hidden && token.ownerUserId !== user.id) {
      throw new HttpError(404, 'No such creature');
    }

    const allowed = await campaignAllowsStats(campaignId);
    if (!mayReadStats(token, membership.isDM, user.id, allowed)) {
      throw new HttpError(403, 'The DM has not shared this creature’s stats');
    }

    const actorRows = token.actorId
      ? await db.select().from(actors).where(eq(actors.id, token.actorId)).limit(1)
      : [];
    const actor = actorRows[0];

    // A player character is not an enemy, and the enemy-stats grant has no
    // business deciding who reads one. Sheets are governed by ownership
    // everywhere else - the roster shows another player's character at name
    // level and nothing more - and this route would otherwise have handed over
    // their ability scores and their whole inventory to anyone at the table.
    if (actor && actor.type === 'character' && !membership.isDM) {
      const access = await getActorAccess(actor.id, user.id);
      if (!access || access.level < OWNERSHIP.observer) {
        throw new HttpError(403, 'That sheet has not been shared with you');
      }
    }

    // Stamped from the bestiary: the full published block, which the actor
    // never carried - `from-monster` copies the hot scalars and drops actions,
    // senses and special abilities entirely.
    if (actor?.srdMonsterId) {
      const rows = await db
        .select()
        .from(srdMonsters)
        .where(eq(srdMonsters.id, actor.srdMonsterId))
        .limit(1);

      if (rows[0]) {
        const { hitPoints, hitDice, data, ...rest } = rows[0];
        const { hit_points, hit_dice, hit_points_roll, ...safeData } =
          (data ?? {}) as Record<string, unknown>;
        return {
          source: 'compendium' as const,
          name: token.name,
          imageUrl: token.imageUrl,
          statBlock: { ...rest, data: safeData },
          // The actions `stampMonster` wrote onto the sheet, with their numbers.
          // The published block carries the same attacks as prose; these are the
          // rows the board can read at a glance, and they are what the DM will
          // actually roll.
          actions: await actionRows(actor),
        };
      }
    }

    // A token placed straight onto the board, with no sheet behind it. Thin,
    // but a player who presses the button deserves what the board already
    // knows rather than an error - and the DM can still see it is thin.
    if (!actor) {
      return {
        source: 'token' as const,
        name: token.name,
        imageUrl: token.imageUrl,
        statBlock: {
          size: token.w >= 4 ? 'Gargantuan' : token.w >= 3 ? 'Huge' : token.w >= 2 ? 'Large' : '',
          type: '',
          alignment: '',
          armorClass: token.ac,
          challengeRating: '',
        },
      };
    }

    const ownedItems = await db
      .select()
      .from(items)
      .where(eq(items.ownerActorId, actor.id))
      .orderBy(asc(items.sortOrder));

    return {
      source: 'actor' as const,
      actions: await actionRows(actor),
      name: token.name,
      imageUrl: token.imageUrl,
      statBlock: {
        size: '',
        type: actor.race,
        alignment: actor.alignment,
        armorClass: actor.armorClass,
        speed: `${actor.speed} ft.`,
        str: actor.str,
        dex: actor.dex,
        con: actor.con,
        int: actor.int,
        wis: actor.wis,
        cha: actor.cha,
        challengeRating: actor.challengeRating,
        items: ownedItems.map((item) => ({
          id: item.id,
          name: item.name,
          type: item.type,
        })),
      },
    };
  });
}
