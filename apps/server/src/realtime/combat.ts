import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  advanceTurn,
  applyDamage,
  applyHealing,
  campaignRoom,
  concentrationDC,
  concentrationSave,
  damageApplySchema,
  resolveDeathSave,
  expiredEffects,
  initiativeExpression,
  initiativeAddSchema,
  initiativeUpdateSchema,
  rewindTurn,
  sortInitiative,
} from '@dnd/shared';
import type { Socket } from 'socket.io';
import type {
  AbilityScores,
  ClientToServerEvents,
  ServerToClientEvents,
  WireEncounter,
  WireInitiativeEntry,
} from '@dnd/shared';
import { db } from '../db/index.js';
import { activeEffects, actors, encounters, initiativeEntries, scenes, tokens } from '../db/schema.js';
import { getMembership } from '../auth/guards.js';
import { rollExpression } from '../lib/dice.js';
import { newId } from '../lib/id.js';
import { invalidateDragCache } from './scene.js';
import type { IOServer, SocketData } from './index.js';
import type { Token } from '../db/schema.js';

type CombatSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/* --------------------------------------------------------------- state */

async function activeEncounter(campaignId: string) {
  const rows = await db
    .select()
    .from(encounters)
    .where(and(eq(encounters.campaignId, campaignId), eq(encounters.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The tracker, projected for one audience.
 *
 * Players see enemy names and conditions but not their exact hit points -
 * knowing a boss is on 7 HP changes how a table plays, and that is the DM's
 * information to give away deliberately.
 */
async function projectEncounter(campaignId: string, isDM: boolean): Promise<WireEncounter | null> {
  const encounter = await activeEncounter(campaignId);
  if (!encounter) return null;

  const rows = await db
    .select({ entry: initiativeEntries, token: tokens })
    .from(initiativeEntries)
    .leftJoin(tokens, eq(initiativeEntries.tokenId, tokens.id))
    .where(eq(initiativeEntries.encounterId, encounter.id))
    .orderBy(asc(initiativeEntries.sortOrder));

  const entries: WireInitiativeEntry[] = rows.map(({ entry, token }) => {
    const ownedByPlayer = Boolean(token?.ownerUserId);
    const showHp = isDM || ownedByPlayer;

    return {
      id: entry.id,
      tokenId: entry.tokenId,
      name: entry.name,
      initiative: entry.initiative,
      sortOrder: entry.sortOrder,
      hp: showHp ? (token?.hp ?? null) : null,
      maxHp: showHp ? (token?.maxHp ?? null) : null,
      conditions: token?.conditions ?? [],
      hpRedacted: !showHp,
    };
  });

  return {
    id: encounter.id,
    sceneId: encounter.sceneId,
    round: encounter.round,
    activeIndex: encounter.activeIndex,
    isActive: encounter.isActive,
    entries,
  };
}

export async function broadcastEncounter(io: IOServer, campaignId: string): Promise<void> {
  for (const socket of await io.in(campaignRoom(campaignId)).fetchSockets()) {
    const isDM = socket.data.rooms.get(campaignId) === 'dm';
    socket.emit('initiative:state', { encounter: await projectEncounter(campaignId, isDM) });
  }
}

/**
 * Renumbers sortOrder so the stored order matches the rolled order.
 *
 * Joins through to the actor because the PHB tiebreaker on equal initiative is
 * Dexterity, which lives on the sheet rather than the token.
 */
async function resequence(encounterId: string): Promise<void> {
  const rows = await db
    .select({ entry: initiativeEntries, dexterity: actors.dex })
    .from(initiativeEntries)
    .leftJoin(tokens, eq(initiativeEntries.tokenId, tokens.id))
    .leftJoin(actors, eq(tokens.actorId, actors.id))
    .where(eq(initiativeEntries.encounterId, encounterId));

  const ordered = sortInitiative(
    rows.map(({ entry, dexterity }) => ({
      id: entry.id,
      name: entry.name,
      initiative: entry.initiative,
      dexterity: dexterity ?? 0,
    })),
  );

  for (const [index, row] of ordered.entries()) {
    await db.update(initiativeEntries).set({ sortOrder: index }).where(eq(initiativeEntries.id, row.id));
  }
}

function scoresOfToken(actor: { str: number; dex: number; con: number; int: number; wis: number; cha: number }): AbilityScores {
  return { str: actor.str, dex: actor.dex, con: actor.con, int: actor.int, wis: actor.wis, cha: actor.cha };
}

/* ------------------------------------------------------------ handlers */

export function registerCombatHandlers(io: IOServer, socket: CombatSocket): void {
  const user = socket.data.user;

  async function context(): Promise<{ campaignId: string; isDM: boolean } | null> {
    const [campaignId] = socket.data.rooms.keys();
    if (!campaignId) return null;

    const membership = await getMembership(campaignId, user.id);
    if (!membership) {
      socket.emit('error', { message: 'You are not in that campaign', code: 'NOT_A_MEMBER' });
      return null;
    }
    return { campaignId, isDM: membership.isDM };
  }

  async function requireDM(): Promise<{ campaignId: string } | null> {
    const ctx = await context();
    if (!ctx) return null;
    if (!ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can run the encounter' });
      return null;
    }
    return ctx;
  }

  /**
   * Tokens by id, but only the ones that belong to the campaign this socket is
   * acting in.
   *
   * The ids arrive from the client, and room membership only says which
   * campaigns this socket is in - not which one an id came from. Filtering here
   * means an id borrowed from another table simply is not found, rather than
   * being acted on because the sender happens to be a DM somewhere.
   */
  async function tokensIn(tokenIds: string[], campaignId: string): Promise<Token[]> {
    if (tokenIds.length === 0) return [];
    const rows = await db
      .select({ token: tokens })
      .from(tokens)
      .innerJoin(scenes, eq(tokens.sceneId, scenes.id))
      .where(and(inArray(tokens.id, tokenIds), eq(scenes.campaignId, campaignId)));
    return rows.map((row) => row.token);
  }

  /**
   * Whether a player may damage this token.
   *
   * Monsters, yes; anybody's character, no. Owned tokens are somebody's
   * character by construction, and a token linked to a `character` actor is one
   * even if the DM placed it unowned - so both are checked rather than trusting
   * the ownership column alone.
   */
  async function isFairGame(token: { ownerUserId: string | null; actorId: string | null }) {
    if (token.ownerUserId) return false;
    if (!token.actorId) return true;

    const rows = await db
      .select({ type: actors.type })
      .from(actors)
      .where(eq(actors.id, token.actorId))
      .limit(1);
    return rows[0]?.type !== 'character';
  }

  socket.on('encounter:start', async ({ sceneId }) => {
    const ctx = await requireDM();
    if (!ctx) return;

    // Only one encounter runs at a time; starting a new one closes the old.
    await db
      .update(encounters)
      .set({ isActive: false })
      .where(eq(encounters.campaignId, ctx.campaignId));

    await db.insert(encounters).values({
      id: newId(),
      campaignId: ctx.campaignId,
      sceneId,
      round: 1,
      activeIndex: 0,
      isActive: true,
      createdAt: Date.now(),
    });

    await broadcastEncounter(io, ctx.campaignId);
  });

  socket.on('encounter:end', async () => {
    const ctx = await requireDM();
    if (!ctx) return;

    await db
      .update(encounters)
      .set({ isActive: false })
      .where(eq(encounters.campaignId, ctx.campaignId));

    await broadcastEncounter(io, ctx.campaignId);
  });

  socket.on('initiative:add', async (payload) => {
    const ctx = await requireDM();
    if (!ctx) return;

    const input = initiativeAddSchema.parse(payload);
    const encounter = await activeEncounter(ctx.campaignId);
    if (!encounter) {
      socket.emit('error', { message: 'Start an encounter first' });
      return;
    }

    const chosen = await tokensIn(input.tokenIds, ctx.campaignId);

    for (const token of chosen) {
      // Rolled on the server, like every other die in the app.
      let initiative = 0;
      if (input.roll) {
        let scores: AbilityScores = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
        if (token.actorId) {
          const found = await db.select().from(actors).where(eq(actors.id, token.actorId)).limit(1);
          if (found[0]) scores = scoresOfToken(found[0]);
        }
        initiative = rollExpression(
          initiativeExpression(scores),
          `${token.name} initiative`,
        ).total;
      }

      await db.insert(initiativeEntries).values({
        id: newId(),
        encounterId: encounter.id,
        tokenId: token.id,
        name: token.name || 'Combatant',
        initiative,
        sortOrder: 0,
      });
    }

    await resequence(encounter.id);
    await broadcastEncounter(io, ctx.campaignId);
  });

  socket.on('initiative:remove', async ({ entryId }) => {
    const ctx = await requireDM();
    if (!ctx) return;

    await db.delete(initiativeEntries).where(eq(initiativeEntries.id, entryId));
    const encounter = await activeEncounter(ctx.campaignId);
    if (encounter) await resequence(encounter.id);

    await broadcastEncounter(io, ctx.campaignId);
  });

  socket.on('initiative:update', async (payload) => {
    const ctx = await requireDM();
    if (!ctx) return;

    const input = initiativeUpdateSchema.parse(payload);

    for (const entry of input.entries ?? []) {
      await db
        .update(initiativeEntries)
        .set({ initiative: entry.initiative })
        .where(eq(initiativeEntries.id, entry.id));
    }

    if (input.round !== undefined || input.activeIndex !== undefined) {
      await db
        .update(encounters)
        .set({
          ...(input.round !== undefined ? { round: input.round } : {}),
          ...(input.activeIndex !== undefined ? { activeIndex: input.activeIndex } : {}),
        })
        .where(eq(encounters.id, input.encounterId));
    }

    await resequence(input.encounterId);
    await broadcastEncounter(io, ctx.campaignId);
  });

  for (const [event, step] of [
    ['turn:next', advanceTurn],
    ['turn:previous', rewindTurn],
  ] as const) {
    socket.on(event, async () => {
      const ctx = await requireDM();
      if (!ctx) return;

      const encounter = await activeEncounter(ctx.campaignId);
      if (!encounter) return;

      const count = (
        await db
          .select({ id: initiativeEntries.id })
          .from(initiativeEntries)
          .where(eq(initiativeEntries.encounterId, encounter.id))
      ).length;

      const next = step(encounter.activeIndex, encounter.round, count);
      await db
        .update(encounters)
        .set({ activeIndex: next.activeIndex, round: next.round })
        .where(eq(encounters.id, encounter.id));

      // Timed effects fall off at the top of the round they expire in,
      // rather than lingering until someone remembers them.
      if (next.round !== encounter.round) {
        const expired = await expireEffectsFor(ctx.campaignId, next.round);
        if (expired.length > 0) {
          await postSystemMessage(
            io, ctx.campaignId, user.id,
            `Round ${next.round}: ${expired.join(', ')} ${expired.length === 1 ? 'expires' : 'expire'}.`,
          );
          const { broadcastSceneState } = await import('./scene.js');
          await broadcastSceneState(io, ctx.campaignId);
        }
      }

      // Whose turn it is, so the battle log reads as a timeline of the fight
      // rather than a list of numbers with no order to them.
      // Ordered by sortOrder, the same as the tracker builds the list with -
      // any other ordering here would name the wrong combatant.
      const entries = await db
        .select({ name: initiativeEntries.name })
        .from(initiativeEntries)
        .where(eq(initiativeEntries.encounterId, encounter.id))
        .orderBy(asc(initiativeEntries.sortOrder));

      const upNow = entries[next.activeIndex]?.name;
      if (upNow) {
        await postSystemMessage(io, ctx.campaignId, user.id, `Round ${next.round} — ${upNow}'s turn`);
      }

      await broadcastEncounter(io, ctx.campaignId);
    });
  }

  /**
   * A death saving throw, rolled here like every other die.
   *
   * The player whose character it is may roll their own; the DM may roll for
   * anyone, which is what happens when someone steps away from the table.
   */
  socket.on('death:save', async ({ tokenId }) => {
    const ctx = await context();
    if (!ctx) return;

    const token = (await tokensIn([tokenId], ctx.campaignId))[0];
    if (!token?.actorId) return;

    if (!ctx.isDM && token.ownerUserId !== user.id) {
      socket.emit('error', { message: 'That is not your character' });
      return;
    }

    const actorRows = await db.select().from(actors).where(eq(actors.id, token.actorId)).limit(1);
    const actor = actorRows[0];
    if (!actor) return;

    const roll = rollExpression('1d20', `${actor.name} death save`);
    const outcome = resolveDeathSave(roll.total, {
      successes: actor.deathSaveSuccesses,
      failures: actor.deathSaveFailures,
    });

    await db
      .update(actors)
      .set({
        deathSaveSuccesses: outcome.successes,
        deathSaveFailures: outcome.failures,
        ...(outcome.revivedAtHp !== null ? { hpCurrent: outcome.revivedAtHp } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(actors.id, actor.id));

    if (outcome.revivedAtHp !== null) {
      await db
        .update(tokens)
        .set({
          hp: outcome.revivedAtHp,
          conditions: token.conditions.filter((c) => c !== 'unconscious'),
        })
        .where(eq(tokens.id, tokenId));
    } else if (outcome.dead) {
      await db
        .update(tokens)
        .set({ conditions: [...new Set([...token.conditions, 'unconscious'])] })
        .where(eq(tokens.id, tokenId));
    }

    invalidateDragCache(token.sceneId);
    await postSystemMessage(
      io,
      ctx.campaignId,
      user.id,
      `${actor.name} death save: ${roll.output} — ${outcome.summary}`,
    );

    const { broadcastSceneState } = await import('./scene.js');
    await broadcastSceneState(io, ctx.campaignId);
    await broadcastEncounter(io, ctx.campaignId);
  });

  /**
   * Applies damage or healing to tokens, with resistances taken from the
   * actor's sheet, and prompts a concentration save when one is warranted.
   *
   * Every result is posted to chat so the DM can see - and undo - exactly what
   * the automation decided.
   */
  socket.on('damage:apply', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = damageApplySchema.parse(payload);
    const requested = await tokensIn(input.tokenIds, ctx.campaignId);

    // A player may subtract from what they are fighting, and nothing else: the
    // DM keeps every character's hit points, and healing stays theirs too.
    let targets = requested;
    if (!ctx.isDM) {
      if (input.healing) {
        socket.emit('error', { message: 'Only the DM can heal' });
        return;
      }

      const allowed = await Promise.all(requested.map((token) => isFairGame(token)));
      targets = requested.filter((_, i) => allowed[i]);

      if (targets.length === 0) {
        socket.emit('error', { message: 'You can only damage monsters, not other characters' });
        return;
      }
    }

    const results: { tokenId: string; name: string; before: number; after: number; reason: string }[] = [];
    const lines: string[] = [];

    for (const token of targets) {
      if (token.hp === null || token.maxHp === null) continue;

      const amount = input.halved ? Math.floor(input.amount / 2) : input.amount;

      let after: number;
      let reason = 'normal';

      if (input.healing) {
        after = applyHealing({ hp: token.hp, maxHp: token.maxHp }, amount).hpAfter;
        reason = 'healing';
      } else {
        const modifiers = await damageModifiersFor(token);
        const outcome = applyDamage({ hp: token.hp, maxHp: token.maxHp }, amount, input.damageType, modifiers);
        after = outcome.hpAfter;
        reason = outcome.reason;
      }

      await db.update(tokens).set({ hp: after }).where(eq(tokens.id, token.id));

      // A linked token writes through to its sheet, as everywhere else.
      if (token.actorLinked && token.actorId) {
        await db.update(actors).set({ hpCurrent: after, updatedAt: Date.now() }).where(eq(actors.id, token.actorId));
      }

      results.push({ tokenId: token.id, name: token.name, before: token.hp, after, reason });

      const verb = input.healing ? 'heals' : 'takes';
      const suffix = reason === 'normal' || reason === 'healing' ? '' : ` (${reason})`;
      lines.push(`${token.name} ${verb} ${Math.abs(token.hp - after)}${suffix} — ${after}/${token.maxHp}`);

      // Concentration is checked only on real damage that got through.
      if (!input.healing && token.hp !== after && token.conditions.includes('concentrating')) {
        const dc = concentrationDC(token.hp - after);
        let expression = '1d20';

        if (token.actorId) {
          const found = await db.select().from(actors).where(eq(actors.id, token.actorId)).limit(1);
          if (found[0]) {
            expression = concentrationSave(
              scoresOfToken(found[0]),
              found[0].level,
              Boolean(found[0].saveProficiencies?.con),
            ).expression;
          }
        }

        const save = rollExpression(expression, `${token.name} concentration`);
        const held = save.total >= dc;
        lines.push(`  concentration DC ${dc}: rolled ${save.total} — ${held ? 'held' : 'BROKEN'}`);

        if (!held) {
          await db
            .update(tokens)
            .set({ conditions: token.conditions.filter((c) => c !== 'concentrating') })
            .where(eq(tokens.id, token.id));
        }
      }
    }

    if (targets[0]) invalidateDragCache(targets[0].sceneId);

    // To the room, not the caller: emitted back to the sender alone, nobody
    // else at the table ever saw the damage banner.
    io.to(campaignRoom(ctx.campaignId)).emit('damage:applied', { results });
    await postSystemMessage(io, ctx.campaignId, user.id, lines.join('\n'));

    const { broadcastSceneState } = await import('./scene.js');
    await broadcastSceneState(io, ctx.campaignId);
    await broadcastEncounter(io, ctx.campaignId);
  });
}

/**
 * Removes effects whose duration has elapsed, returning their names so the
 * table is told what wore off rather than silently losing a buff.
 */
async function expireEffectsFor(campaignId: string, round: number): Promise<string[]> {
  const rows = await db
    .select({ effect: activeEffects, token: tokens })
    .from(activeEffects)
    .innerJoin(tokens, eq(activeEffects.ownerTokenId, tokens.id));

  const candidates = rows.map(({ effect }) => ({
    id: effect.id,
    name: effect.name,
    changes: effect.changes,
    disabled: effect.disabled,
    duration: effect.duration as { rounds: number | null; startRound: number | null } | null,
    statusId: effect.statusId,
  }));

  const expired = expiredEffects(candidates, round);
  for (const effect of expired) {
    await db.delete(activeEffects).where(eq(activeEffects.id, effect.id));
  }

  return expired.map((effect) => effect.name);
}

/** Resistances and immunities come from the token's actor sheet. */
async function damageModifiersFor(token: Token) {
  if (!token.actorId) return {};
  const found = await db.select().from(actors).where(eq(actors.id, token.actorId)).limit(1);
  return found[0]?.damageModifiers ?? {};
}

/**
 * A line from the table itself.
 *
 * Everything this file posts is combat by definition, so it flags the row for
 * the battle log rather than leaving it to clutter the conversation.
 */
async function postSystemMessage(
  io: IOServer,
  campaignId: string,
  userId: string,
  body: string,
): Promise<void> {
  if (!body.trim()) return;

  const { chatMessages } = await import('../db/schema.js');
  const message = {
    id: newId(),
    campaignId,
    userId,
    actorId: null,
    kind: 'system' as const,
    body,
    rollData: null,
    cardData: null,
    whisperToUserId: null,
    combat: true,
    createdAt: Date.now(),
  };

  await db.insert(chatMessages).values(message);
  io.to(campaignRoom(campaignId)).emit('chat:message', {
    message: { ...message, authorName: 'Table', actorName: null },
  });
}
