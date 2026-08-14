import { and, desc, eq, isNull, or } from 'drizzle-orm';
import {
  attackExpression,
  campaignDmRoom,
  campaignRoom,
  cardActionSchema,
  cardRequestSchema,
  damageExpression,
  rollRequestSchema,
  savingThrowExpression,
  sendMessageSchema,
  spellSaveDC,
  userRoom,
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
import { actorCampaigns, actors, campaigns, chatMessages, items, users } from '../db/schema.js';
import { getMembership } from '../auth/guards.js';
import { getActorAccess } from '../lib/access.js';
import { rollExpression } from '../lib/dice.js';
import { newId } from '../lib/id.js';
import type { IOServer, SocketData } from './index.js';
import type { Actor, Item } from '../db/schema.js';

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

const HISTORY_LIMIT = 100;

function scoresOf(actor: Actor): AbilityScores {
  return { str: actor.str, dex: actor.dex, con: actor.con, int: actor.int, wis: actor.wis, cha: actor.cha };
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

function buildCard(item: Item, actor: Actor): WireCard {
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
    if (s.save?.ability) {
      actions.push('save');
      saveAbility = s.save.ability;
      saveDC = actor.spellcastingAbility
        ? spellSaveDC(scoresOf(actor), actor.level, actor.spellcastingAbility as AbilityKey)
        : null;
    }
  } else {
    subtitle = item.type;
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
        cardData: buildCard(item, actor),
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

    switch (input.action) {
      case 'attack':
        expression =
          item.type === 'spell'
            ? attackExpression(
                { ability: actor.spellcastingAbility as AbilityKey | undefined, proficient: true },
                scores,
                actor.level,
                input.mode,
              )
            : attackExpression(s, scores, actor.level, input.mode);
        label = `${item.name} — attack`;
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
        const ability = (s.save?.ability ?? 'dex') as AbilityKey;
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

/** A readable title for the group roll card. */
function describeGroupRoll(input: GroupRollPayload): string {
  if (input.kind === 'skill') {
    const skill = SKILLS[input.key as keyof typeof SKILLS];
    return `Group ${skill?.name ?? input.key} check`;
  }
  if (input.kind === 'save') return `Group ${input.key.toUpperCase()} saving throw`;
  return `Group ${input.key.toUpperCase()} check`;
}
