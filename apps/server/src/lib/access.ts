import { and, eq, inArray } from 'drizzle-orm';
import { OWNERSHIP, type OwnershipLevel } from '@dnd/shared';
import { db } from '../db/index.js';
import { actorCampaigns, actors, campaigns, ownership } from '../db/schema.js';
import { HttpError } from '../auth/guards.js';
import type { Actor } from '../db/schema.js';

/**
 * Access level a user has on an actor. Three ways to hold rights, checked in
 * order of cost:
 *
 *   1. You created it.
 *   2. You DM a campaign it is assigned to - a DM can edit party sheets.
 *   3. An explicit ownership row grants you a level.
 *
 * Everything that reads or writes an actor goes through this. Returning a level
 * rather than a boolean is what lets the DM share one NPC at `observer` without
 * a special case.
 */
export async function getActorAccess(
  actorId: string,
  userId: string,
): Promise<{ actor: Actor; level: OwnershipLevel } | null> {
  const rows = await db.select().from(actors).where(eq(actors.id, actorId)).limit(1);
  const actor = rows[0];
  if (!actor) return null;

  if (actor.ownerUserId === userId) return { actor, level: OWNERSHIP.owner };

  // DM of any campaign this actor is assigned to.
  const dmRows = await db
    .select({ id: campaigns.id })
    .from(actorCampaigns)
    .innerJoin(campaigns, eq(actorCampaigns.campaignId, campaigns.id))
    .where(and(eq(actorCampaigns.actorId, actorId), eq(campaigns.dmUserId, userId)))
    .limit(1);
  if (dmRows.length > 0) return { actor, level: OWNERSHIP.owner };

  // NPCs authored inside a campaign belong to that campaign's DM.
  if (actor.campaignId) {
    const owned = await db
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, actor.campaignId), eq(campaigns.dmUserId, userId)))
      .limit(1);
    if (owned.length > 0) return { actor, level: OWNERSHIP.owner };
  }

  const grant = await db
    .select({ level: ownership.level })
    .from(ownership)
    .where(
      and(
        eq(ownership.documentType, 'actor'),
        eq(ownership.documentId, actorId),
        eq(ownership.userId, userId),
      ),
    )
    .limit(1);

  return { actor, level: (grant[0]?.level ?? OWNERSHIP.none) as OwnershipLevel };
}

/** Throws 404 rather than 403 so a stranger cannot confirm an actor exists. */
export async function requireActorRead(actorId: string, userId: string) {
  const access = await getActorAccess(actorId, userId);
  if (!access || access.level < OWNERSHIP.observer) throw new HttpError(404, 'Character not found');
  return access;
}

export async function requireActorWrite(actorId: string, userId: string) {
  const access = await getActorAccess(actorId, userId);
  if (!access || access.level < OWNERSHIP.observer) throw new HttpError(404, 'Character not found');
  if (access.level < OWNERSHIP.owner) throw new HttpError(403, 'You can view this sheet but not edit it');
  return access;
}

/**
 * Bulk access levels for a list of actors, for the party roster. Avoids issuing
 * one permission query per row.
 */
export async function getBulkActorAccess(
  actorIds: string[],
  userId: string,
  dmCampaignIds: Set<string>,
): Promise<Map<string, OwnershipLevel>> {
  const levels = new Map<string, OwnershipLevel>();
  if (actorIds.length === 0) return levels;

  const rows = await db
    .select({ id: actors.id, ownerUserId: actors.ownerUserId, campaignId: actors.campaignId })
    .from(actors)
    .where(inArray(actors.id, actorIds));

  for (const row of rows) {
    if (row.ownerUserId === userId || (row.campaignId && dmCampaignIds.has(row.campaignId))) {
      levels.set(row.id, OWNERSHIP.owner);
    }
  }

  const grants = await db
    .select({ documentId: ownership.documentId, level: ownership.level })
    .from(ownership)
    .where(
      and(
        eq(ownership.documentType, 'actor'),
        eq(ownership.userId, userId),
        inArray(ownership.documentId, actorIds),
      ),
    );

  for (const grant of grants) {
    const existing = levels.get(grant.documentId) ?? OWNERSHIP.none;
    if (grant.level > existing) levels.set(grant.documentId, grant.level as OwnershipLevel);
  }

  return levels;
}
