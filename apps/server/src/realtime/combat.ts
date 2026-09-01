import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  advanceTurn,
  applyDamage,
  applyHealing,
  campaignDmRoom,
  campaignRoom,
  concentrationDC,
  concentrationSave,
  damageApplySchema,
  resolveDeathSave,
  effectApplySchema,
  effectRemoveSchema,
  effectUpdateSchema,
  CONDITIONS,
  abilityModifier,
  battleSummary,
  formatBattleSummary,
  xpForMonster,
  initiativeExpression,
  initiativeAddSchema,
  initiativeRollSchema,
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
import {
  activeEffects,
  actors,
  encounters,
  initiativeEntries,
  scenes,
  srdMonsters,
  tokens,
} from '../db/schema.js';
import { getMembership } from '../auth/guards.js';
import {
  applyCondition,
  conditionsOf,
  currentRound,
  effectsByToken,
  expireEffectsIn,
  hasCondition,
  removeCondition,
} from '../lib/effects.js';
import { rollExpression } from '../lib/dice.js';
import { newId } from '../lib/id.js';
import { invalidateDragCache } from './scene.js';
import type { IOServer, SocketData } from './index.js';
import type { ActiveEffect as EffectRow } from '../db/schema.js';
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
 * Anchors every creature on a scene where it now stands.
 *
 * A turn's reach is measured from where the creature began it, so starting a
 * turn is a matter of moving the anchor rather than zeroing a counter. Called
 * whenever the turn changes and when a fight starts; `releaseMovement` clears
 * it when one ends.
 *
 * The whole scene rather than the initiative order: a token dropped on the board
 * mid-fight has no entry yet, and one taken out of the order should not carry an
 * anchor into the next encounter.
 *
 * Rewinding a turn re-anchors wherever the creature is now rather than restoring
 * where it was - being generous is the right direction to be wrong in while the
 * DM is correcting something.
 */
async function refillMovement(sceneId: string | null): Promise<void> {
  if (!sceneId) return;
  await db
    .update(tokens)
    .set({ turnOriginX: sql`${tokens.x}`, turnOriginY: sql`${tokens.y}`, extraMoveFeet: 0 })
    .where(eq(tokens.sceneId, sceneId));
  invalidateDragCache(sceneId);
}

