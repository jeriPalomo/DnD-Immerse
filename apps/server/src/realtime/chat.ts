import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  attackModeAgainst,
  attackExpression,
  campaignDmRoom,
  campaignRoom,
  combineRollModes,
  cardActionSchema,
  cardRequestSchema,
  damageExpression,
  rollRequestSchema,
  savingThrowExpression,
  sendMessageSchema,
  spellCondition,
  tokenDistance,
  spellSaveDC,
  userRoom,
  type AppliedCondition,
} from '@dnd/shared';
import type { Socket } from 'socket.io';
import type {
  AbilityKey,
  AbilityScores,
  ClientToServerEvents,
  RollResult,
  ServerToClientEvents,
  WireCard,
  WireChatMessage,
} from '@dnd/shared';
import {
  abilityModifier,
  groupRollSchema,
  savingThrowBonus,
  skillBonus,
  SKILLS,
  type GroupRollPayload,
} from '@dnd/shared';
import { db } from '../db/index.js';
import {
  actorCampaigns,
  actors,
  campaigns,
  chatMessages,
  items,
  scenes,
  tokens,
  users,
} from '../db/schema.js';
import { getMembership } from '../auth/guards.js';
import { getActorAccess } from '../lib/access.js';
import { rollExpression } from '../lib/dice.js';
import { newId } from '../lib/id.js';
import { applyCondition, conditionsOf, currentRound, effectsByToken } from '../lib/effects.js';
import { tokenIn } from './scene.js';
import type { IOServer, SocketData } from './index.js';
import type { Actor, Item, Token } from '../db/schema.js';

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

const HISTORY_LIMIT = 100;

function scoresOf(actor: Actor): AbilityScores {
  return { str: actor.str, dex: actor.dex, con: actor.con, int: actor.int, wis: actor.wis, cha: actor.cha };
}

/**
 * The save an item forces, and the DC to beat.
 *
 * One function because `buildCard` prints the DC and `chat:cardAction` rolls
 * against it. Computed twice, they would eventually disagree, and a card
 * reading DC 15 while the server compared against 10 is the sort of wrong
 * nobody notices for a session.
 *
 * The ability comes from the item's own `save` blob or, failing that, from the
 * condition it inflicts - the SRD ships Web with no `dc` block at all, and a
 * hand-entered weapon has no blob to carry one.
 *
 * The DC is 8 + proficiency + the driving modifier, which is how 5e sets every
 * save an item forces: a spell uses the caster's spellcasting ability, a weapon
 * the ability it is swung with.
 */
function saveProfileFor(item: Item, actor: Actor): { ability: AbilityKey; dc: number | null } | null {
  const s = item.system as Record<string, any>;

  const ability =
    (s.save?.ability as AbilityKey | undefined) ??
    (conditionsInflictedBy(item).find((entry) => entry.save)?.save as AbilityKey | undefined);
  if (!ability) return null;

  const driving =
    item.type === 'spell'
      ? (actor.spellcastingAbility as AbilityKey | null)
      : ((s.ability as AbilityKey | undefined) ?? 'str');

  return { ability, dc: driving ? spellSaveDC(scoresOf(actor), actor.level, driving) : null };
}

/**
 * What an item inflicts when it lands.
 *
 * The item's own field wins, because it was filled in deliberately; otherwise
 * the curated `SPELL_CONDITIONS` table answers for the SRD spells it knows. An
 * empty list means nothing is applied, which is the old behaviour.
 */
function conditionsInflictedBy(item: Item): AppliedCondition[] {
  const own = (item.system as { appliesConditions?: AppliedCondition[] }).appliesConditions;
  if (own && own.length > 0) return own;

  const known = item.type === 'spell' ? spellCondition(item.name) : null;
  if (!known) return [];

  return known.conditions.map((condition) => ({
    condition,
    rounds: known.rounds,
    save: known.save,
  }));
}

/* ----------------------------------------------------------- delivery */

/**
 * Routes a message to the right audience.
 *
 * Public messages go to the campaign room. Anything private is sent to the
 * participants' personal rooms instead - never to the campaign room with a
 * flag, because a flag is something the client could ignore.
 */
