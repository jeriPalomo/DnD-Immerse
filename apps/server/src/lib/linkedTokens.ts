import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { actors, scenes, tokens } from '../db/schema.js';

/**
 * Pushes a sheet's hit points and armour class onto its linked tokens.
 *
 * A linked token is meant to be the same creature as its sheet, and damage
 * already writes to both. But rests and sheet edits wrote only to the actor
 * while the board reads the token, so a player who took a long rest still
 * appeared on 12/47 to everyone at the table.
 *
 * Unlinked tokens are deliberately untouched: five goblins stamped from one
 * stat block have five independent HP pools, and that is the whole point of
 * the distinction.
 */
export async function syncLinkedTokens(
  app: FastifyInstance | null,
  actorId: string,
): Promise<void> {
  const found = await db.select().from(actors).where(eq(actors.id, actorId)).limit(1);
  const actor = found[0];
  if (!actor) return;

  const linked = await db
    .select({ id: tokens.id, sceneId: tokens.sceneId })
    .from(tokens)
    .where(and(eq(tokens.actorId, actorId), eq(tokens.actorLinked, true)));

  if (linked.length === 0) return;

  await db
    .update(tokens)
    .set({ hp: actor.hpCurrent, maxHp: actor.hpMax, ac: actor.armorClass })
    .where(
      and(eq(tokens.actorId, actorId), eq(tokens.actorLinked, true)),
    );

  if (!app?.io) return;

  // Only the campaigns that actually hold one of these tokens.
  const owning = await db
    .select({ campaignId: scenes.campaignId })
    .from(scenes)
    .where(inArray(scenes.id, [...new Set(linked.map((token) => token.sceneId))]));

  const { broadcastSceneState } = await import('../realtime/scene.js');
  for (const campaignId of new Set(owning.map((row) => row.campaignId))) {
    await broadcastSceneState(app.io, campaignId);
  }
}