/** Nothing is anchored out of combat, because nothing is counted out of it. */
async function releaseMovement(sceneId: string | null): Promise<void> {
  if (!sceneId) return;
  await db
    .update(tokens)
    .set({ turnOriginX: null, turnOriginY: null, extraMoveFeet: 0 })
    .where(eq(tokens.sceneId, sceneId));
  invalidateDragCache(sceneId);
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
    // The sheet comes along for the Dexterity modifier, which a waiting entry
    // shows on its button so pressing it is not a leap of faith.
    .select({ entry: initiativeEntries, token: tokens, dexterity: actors.dex })
    .from(initiativeEntries)
    .leftJoin(tokens, eq(initiativeEntries.tokenId, tokens.id))
    .leftJoin(actors, eq(tokens.actorId, actors.id))
    .where(eq(initiativeEntries.encounterId, encounter.id))
    .orderBy(asc(initiativeEntries.sortOrder));

  const effects = await effectsByToken(
    rows.map(({ token }) => token?.id).filter((id): id is string => Boolean(id)),
  );

  const entries: WireInitiativeEntry[] = rows.map(({ entry, token, dexterity }) => {
    const ownedByPlayer = Boolean(token?.ownerUserId);
    const showHp = isDM || ownedByPlayer;

    return {
      id: entry.id,
      tokenId: entry.tokenId,
      name: entry.name,
      initiative: entry.initiative,
      pending: entry.pending,
      // Only while it is waiting, so a rolled entry never carries it.
      initiativeBonus: entry.pending ? abilityModifier(dexterity ?? 10) : null,
      sortOrder: entry.sortOrder,
      hp: showHp ? (token?.hp ?? null) : null,
      maxHp: showHp ? (token?.maxHp ?? null) : null,
      conditions: token ? conditionsOf(effects.get(token.id)) : [],
      imageUrl: token?.imageUrl ?? null,
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
      // Anything nobody has rolled yet sorts last, however low the stored zero
      // would have placed it on its own.
      pending: entry.pending,
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

/**
 * Whether a player may subtract hit points from this creature.
 *
 * Monsters, yes; anybody's character, no. Owned tokens are somebody's
 * character by construction, and a token linked to a `character` actor is one
 * even if the DM placed it unowned - so both are checked rather than trusting
 * the ownership column alone.
 *
 * Exported because a landing attack applies its own damage now and has to ask
 * the same question the manual button asks. Two readings of "may I hit this"
 * is one reading plus a hole.
 */
export async function isFairGame(token: { ownerUserId: string | null; actorId: string | null }) {
  if (token.ownerUserId) return false;
  if (!token.actorId) return true;

  const rows = await db
    .select({ type: actors.type })
    .from(actors)
    .where(eq(actors.id, token.actorId))
    .limit(1);
  return rows[0]?.type !== 'character';
}

export function registerCombatHandlers(io: IOServer, socket: CombatSocket): void {
  const user = socket.data.user;

  async function context(): Promise<{ campaignId: string; isDM: boolean } | null> {
    // The campaign this socket declared it is acting in, not whichever room it
    // happens to have joined first.
    const campaignId = socket.data.activeCampaignId;
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

    // Everyone starts the fight with a full turn, whatever the last one left.
    await refillMovement(sceneId);

    await broadcastEncounter(io, ctx.campaignId);
  });

  socket.on('encounter:end', async () => {
    const ctx = await requireDM();
    if (!ctx) return;

    // Read before it is closed, so the scene it was fought on is still known.
    const ending = await activeEncounter(ctx.campaignId);

    /**
     * What the fight came to, posted where the whole table can read it.
     *
     * Read off the board at the moment it ends rather than tallied as it runs,
     * which is the same rule the rest of this codebase follows: a creature
     * standing at 0 hit points was vanquished, and one healed back up was not,
     * with no state to keep in step. The cost is that a corpse the DM deleted
     * mid-fight takes its initiative entry with it and cannot be counted -
     * unknowable rather than wrong, and named as such by `xpUnknown` when the
     * creature is still there but its worth is not.
     *
     * Hostiles only, on `disposition` and never on `ownerUserId`: a friendly
     * NPC travelling with the party is not an enemy vanquished, whoever runs
     * it, and neither is a downed player character.
     */
    if (ending) {
      const fought = await db
        .select({
          entryName: initiativeEntries.name,
          tokenName: tokens.name,
          hp: tokens.hp,
          disposition: tokens.disposition,
          publishedXp: srdMonsters.xp,
          publishedCr: srdMonsters.challengeRating,
          challengeRating: actors.challengeRating,
          actorId: actors.id,
          actorType: actors.type,
        })
        .from(initiativeEntries)
        .leftJoin(tokens, eq(initiativeEntries.tokenId, tokens.id))
        .leftJoin(actors, eq(tokens.actorId, actors.id))
        .leftJoin(srdMonsters, eq(actors.srdMonsterId, srdMonsters.id))
        .where(eq(initiativeEntries.encounterId, ending.id));

      // A fight nobody was ever in is a mis-press, not an encounter.
      if (fought.length > 0) {
        /**
         * Who the share is divided among: the characters who were in the fight.
         *
         * Read from the initiative order rather than from the campaign, so
         * somebody who missed the session earns nothing from it. On
         * `actors.type` and never on `disposition` - a friendly NPC travelling
         * with the party fights alongside them and is still not somebody with a
         * sheet to write experience onto.
         *
         * Deduplicated by actor: a character with two tokens in the order is
         * one person, and counting them twice would both shrink everybody's
         * share and pay them double.
         */
        const earners = [
          ...new Set(
            fought
              .filter((row) => row.actorType === 'character' && row.actorId)
              .map((row) => row.actorId as string),
          ),
        ];

        const summary = battleSummary({
          rounds: ending.round,
          characters: earners.length,
          foes: fought
            .filter((row) => row.disposition === 'hostile')
            .map((row) => ({
              name: row.tokenName || row.entryName,
              defeated: row.hp !== null && row.hp <= 0,
              // The rating decides, and the compendium's own column is only
              // the fallback - see `xpForMonster`, which explains why this is
              // the one place a published number does not win.
              xp: xpForMonster({
                challengeRating: row.challengeRating || row.publishedCr,
                publishedXp: row.publishedXp,
              }),
            })),
        });

        /**
         * The share, written to the sheets.
         *
         * Experience is a record here rather than a gate: this table levels by
         * story, so nothing is decided by the number and there is no threshold
         * for it to cross. That is exactly why it is added without asking -
         * a confirmation on every fight is friction for a figure that changes
         * nothing, where damage and healing are offered because they do.
         *
         * Paid to the characters who were in the fight, and to nobody else:
         * somebody who missed the session earns nothing from it. The DM can
         * still hand it out by typing, since the number is editable.
         */
        const each = summary.xpEach ?? 0;
        if (each > 0) {
          await db
            .update(actors)
            .set({ experience: sql`${actors.experience} + ${each}`, updatedAt: Date.now() })
            .where(inArray(actors.id, earners));
        }

        // On the board, not in the log. A fight ends with everyone looking at
        // the map, and four lines of chat arriving under the last damage roll
        // is where a summary is least likely to be read.
        io.to(campaignRoom(ctx.campaignId)).emit('encounter:summary', {
          text: formatBattleSummary(summary, each > 0),
        });
      }
    }

    await db
      .update(encounters)
      .set({ isActive: false })
      .where(eq(encounters.campaignId, ctx.campaignId));

    // Nothing counts movement out of combat, and an anchor left behind would be
    // waiting for whoever starts the next fight on this scene.
    await releaseMovement(ending?.sceneId ?? null);

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
      const actor = token.actorId
        ? (await db.select().from(actors).where(eq(actors.id, token.actorId)).limit(1))[0]
        : undefined;

      // Somebody else's creature is asked rather than rolled - the same split
      // the group roll makes, and for the same reason. The DM's own monsters
      // have nobody to ask, so they roll now and the fight is never held up.
      const theirs = Boolean(token.ownerUserId) || actor?.type === 'character';
      const pending = input.askPlayers && theirs;

      // Rolled on the server, like every other die in the app.
      let initiative = 0;
      if (input.roll && !pending) {
        const scores: AbilityScores = actor
          ? scoresOfToken(actor)
          : { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
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
        pending,
        sortOrder: 0,
      });
    }

    await resequence(encounter.id);
    await broadcastEncounter(io, ctx.campaignId);
  });

  /**
   * One person rolling an initiative entry that is waiting on them.
   *
   * The mirror of `chat:groupAnswer`, down to who may press it: the creature's
   * owner, or the DM filling in for whoever is not at the table tonight. A
   * request nobody can answer would hold the fight up for the whole session.
   */
  socket.on('initiative:roll', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const { entryId } = initiativeRollSchema.parse(payload);

    // Scoped through the encounter's campaign, like every other id from a
    // client - room membership authenticates and does not authorize.
    const rows = await db
      .select({ entry: initiativeEntries, token: tokens, actor: actors })
      .from(initiativeEntries)
      .innerJoin(encounters, eq(initiativeEntries.encounterId, encounters.id))
      .leftJoin(tokens, eq(initiativeEntries.tokenId, tokens.id))
      .leftJoin(actors, eq(tokens.actorId, actors.id))
      .where(and(eq(initiativeEntries.id, entryId), eq(encounters.campaignId, ctx.campaignId)))
      .limit(1);

    const found = rows[0];
    // Already rolled, or no such entry here. Silently, because two tabs racing
    // the same button is one person pressing it once.
    if (!found || !found.entry.pending) return;

    if (!ctx.isDM && found.token?.ownerUserId !== user.id) {
      socket.emit('error', { message: 'That roll is not yours to make' });
      return;
    }

    const scores: AbilityScores = found.actor
      ? scoresOfToken(found.actor)
      : { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };

    const initiative = rollExpression(
      initiativeExpression(scores),
      `${found.entry.name} initiative`,
    ).total;

    await db
      .update(initiativeEntries)
      .set({ initiative, pending: false })
      .where(eq(initiativeEntries.id, entryId));

    await resequence(found.entry.encounterId);
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

  /**
   * Correcting the tracker: a mistyped initiative, the round, whose turn it is.
   *
   * This handler existed from the start with no client caller at all, which is
   * the same gap `wall:update` had - so a fat-fingered 17 entered as 71 could not
   * be fixed, and the round number could not be set. Wiring it up meant first
   * closing the hole below: `encounterId` arrived from the client and was written
   * to on trust, so a DM of their own game could renumber somebody else's fight.
   */
  socket.on('initiative:update', async (payload) => {
    const ctx = await requireDM();
    if (!ctx) return;

    const input = initiativeUpdateSchema.parse(payload);

    // Scoped to this campaign, the same way every token id is. Without it, room
    // membership was answering "is this socket a DM somewhere".
    const owned = await db
      .select({ id: encounters.id })
      .from(encounters)
      .where(and(eq(encounters.id, input.encounterId), eq(encounters.campaignId, ctx.campaignId)))
      .limit(1);
    if (!owned[0]) return;

    for (const entry of input.entries ?? []) {
      // And each entry has to belong to that encounter, or an id from another
      // fight rides in on a valid one.
      await db
        .update(initiativeEntries)
        .set({ initiative: entry.initiative })
        .where(
          and(
            eq(initiativeEntries.id, entry.id),
            eq(initiativeEntries.encounterId, input.encounterId),
          ),
        );
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

      // The turn that just ended took its movement with it.
      await refillMovement(encounter.sceneId);

      // Timed effects fall off at the top of the round they expire in,
      // rather than lingering until someone remembers them.
      if (next.round !== encounter.round) {
        const { names, tokenIds } = await expireEffectsIn(ctx.campaignId, next.round);
        if (names.length > 0) {
          await postSystemMessage(
            io, ctx.campaignId, user.id,
            `Round ${next.round}: ${names.join(', ')} ${names.length === 1 ? 'expires' : 'expire'}.`,
          );
          const { broadcastSceneState, invalidateDragCache: dropCache } = await import('./scene.js');
          for (const tokenId of tokenIds) {
            const row = await db
              .select({ sceneId: tokens.sceneId })
              .from(tokens)
              .where(eq(tokens.id, tokenId))
              .limit(1);
            if (row[0]) dropCache(row[0].sceneId);
          }
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
      await db.update(tokens).set({ hp: outcome.revivedAtHp }).where(eq(tokens.id, tokenId));
      await removeCondition(tokenId, 'unconscious');
    } else if (outcome.dead) {
      await applyCondition(tokenId, 'unconscious');
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

    await applyDamageTo(io, ctx.campaignId, user.id, targets, {
      amount: input.amount,
      damageType: input.damageType,
      healing: input.healing,
      halved: input.halved,
      // The DM's alone. A player asking for quiet would be asking to hit
      // somebody without it being written down.
      quiet: ctx.isDM && input.quiet,
    });
  });

  /* ------------------------------------------------------------ effects */

  /**
   * Pushes the board out after an effect changed.
   *
   * A full scene push rather than one token, because conditions decide what a
   * player can see: blinding a token collapses its owner's sight polygon, and a
   * per-token broadcast cannot carry that.
   */
  async function broadcastEffects(campaignId: string, sceneIds: string[]): Promise<void> {
    for (const sceneId of new Set(sceneIds)) invalidateDragCache(sceneId);
    const { broadcastSceneState } = await import('./scene.js');
    await broadcastSceneState(io, campaignId);
    await broadcastEncounter(io, campaignId);
  }

  socket.on('effect:apply', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = effectApplySchema.parse(payload);
    if (!CONDITIONS.includes(input.condition as (typeof CONDITIONS)[number])) {
      socket.emit('error', { message: 'That is not a condition' });
      return;
    }

    const requested = await tokensIn(input.tokenIds, ctx.campaignId);

    // The same rule as damage: a player's spell may condition a monster, never
    // somebody's character. Paralysing another player's fighter is the DM's call.
    let targets = requested;
    if (!ctx.isDM) {
      const allowed = await Promise.all(requested.map((token) => isFairGame(token)));
      targets = requested.filter((_, i) => allowed[i]);

      if (targets.length === 0) {
        socket.emit('error', { message: 'You can only apply conditions to monsters' });
        return;
      }
    }

    // Timers are measured from the round in progress. With no encounter running
    // there is nothing to count, so it lasts until removed and says so.
    const round = await currentRound(ctx.campaignId);
    const duration =
      input.rounds !== null && round !== null
        ? { rounds: input.rounds, startRound: round }
        : null;

    for (const token of targets) {
      await applyCondition(token.id, input.condition, duration, input.itemId);
    }

    const lasting =
      duration === null
        ? input.rounds !== null
          ? ' (until removed — no fight is running to count rounds)'
          : ''
        : ` for ${input.rounds} ${input.rounds === 1 ? 'round' : 'rounds'}`;

    await postSystemMessage(
      io,
      ctx.campaignId,
      user.id,
      `${targets.map((t) => t.name).join(', ')} ${targets.length === 1 ? 'is' : 'are'} ${input.condition}${lasting}.`,
    );

    await broadcastEffects(ctx.campaignId, targets.map((token) => token.sceneId));
  });

  socket.on('effect:update', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = effectUpdateSchema.parse(payload);
    const found = await effectIn(input.effectId, ctx.campaignId);
    if (!found) return;

    if (!ctx.isDM && found.token.ownerUserId !== user.id) {
      socket.emit('error', { message: 'You cannot change that' });
      return;
    }

    // Both fields are optional, so a payload of just an id would reach
    // db.update().set({}), which Drizzle throws on. wall:update had exactly this
    // bug and it is easy to write again: every conditional-only `set` needs it.
    if (input.rounds === undefined && input.disabled === undefined) return;

    const round = await currentRound(ctx.campaignId);
    await db
      .update(activeEffects)
      .set({
        ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
        // Rounds are given as "from now", so the stored window is rebased on the
        // current round - otherwise editing a timer mid-fight would read as the
        // number of rounds it had when it was cast.
        ...(input.rounds !== undefined
          ? {
              duration:
                input.rounds === null || round === null
                  ? null
                  : { rounds: input.rounds, startRound: round },
            }
          : {}),
      })
      .where(eq(activeEffects.id, input.effectId));

    await broadcastEffects(ctx.campaignId, [found.token.sceneId]);
  });

  socket.on('effect:remove', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = effectRemoveSchema.parse(payload);
    const found = await effectIn(input.effectId, ctx.campaignId);
    if (!found) return;

    // A player may clear one from their own token - shaking off a condition is
    // theirs to do - but not from anybody else's.
    if (!ctx.isDM && found.token.ownerUserId !== user.id) {
      socket.emit('error', { message: 'You cannot remove that' });
      return;
    }

    await db.delete(activeEffects).where(eq(activeEffects.id, input.effectId));
    await postSystemMessage(
      io,
      ctx.campaignId,
      user.id,
      `${found.effect.name} ends on ${found.token.name}.`,
    );

    await broadcastEffects(ctx.campaignId, [found.token.sceneId]);
  });
}

/**
 * An effect and the token it sits on, but only within one campaign.
 *
 * The same reason `tokensIn` exists: an effect id arrives from the client, and
 * room membership does not say which campaign it came from. Joined through the
 * token to its scene so an id borrowed from another game is simply not found.
 */
/**
 * Subtracts hit points, and tells the table what happened.
 *
 * Lifted out of the `damage:apply` handler so the damage a landing attack
 * rolls can go through the *same* path rather than a second copy of it: the
 * resistances off the sheet, the concentration save a hurt caster owes, the
 * battle-log line and the redaction all live here, and two of these would
 * drift the way the token HUD and the tracker once did.
 *
 * Who is allowed to apply it is decided by the caller - this only does it.
 */
export async function applyDamageTo(
  io: IOServer,
  campaignId: string,
  userId: string,
  targets: Token[],
  options: {
    amount: number;
    damageType: string;
    healing?: boolean;
    halved?: boolean;
    /**
     * Move the hit points and say nothing.
     *
     * The board still updates - a creature's bar is what everyone can see
     * anyway - but no line is written and no number floats over the token.
     * This is the DM correcting something, and a correction announced is a
     * correction that confuses the table more than the mistake did.
     */
    quiet?: boolean;
  },
): Promise<void> {
  const results: {
    tokenId: string;
    name: string;
    amount: number;
    healing: boolean;
    before: number;
    after: number;
    reason: string;
  }[] = [];
  const lines: string[] = [];

  for (const token of targets) {
    if (token.hp === null || token.maxHp === null) continue;

    // Halving is what a successful save does to a fireball, so it belongs to
    // damage and nothing else. Applied to healing it quietly gave back half of
    // what was typed - a wrong number that looks like a right one, since there
    // is no save to explain it and the flag is set by an area-damage button
    // the healer never pressed.
    const amount =
      options.halved && !options.healing ? Math.floor(options.amount / 2) : options.amount;

    let after: number;
    let reason = 'normal';

    if (options.healing) {
      after = applyHealing({ hp: token.hp, maxHp: token.maxHp }, amount).hpAfter;
      reason = 'healing';
    } else {
      const modifiers = await damageModifiersFor(token);
      const outcome = applyDamage({ hp: token.hp, maxHp: token.maxHp }, amount, options.damageType, modifiers);
      after = outcome.hpAfter;
      reason = outcome.reason;
    }

    await db.update(tokens).set({ hp: after }).where(eq(tokens.id, token.id));

    // A linked token writes through to its sheet, as everywhere else.
    if (token.actorLinked && token.actorId) {
      await db.update(actors).set({ hpCurrent: after, updatedAt: Date.now() }).where(eq(actors.id, token.actorId));
    }

    results.push({
      tokenId: token.id,
      name: token.name,
      // What the creature actually took, after resistances - the number the
      // board floats, and the only part a player may be told.
      amount: Math.abs(token.hp - after),
      healing: Boolean(options.healing),
      before: token.hp,
      after,
      reason,
    });

    /**
     * What landed, and not what is left.
     *
     * This line carried `— 2/7` to the whole table, which is the exact number
     * the payload three lines above goes to some trouble to redact: the
     * socket stripped `before` and `after` for players and then the chat
     * message printed the survivor of the two anyway. Watching a blow land
     * tells you what it took; how close a creature is to dying stays the
     * DM's to narrate, and they have the tracker for it.
     */
    const verb = options.healing ? 'heals' : 'takes';
    const noun = options.healing ? '' : ' damage';
    const suffix = reason === 'normal' || reason === 'healing' ? '' : ` (${reason})`;
    lines.push(`${token.name} ${verb} ${Math.abs(token.hp - after)}${noun}${suffix}`);

    // Concentration is checked only on real damage that got through.
    if (!options.healing && token.hp !== after && (await hasCondition(token.id, 'concentrating'))) {
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

      if (!held) await removeCondition(token.id, 'concentrating');
    }
  }

  // Every scene touched, not just the first target's. Nothing visibly breaks
  // without this today - the cache is read for positions, speed and sight,
  // and damage moves none of those - but a hit can span two scenes, and the
  // day damage does something that touches speed this is already a trap.
  for (const sceneId of new Set(targets.map((token) => token.sceneId))) {
    invalidateDragCache(sceneId);
  }

  /**
   * The amount to the table, the pool to the DM.
   *
   * This used to send `before` and `after` to the whole room, and the
   * initiative tracker rendered them - so a player watching a fight read
   * "Goblin 2 12 to 5" off their own screen, which is the exact number every
   * other payload in this app redacts. Watching a blow land tells you what it
   * took; it does not tell you how much the creature had left.
   */
  if (options.quiet) {
    // To the DM alone, so they can see their own correction land. Nothing
    // reaches the players and nothing is written to the log.
    io.to(campaignDmRoom(campaignId)).emit('damage:applied', { results });
  } else {
    // `.except` matters: the DM is in both rooms, so emitting to each in turn
    // would hand them the redacted copy as well and leave which one arrived
    // last to chance.
    io
      .to(campaignRoom(campaignId))
      .except(campaignDmRoom(campaignId))
      .emit('damage:applied', {
        results: results.map(({ before: _before, after: _after, ...rest }) => rest),
      });
    io.to(campaignDmRoom(campaignId)).emit('damage:applied', { results });
    await postSystemMessage(io, campaignId, userId, lines.join('\n'));
  }

  const { broadcastSceneState } = await import('./scene.js');
  await broadcastSceneState(io, campaignId);
  await broadcastEncounter(io, campaignId);
}

async function effectIn(
  effectId: string,
  campaignId: string,
): Promise<{ effect: EffectRow; token: Token } | null> {
  const rows = await db
    .select({ effect: activeEffects, token: tokens })
    .from(activeEffects)
    .innerJoin(tokens, eq(activeEffects.ownerTokenId, tokens.id))
    .innerJoin(scenes, eq(tokens.sceneId, scenes.id))
    .where(and(eq(activeEffects.id, effectId), eq(scenes.campaignId, campaignId)))
    .limit(1);

  return rows[0] ?? null;
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
    groupData: null,
    attackData: null,
    whisperToUserId: null,
    combat: true,
    createdAt: Date.now(),
  };

  await db.insert(chatMessages).values(message);
  io.to(campaignRoom(campaignId)).emit('chat:message', {
    message: { ...message, authorName: 'Table', actorName: null },
  });
}