function deliver(io: IOServer, campaignId: string, message: WireChatMessage): void {
  if (!message.whisperToUserId) {
    io.to(campaignRoom(campaignId)).emit('chat:message', { message });
    return;
  }

  // Private messages go to the two participants' personal rooms - never to the
  // campaign room carrying a "private" flag, because a flag is something a
  // modified client could simply ignore.
  const targets = new Set([userRoom(message.userId), userRoom(message.whisperToUserId)]);
  for (const room of targets) io.to(room).emit('chat:message', { message });
}

/** A secret roll is modelled as a whisper to the DM, so it stays secret in history too. */
async function dmOf(campaignId: string): Promise<string | null> {
  const rows = await db
    .select({ dmUserId: campaigns.dmUserId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  return rows[0]?.dmUserId ?? null;
}

/**
 * Writes a message to the log and routes it. Exported so REST routes can post
 * to the table too - a roll made on the character sheet is still a roll the
 * table should be able to see.
 */
export async function persistAndDeliver(
  io: IOServer,
  campaignId: string,
  row: {
    userId: string;
    actorId: string | null;
    kind: 'text' | 'roll' | 'card' | 'system';
    body: string;
    rollData?: RollResult | null;
    cardData?: WireCard | null;
    whisperToUserId?: string | null;
    /** Routes this to the battle log instead of the conversation. */
    combat?: boolean;
  },
  context: { authorName: string; actorName: string | null },
): Promise<WireChatMessage> {
  const message: WireChatMessage = {
    id: newId(),
    campaignId,
    userId: row.userId,
    authorName: context.authorName,
    actorName: context.actorName,
    kind: row.kind,
    body: row.body,
    rollData: row.rollData ?? null,
    cardData: row.cardData ?? null,
    whisperToUserId: row.whisperToUserId ?? null,
    combat: row.combat ?? false,
    createdAt: Date.now(),
  };

  await db.insert(chatMessages).values({
    id: message.id,
    campaignId,
    userId: row.userId,
    actorId: row.actorId,
    kind: row.kind,
    body: row.body,
    rollData: row.rollData ?? null,
    cardData: (row.cardData ?? null) as Record<string, unknown> | null,
    whisperToUserId: row.whisperToUserId ?? null,
    combat: message.combat,
    createdAt: message.createdAt,
  });

  deliver(io, campaignId, message);
  return message;
}

/** The actor a player is speaking as, if they are allowed to speak as it. */
async function resolveActor(actorId: string | null, userId: string): Promise<Actor | null> {
  if (!actorId) return null;
  const access = await getActorAccess(actorId, userId);
  if (!access || access.level < 3) return null;
  return access.actor;
}

/* ------------------------------------------------------------- cards */

function buildCard(
  item: Item,
  actor: Actor,
  aimedAt: { targetTokenId: string | null; longRange: boolean } = {
    targetTokenId: null,
    longRange: false,
  },
): WireCard {
  const s = item.system as Record<string, any>;
  const actions: WireCard['actions'] = [];
  let subtitle = '';
  let saveAbility: string | null = null;
  let saveDC: number | null = null;

  if (item.type === 'weapon') {
    actions.push('attack', 'damage');
    if (s.versatileDice) actions.push('versatile');
    subtitle = [s.damageDice, s.damageType].filter(Boolean).join(' ');
  } else if (item.type === 'spell') {
    subtitle = [
      s.level === 0 ? 'Cantrip' : `Level ${s.level}`,
      s.school,
      s.rangeText,
    ]
      .filter(Boolean)
      .join(' · ');

    if (s.attackRoll) actions.push('attack');
    if (s.damageDice) actions.push('damage');
  } else {
    subtitle = item.type;
  }

  /**
   * The save button, for anything that forces one.
   *
   * Offered for every item type rather than only spells, and from the condition
   * an item inflicts as well as from its own `save` blob. Both halves were
   * unreachable without this: a hand-entered net with `appliesConditions` had no
   * button to press at all, and the SRD ships Web and Sleet Storm with no `dc`
   * block, so the curated entries for them could never fire either. An item you
   * cannot make bite is decorative.
   */
  const forced = saveProfileFor(item, actor);
  if (forced) {
    actions.push('save');
    saveAbility = forced.ability;
    saveDC = forced.dc;
  }

  return {
    itemId: item.id,
    actorId: actor.id,
    itemType: item.type,
    itemName: item.name,
    subtitle,
    description: (s.description ?? '').slice(0, 2000),
    actions,
    saveAbility,
    saveDC,
    targetTokenId: aimedAt.targetTokenId,
    longRange: aimedAt.longRange,
  };
}

/* ---------------------------------------------------------- handlers */

export function registerChatHandlers(io: IOServer, socket: ChatSocket): void {
  const user = socket.data.user;

  /** Membership is verified per event; joining a room is not authorization. */
  async function guard(campaignId: string): Promise<boolean> {
    const membership = await getMembership(campaignId, user.id);
    if (!membership) {
      socket.emit('error', { message: 'You are not in that campaign', code: 'NOT_A_MEMBER' });
      return false;
    }
    return true;
  }

  function activeCampaign(): string | null {
    const [first] = socket.data.rooms.keys();
    return first ?? null;
  }

  socket.on('chat:send', async (payload) => {
    const campaignId = activeCampaign();
    if (!campaignId || !(await guard(campaignId))) return;

    const input = sendMessageSchema.parse(payload);

    if (input.whisperToUserId && !(await mayWhisper(campaignId, user.id, input.whisperToUserId))) {
      // Deliberately vague. "They are four squares away" is itself a position
      // leak when the other token is somewhere this player cannot see.
      socket.emit('error', { message: 'You cannot whisper them from here' });
      return;
    }

    const actor = await resolveActor(input.actorId, user.id);

    await persistAndDeliver(
      io,
      campaignId,
      {
        userId: user.id,
        actorId: actor?.id ?? null,
        kind: 'text',
        body: input.body,
        whisperToUserId: input.whisperToUserId,
      },
      { authorName: user.displayName, actorName: actor?.name ?? null },
    );
  });

  /**
   * One check, rolled for every player character at once.
   *
   * Replaces the DM asking four people in turn and waiting. Modifiers come
   * from the same rules functions the sheet displays, so a group Perception
   * check agrees with what each player can see on their own sheet.
   */
  socket.on('chat:groupRoll', async (payload) => {
    const campaignId = activeCampaign();
    if (!campaignId) return;

    const membership = await getMembership(campaignId, user.id);
    if (!membership?.isDM) {
      socket.emit('error', { message: 'Only the DM can call for a group roll' });
      return;
    }

    const input = groupRollSchema.parse(payload);

    // Player characters only. NPC sheets are the DM's business, and rolling
    // for them here would quietly reveal the bestiary.
    const party = await db
      .select({ actor: actors })
      .from(actorCampaigns)
      .innerJoin(actors, eq(actorCampaigns.actorId, actors.id))
      .where(and(eq(actorCampaigns.campaignId, campaignId), eq(actors.type, 'character')));

    if (party.length === 0) {
      socket.emit('error', { message: 'No characters are assigned to this campaign' });
      return;
    }

    const label = describeGroupRoll(input);
    const lines: string[] = [];

    for (const { actor } of party) {
      const scores = {
        str: actor.str, dex: actor.dex, con: actor.con,
        int: actor.int, wis: actor.wis, cha: actor.cha,
      };

      let modifier = 0;
      if (input.kind === 'skill') {
        const level = (actor.skillProficiencies?.[input.key as never] ?? 0) as 0 | 1 | 2;
        modifier = skillBonus(scores, actor.level, input.key as never, level);
      } else if (input.kind === 'save') {
        const proficient = Boolean(actor.saveProficiencies?.[input.key as never]);
        modifier = savingThrowBonus(scores, actor.level, input.key as never, proficient);
      } else {
        modifier = abilityModifier(scores[input.key as keyof typeof scores] ?? 10);
      }

      const expression = modifier >= 0 ? `1d20+${modifier}` : `1d20${modifier}`;
      const roll = rollExpression(expression, actor.name);

      const verdict =
        input.dc === null ? '' : roll.total >= input.dc ? '  ✓' : '  ✗';
      lines.push(`${actor.name}: ${roll.output}${verdict}`);
    }

    const header = input.dc === null ? label : `${label} (DC ${input.dc})`;
    const body = [header, ...lines].join(String.fromCharCode(10));

    await persistAndDeliver(
      io,
      campaignId,
      {
        userId: user.id,
        actorId: null,
        kind: 'system',
        body,
        // A secret group roll reaches only the DM, like a secret single roll.
        whisperToUserId: input.secret ? user.id : null,
      },
      { authorName: user.displayName, actorName: null },
    );
  });

  socket.on('chat:roll', async (payload) => {
    const campaignId = activeCampaign();
    if (!campaignId || !(await guard(campaignId))) return;

    const input = rollRequestSchema.parse(payload);
    const actor = await resolveActor(input.actorId, user.id);

    let result: RollResult;
    try {
      // Rolled here, on the server. The client only ever sent a string.
      result = rollExpression(input.expression, input.label);
    } catch (err) {
      socket.emit('error', { message: err instanceof Error ? err.message : 'Bad dice expression' });
      return;
    }

    const whisperToUserId = input.secret ? await dmOf(campaignId) : null;

    await persistAndDeliver(
      io,
      campaignId,
      {
        userId: user.id,
        actorId: actor?.id ?? null,
        kind: 'roll',
        body: input.label || input.expression,
        rollData: result,
        whisperToUserId,
      },
      { authorName: user.displayName, actorName: actor?.name ?? null },
    );
  });

  socket.on('chat:card', async (payload) => {
    const campaignId = activeCampaign();
    if (!campaignId || !(await guard(campaignId))) return;

    const input = cardRequestSchema.parse(payload);
    const actor = await resolveActor(input.actorId, user.id);
    if (!actor) {
      socket.emit('error', { message: 'You do not control that character' });
      return;
    }

    const found = await db.select().from(items).where(eq(items.id, input.itemId)).limit(1);
    const item = found[0];
    if (!item || item.ownerActorId !== actor.id) {
      socket.emit('error', { message: 'That item is not on this sheet' });
      return;
    }

    await persistAndDeliver(
      io,
      campaignId,
      {
        userId: user.id,
        actorId: actor.id,
        kind: 'card',
        body: item.name,
        cardData: buildCard(item, actor, {
          targetTokenId: input.targetTokenId,
          longRange: input.longRange,
        }),
      },
      { authorName: user.displayName, actorName: actor.name },
    );
  });

  socket.on('chat:cardAction', async (payload) => {
    const campaignId = activeCampaign();
    if (!campaignId || !(await guard(campaignId))) return;

    const input = cardActionSchema.parse(payload);
    const actor = await resolveActor(input.actorId, user.id);
    if (!actor) {
      socket.emit('error', { message: 'You do not control that character' });
      return;
    }

    const found = await db.select().from(items).where(eq(items.id, input.itemId)).limit(1);
    const item = found[0];
    if (!item || item.ownerActorId !== actor.id) {
      socket.emit('error', { message: 'That item is not on this sheet' });
      return;
    }

    const scores = scoresOf(actor);
    const s = item.system as Record<string, any>;
    let expression: string;
    let label: string;

    // Resolved through `tokenIn`, so a token id borrowed from another campaign
    // is simply not found rather than acted on.
    const target = input.targetTokenId ? await tokenIn(input.targetTokenId, campaignId) : null;
    let saveAgainst: { token: Token; dc: number; ability: AbilityKey } | null = null;

    /**
     * Advantage and disadvantage from conditions, recomputed here.
     *
     * The target panel worked this out correctly and printed "Attacks at
     * advantage — target is prone", and then the roll went out straight, because
     * the mode never travelled with the card. Recomputed server-side rather than
     * taken from the client for the same reason ping colour is: `input.mode` is
     * the player's own circumstantial call (long range, flanking) and is honoured
     * on top, but a condition on the board applies whether or not the client
     * remembered it.
     */
    const conditionMode = target
      ? attackModeAgainst(
          { conditions: await conditionsOn(campaignId, actor.id) },
          { conditions: await conditionsOnToken(target.id) },
        )
      : { mode: 'normal' as const, reasons: [] as string[] };
    const mode = combineRollModes(input.mode, conditionMode.mode);

    switch (input.action) {
      case 'attack':
        expression =
          item.type === 'spell'
            ? attackExpression(
                { ability: actor.spellcastingAbility as AbilityKey | undefined, proficient: true },
                scores,
                actor.level,
                mode,
              )
            : attackExpression(s, scores, actor.level, mode);
        // Named, so the table can see which condition earned it rather than
        // wondering why two dice appeared.
        label =
          conditionMode.reasons.length > 0
            ? `${item.name} — attack at ${mode} (${conditionMode.reasons.join('; ')})`
            : `${item.name} — attack`;
        break;

      case 'damage':
      case 'critical':
      case 'versatile':
        expression =
          item.type === 'spell'
            ? // Spell damage does not add the casting modifier.
              input.action === 'critical'
              ? damageExpression({ damageDice: s.damageDice, ability: 'str' }, { ...scores, str: 10 }, { critical: true })
              : s.damageDice
            : damageExpression(s, scores, {
                critical: input.action === 'critical',
                versatile: input.action === 'versatile',
              });
        label = `${item.name} — ${input.action === 'critical' ? 'critical damage' : 'damage'}`;
        break;

      case 'save': {
        const forced = saveProfileFor(item, actor);
        const ability = forced?.ability ?? 'dex';

        // A spell save belongs to the TARGET, not the caster. This rolled the
        // caster's own save against the caster's own DC - the wrong creature and
        // the wrong number, on every spell anyone has ever cast from a card.
        // With no target it stays the caster's, which is what a scroll or a trap
        // read off your own sheet actually wants.
        const saver = target ? await actorOfToken(target) : null;

        if (target) {
          // The same number the card printed, from the same function.
          const dc = forced?.dc ?? 10;
          saveAgainst = { token: target, dc, ability };

          // A token with no sheet behind it has no ability scores to use, so it
          // rolls flat rather than borrowing somebody else's.
          expression = saver
            ? savingThrowExpression(
                scoresOf(saver),
                saver.level,
                ability,
                Boolean(saver.saveProficiencies?.[ability]),
                input.mode,
              )
            : '1d20';
          label = `${target.name} — ${ability.toUpperCase()} save vs ${item.name} (DC ${dc})`;
          break;
        }

        // Proficiency was hardcoded false here, so a save rolled off a card
        // ignored the character's proficiency and came out short by the whole
        // proficiency bonus - silently, and only on this path.
        const proficient = Boolean(actor.saveProficiencies?.[ability]);
        expression = savingThrowExpression(scores, actor.level, ability, proficient, input.mode);
        label = `${item.name} — ${ability.toUpperCase()} save`;
        break;
      }
    }

    if (!expression) {
      socket.emit('error', { message: `${item.name} has no damage to roll` });
      return;
    }

    let result: RollResult;
    try {
      result = rollExpression(expression, label);
    } catch (err) {
      socket.emit('error', { message: err instanceof Error ? err.message : 'Bad dice expression' });
      return;
    }

    await persistAndDeliver(
      io,
      campaignId,
      {
        userId: user.id,
        actorId: actor.id,
        kind: 'roll',
        body: label,
        rollData: result,
        // Swinging something is combat; rolling a save off a card is not
        // necessarily, so it stays in the conversation.
        combat: input.action !== 'save',
      },
      { authorName: user.displayName, actorName: actor.name },
    );

    if (saveAgainst) {
      await resolveSave(io, campaignId, user.id, item, actor, saveAgainst, result.total);
    }
  });

  /**
   * Wipes the campaign's log.
   *
   * One table holds both tabs, so this takes the battle log with it - the
   * client's confirm says as much. DM-only, re-checked here rather than trusted
   * from the room the socket happens to be in.
   */
  socket.on('chat:clear', async () => {
    const campaignId = activeCampaign();
    if (!campaignId) return;

    const membership = await getMembership(campaignId, user.id);
    if (!membership?.isDM) {
      socket.emit('error', { message: 'Only the DM can clear the log' });
      return;
    }

    await db.delete(chatMessages).where(eq(chatMessages.campaignId, campaignId));
    io.to(campaignRoom(campaignId)).emit('chat:cleared', {});
  });

  /** Recent history, filtered to what this user is allowed to have seen. */
  socket.on('campaign:join', async ({ campaignId }) => {
    if (!(await guard(campaignId))) return;

    const membership = await getMembership(campaignId, user.id);
    const rows = await db
      .select({
        message: chatMessages,
        authorName: users.displayName,
        actorName: actors.name,
      })
      .from(chatMessages)
      .innerJoin(users, eq(chatMessages.userId, users.id))
      .leftJoin(actors, eq(chatMessages.actorId, actors.id))
      .where(
        membership?.isDM
          ? eq(chatMessages.campaignId, campaignId)
          : and(
              eq(chatMessages.campaignId, campaignId),
              // Public messages, whispers addressed to them, and their own.
              or(
                isNull(chatMessages.whisperToUserId),
                eq(chatMessages.whisperToUserId, user.id),
                eq(chatMessages.userId, user.id),
              ),
            ),
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(HISTORY_LIMIT);

    const messages: WireChatMessage[] = rows
      .map(({ message, authorName, actorName }) => ({
        id: message.id,
        campaignId: message.campaignId,
        userId: message.userId,
        authorName,
        actorName,
        kind: message.kind,
        body: message.body,
        rollData: message.rollData ?? null,
        cardData: (message.cardData ?? null) as WireCard | null,
        whisperToUserId: message.whisperToUserId,
        combat: message.combat,
        createdAt: message.createdAt,
      }))
      .reverse();

    socket.emit('chat:history', { messages });
  });
}

/**
 * Whether one member may whisper another.
 *
 * Two separate rules, and the first one is a hole rather than a feature: the
 * recipient was never validated at all. `whisperToUserId` went straight to
 * `io.to(userRoom(id))`, and every socket joins its own personal room on connect
 * regardless of campaign - so a member could whisper ANY user id on the server,
 * including someone in a different game, and they received it.
 *
 * The second is the table's rule: players may whisper each other only when their
 * tokens are adjacent on the board. The DM is exempt in both directions - the DM
 * speaks as the table, and passing the DM a note is never gated.
 *
 * Adjacency is measured footprint to footprint by `tokenDistance`, which returns
 * 1 for touching squares including diagonals, so standing against a Gargantuan
 * ally's flank counts. Any token you control against any token they control, so
 * a player running two characters is not punished for it.
 */
async function mayWhisper(
  campaignId: string,
  senderId: string,
  recipientId: string,
): Promise<boolean> {
  // A whisper to yourself is how a secret group roll is modelled.
  if (senderId === recipientId) return true;

  const [sender, recipient] = await Promise.all([
    getMembership(campaignId, senderId),
    getMembership(campaignId, recipientId),
  ]);

  if (!sender || !recipient) return false;
  if (sender.isDM || recipient.isDM) return true;

  // Only the scene the table is actually looking at. A token parked on some
  // other map is not next to anybody.
  const rows = await db
    .select({ token: tokens })
    .from(tokens)
    .innerJoin(scenes, eq(tokens.sceneId, scenes.id))
    .innerJoin(campaigns, eq(campaigns.activeSceneId, scenes.id))
    .where(
      and(eq(campaigns.id, campaignId), inArray(tokens.ownerUserId, [senderId, recipientId])),
    );

  const onBoard = rows.map((row) => row.token).filter((token) => token.layer !== 'gm');
  const mine = onBoard.filter((token) => token.ownerUserId === senderId);
  const theirs = onBoard.filter((token) => token.ownerUserId === recipientId);

  return mine.some((a) => theirs.some((b) => tokenDistance(a, b) <= 1));
}

/**
 * Conditions on a token, straight from the effects store.
 *
 * The wire token has them too, but this path has no payload to hand - and the
 * server should be reading its own tables to decide a roll rather than trusting
 * what a client last received.
 */
async function conditionsOnToken(tokenId: string): Promise<string[]> {
  const rows = await effectsByToken([tokenId]);
  return conditionsOf(rows.get(tokenId));
}

/**
 * Conditions on the token the caster is currently standing on the board as.
 *
 * A character can have a token on several scenes, so this looks only at the
 * campaign's active one - the fight actually happening.
 */
async function conditionsOn(campaignId: string, actorId: string): Promise<string[]> {
  const rows = await db
    .select({ tokenId: tokens.id })
    .from(tokens)
    .innerJoin(scenes, eq(tokens.sceneId, scenes.id))
    .innerJoin(campaigns, eq(campaigns.activeSceneId, scenes.id))
    .where(and(eq(campaigns.id, campaignId), eq(tokens.actorId, actorId)))
    .limit(1);

  const tokenId = rows[0]?.tokenId;
  return tokenId ? conditionsOnToken(tokenId) : [];
}

/** The sheet behind a token, if it has one. */
async function actorOfToken(token: Token): Promise<Actor | null> {
  if (!token.actorId) return null;
  const rows = await db.select().from(actors).where(eq(actors.id, token.actorId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Whether a player may condition this token.
 *
 * The same rule damage follows: monsters yes, anybody's character no. An owned
 * token is somebody's character by construction, and a token linked to a
 * `character` actor is one even when the DM placed it unowned - so both are
 * checked rather than trusting the ownership column alone.
 */
async function isFairGame(token: Token): Promise<boolean> {
  if (token.ownerUserId) return false;
  if (!token.actorId) return true;

  const rows = await db
    .select({ type: actors.type })
    .from(actors)
    .where(eq(actors.id, token.actorId))
    .limit(1);
  return rows[0]?.type !== 'character';
}

/** A line from the table, flagged for the battle log - a save landing is combat. */
async function postLine(
  io: IOServer,
  campaignId: string,
  userId: string,
  body: string,
): Promise<void> {
  await persistAndDeliver(
    io,
    campaignId,
    { userId, actorId: null, kind: 'system', body, combat: true },
    { authorName: 'Table', actorName: null },
  );
}

/**
 * Applies what a failed save earned.
 *
 * The save has already been rolled and posted, so the table sees the number
 * before anything happens to the board - the automation is the bookkeeping, not
 * the ruling. A success says so and stops.
 *
 * Nothing is applied to another player's character: the caster is a player often
 * enough, and whose fighter is paralysed is not a thing one player decides for
 * another. Those the DM applies by hand, which is the old behaviour.
 */
async function resolveSave(
  io: IOServer,
  campaignId: string,
  userId: string,
  item: Item,
  caster: Actor,
  against: { token: Token; dc: number; ability: AbilityKey },
  rolled: number,
): Promise<void> {
  const inflicted = conditionsInflictedBy(item);
  if (inflicted.length === 0) return;

  if (rolled >= against.dc) {
    await postLine(
      io,
      campaignId,
      userId,
      `${against.token.name} makes the save (${rolled} vs DC ${against.dc}).`,
    );
    return;
  }

  // The DM may condition anyone; a player is held to the same line as damage.
  const membership = await getMembership(campaignId, userId);
  if (!membership?.isDM && !(await isFairGame(against.token))) {
    await postLine(
      io,
      campaignId,
      userId,
      `${against.token.name} fails (${rolled} vs DC ${against.dc}) — the DM applies the effect.`,
    );
    return;
  }

  const round = await currentRound(campaignId);
  const applied: string[] = [];

  for (const entry of inflicted) {
    const duration =
      entry.rounds !== null && round !== null ? { rounds: entry.rounds, startRound: round } : null;
    await applyCondition(against.token.id, entry.condition, duration, item.id);
    applied.push(duration ? `${entry.condition} for ${entry.rounds} rounds` : entry.condition);
  }

  await postLine(
    io,
    campaignId,
    userId,
    `${against.token.name} fails (${rolled} vs DC ${against.dc}) — ${applied.join(', ')} from ${caster.name}'s ${item.name}.`,
  );

  const { broadcastSceneState, invalidateDragCache } = await import('./scene.js');
  invalidateDragCache(against.token.sceneId);
  await broadcastSceneState(io, campaignId);

  const { broadcastEncounter } = await import('./combat.js');
  await broadcastEncounter(io, campaignId);
}

/** A readable title for the group roll card. */
function describeGroupRoll(input: GroupRollPayload): string {
  if (input.kind === 'skill') {
    const skill = SKILLS[input.key as keyof typeof SKILLS];
    return `Group ${skill?.name ?? input.key} check`;
  }
  if (input.kind === 'save') return `Group ${input.key.toUpperCase()} saving throw`;
  return `Group ${input.key.toUpperCase()} check`;
}
