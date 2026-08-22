import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  attackBonusParts,
  attackModeAgainst,
  attackExpression,
  campaignDmRoom,
  campaignRoom,
  combineRollModes,
  cardActionSchema,
  cardRequestSchema,
  damageBonusParts,
  damageExpression,
  doubleDice,
  rollRequestSchema,
  savingThrowExpression,
  sendMessageSchema,
  tokenDistanceInFeet,
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
  WireAttack,
  WireAttackDamage,
  WireCard,
  WireChatMessage,
} from '@dnd/shared';
import {
  abilityModifier,
  attackVerdict,
  OUTCOME_WORD,
  groupAnswerSchema,
  groupRollSchema,
  publishedMonsterBonus,
  savingThrowBonus,
  skillBonus,
  SKILLS,
  type GroupRollPayload,
  type WireGroupRoll,
} from '@dnd/shared';
import { db } from '../db/index.js';
import {
  actorCampaigns,
  actors,
  campaigns,
  chatMessages,
  items,
  scenes,
  srdMonsters,
  tokens,
  users,
} from '../db/schema.js';
import { getMembership } from '../auth/guards.js';
import { getActorAccess } from '../lib/access.js';
import { rollExpression } from '../lib/dice.js';
import { newId } from '../lib/id.js';
import { applyCondition, conditionsOf, currentRound, effectsByToken } from '../lib/effects.js';
import { itemNumbers, rollsToHit, scoresOf } from '../lib/itemNumbers.js';
// `isFairGame` was written out twice, here and in combat.ts, word for word -
// the rule about whose hit points a player may move. One copy now, because two
// readings of that question is one reading plus a hole.
import { applyDamageTo, isFairGame } from './combat.js';
import { tokenIn } from './scene.js';
import type { IOServer, SocketData } from './index.js';
import type { Actor, Item, Token } from '../db/schema.js';

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

const HISTORY_LIMIT = 100;

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
    kind: 'text' | 'roll' | 'card' | 'system' | 'levelup';
    body: string;
    rollData?: RollResult | null;
    cardData?: WireCard | null;
    groupData?: WireGroupRoll | null;
    attackData?: WireAttack | null;
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
    groupData: row.groupData ?? null,
    attackData: row.attackData ?? null,
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
    groupData: (row.groupData ?? null) as Record<string, unknown> | null,
    attackData: (row.attackData ?? null) as Record<string, unknown> | null,
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

/**
 * The damage an item deals, weapon or spell.
 *
 * One function because there were two, and they disagreed. The `damage` button
 * knew that spell damage adds no ability modifier and went to some trouble to
 * cancel it; the damage rolled automatically by a landing attack did not, and
 * read the spell's blob as if it were a weapon - where `ability` is absent and
 * so defaults to `str`. Every Fire Bolt that hit therefore rolled `1d10` plus
 * the wizard's *Strength* modifier, which for a wizard is usually a penalty.
 * Two ways of answering one question is one answer plus a bug.
 */
function damageFor(
  item: Item,
  scores: AbilityScores,
  options: { critical?: boolean; versatile?: boolean } = {},
): string {
  const s = item.system as Record<string, any>;
  const dice = String(s.damageDice ?? '');

  // A spell's damage is what the spell says, doubled on a critical and
  // otherwise untouched.
  if (item.type === 'spell') return options.critical ? doubleDice(dice) : dice;

  return damageExpression(s, scores, options);
}

function buildCard(item: Item, actor: Actor, targetTokenId: string | null = null): WireCard {
  const s = item.system as Record<string, any>;
  const actions: WireCard['actions'] = [];
  let subtitle = '';
  let saveAbility: string | null = null;
  let saveDC: number | null = null;

  if (item.type === 'weapon') {
    // One button. Attack rolls to hit and then rolls the damage itself when it
    // lands, so there is nothing to press twice and no damage rolled for a
    // swing that missed - which is also the difference nobody could see
    // between the two buttons that used to be here.
    //
    // A versatile weapon adds no button either: the second grip travels on the
    // attack as a choice, because `Two-handed` beside `Attack` rolled damage
    // with no attack roll in front of it and there was no way to learn that
    // except by pressing it.
    if (rollsToHit(item)) actions.push('attack');
    // Reach and properties, not the dice: `numbers` prints `1d8+4 slashing
    // damage` right underneath, and the same fact in two spellings a line apart
    // is noise on a card whose whole problem was that it said too little.
    subtitle = [
      s.range?.type === 'ranged' && s.range?.long
        ? `${s.range.value}/${s.range.long} ft`
        : `${s.range?.value ?? 5} ft reach`,
      ...(s.properties ?? []),
    ]
      .filter(Boolean)
      .join(' · ');
  } else if (item.type === 'spell') {
    subtitle = [
      s.level === 0 ? 'Cantrip' : `Level ${s.level}`,
      s.school,
      s.rangeText,
    ]
      .filter(Boolean)
      .join(' · ');

    // A spell that rolls to hit chains into its damage exactly as a weapon
    // does. One that does not - a fireball - keeps its own damage button,
    // because there is no attack roll for the damage to hang off.
    if (rollsToHit(item)) actions.push('attack');
    if (s.damageDice && !s.attackRoll) actions.push('damage');
  } else if (item.type === 'consumable') {
    // A potion used to post a card with a name and nothing to press. It gets
    // buttons only where a DM has filled in the dice: the SRD keeps a potion's
    // numbers inside its prose, and reading mechanics out of prose is the one
    // thing this codebase refuses to do.
    if (s.damageDice) actions.push('damage');
    if (s.healingDice) actions.push('heal');
    subtitle = [
      s.consumableType,
      s.healingDice ? `heals ${s.healingDice}` : '',
      [s.damageDice, s.damageType].filter(Boolean).join(' '),
    ]
      .filter(Boolean)
      .join(' · ');
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
    numbers: itemNumbers(item, actor),
    saveAbility,
    saveDC,
    targetTokenId,
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

  /** The campaign this socket is acting in, set when it joined. */
  function activeCampaign(): string | null {
    return socket.data.activeCampaignId;
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
   * One check, rolled for several creatures at once.
   *
   * The two halves behave differently on purpose. `creatures` **rolls**: the
   * DM's own monsters have nobody to ask, and a fireball landing on six goblins
   * is six saves otherwise done by hand off a stat block the app is already
   * holding. `party` **asks**: it posts the request with a row per character
   * and waits for each player to press their own button, because rolling their
   * dice for them takes the moment off them - which is why asking the party was
   * removed once already, and the reason it is back in this shape.
   *
   * Modifiers come from the same rules functions each sheet displays, so a
   * group Perception check agrees with what a player sees on their own
   * character - except for a creature stamped from the bestiary, whose numbers
   * are copied rather than recomputed. See `groupModifier`.
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

    const rollers =
      input.who === 'creatures'
        ? await creatureRollers(campaignId, input.tokenIds)
        : await partyRollers(campaignId);

    if (rollers.length === 0) {
      socket.emit('error', {
        message:
          input.who === 'creatures'
            ? 'None of those creatures has a stat block to roll from'
            : 'No characters are assigned to this campaign',
      });
      return;
    }

    const label = describeGroupRoll(input);

    // The party is asked and the DM's creatures are rolled. That is the only
    // difference between the two halves once the rollers are in hand.
    const rows: WireGroupRoll['rows'] = rollers.map((roller) =>
      input.who === 'party'
        ? {
            name: roller.name,
            // Left open for its owner to answer. The modifier is worked out
            // now rather than at answer time, so the request can show what the
            // player is about to add - and it is public anyway, since the party
            // panel already prints it beside every name.
            actorId: roller.actorId,
            tokenId: roller.tokenId,
            dice: [],
            modifier: groupModifier(roller, input.kind, input.key),
            total: null,
            passed: null,
          }
        : rollRow(roller, input.kind, input.key, input.dc),
    );

    await persistAndDeliver(
      io,
      campaignId,
      {
        userId: user.id,
        actorId: null,
        kind: 'system',
        // Written out as text as well as sent as rows. A log that predates the
        // column, or a client that has not been rebuilt, still reads.
        body: groupBody(label, input.dc, rows),
        groupData: { label, dc: input.dc, rows },
        // Flagged on the check, not on who rolled. "A save landing is combat"
        // is the rule `postLine` already follows for a single one, and six
        // goblins saving against a fireball is the same event six times - it
        // belongs beside the damage that follows it, not in a second tab.
        // A group Perception check in a corridor is a conversation either way.
        combat: input.kind === 'save',
        // A secret group roll reaches only the DM, like a secret single roll.
        // Never on a request: somebody who cannot see it cannot answer it, and
        // the panel hides the toggle for that scope rather than relying on this.
        whisperToUserId: input.secret && input.who === 'creatures' ? user.id : null,
      },
      { authorName: user.displayName, actorName: null },
    );
  });

  /**
   * One person answering a group roll that is waiting on them.
   *
   * The pending state lives in the message rather than in a table of its own or
   * in memory: there is one source of truth, it survives a reload and a
   * restart, and somebody who joins late finds the request in their history
   * with the button still on it. The die is thrown here, on the server, like
   * every other die in this app.
   */
  socket.on('chat:groupAnswer', async (payload) => {
    const campaignId = activeCampaign();
    if (!campaignId) return;

    const input = groupAnswerSchema.parse(payload);

    // Scoped to the campaign, like every other client-supplied id.
    const found = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.id, input.messageId), eq(chatMessages.campaignId, campaignId)))
      .limit(1);

    const message = found[0];
    const group = message?.groupData as WireGroupRoll | null | undefined;
    if (!message || !group) return;

    // A creature row carries a null `actorId` and so can never match: those are
    // rolled when the DM asks and there is nobody left to ask.
    const index = group.rows.findIndex(
      (row) => row.actorId === input.actorId && row.total === null,
    );
    // Already answered, or never asked. Silently, because two tabs racing the
    // same button is one person pressing it once, not an error worth showing.
    if (index === -1) return;

    // Yours to roll, or the DM's. The DM fills in for whoever is not at the
    // table tonight - a request that can never be completed would otherwise sit
    // open on the card for the rest of the session.
    const membership = await getMembership(campaignId, user.id);
    const mine = await resolveActor(input.actorId, user.id);
    if (!mine && !membership?.isDM) {
      socket.emit('error', { message: 'That roll is not yours to make' });
      return;
    }

    // The modifier already on the row, not a fresh one: it is what the player
    // was shown when they were asked, and recomputing it here would let a sheet
    // edited mid-request change the number under them.
    const rolled = rollWithModifier(group.rows[index].modifier, group.rows[index].name, group.dc);
    const rows = group.rows.map((row, at) => (at === index ? { ...row, ...rolled } : row));
    const next: WireGroupRoll = { ...group, rows };
    const body = groupBody(group.label, group.dc, rows);

    await db
      .update(chatMessages)
      .set({ groupData: next as unknown as Record<string, unknown>, body })
      .where(eq(chatMessages.id, message.id));

    // Re-delivered under the same id, so the client replaces rather than
    // appends - one card that fills in, not a card per answer.
    const author = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, message.userId))
      .limit(1);

    deliver(io, campaignId, {
      id: message.id,
      campaignId,
      userId: message.userId,
      authorName: author[0]?.displayName ?? 'Table',
      actorName: null,
      kind: message.kind,
      body,
      rollData: message.rollData ?? null,
      cardData: (message.cardData ?? null) as WireCard | null,
      groupData: next,
      attackData: (message.attackData ?? null) as WireAttack | null,
      whisperToUserId: message.whisperToUserId ?? null,
      combat: message.combat,
      createdAt: message.createdAt,
    });
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

    // Resolved rather than echoed: an id from another campaign is simply not
    // found, the same rule every other handler follows.
    const aimedAt = input.targetTokenId
      ? await tokenIn(input.targetTokenId, campaignId)
      : null;

    await persistAndDeliver(
      io,
      campaignId,
      {
        userId: user.id,
        actorId: actor.id,
        kind: 'card',
        body: item.name,
        cardData: buildCard(item, actor, aimedAt?.id ?? null),
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
    const caster = target ? await casterOn(campaignId, actor.id) : null;

    const conditionMode = target
      ? attackModeAgainst(
          { conditions: caster ? await conditionsOnToken(caster.token.id) : [] },
          { conditions: await conditionsOnToken(target.id) },
        )
      : { mode: 'normal' as const, reasons: [] as string[] };

    // Measured from where the two of them are standing right now.
    const farShot = Boolean(target && caster && longRangeShot(item, caster, target));
    const reasons = farShot ? [...conditionMode.reasons, 'beyond normal range'] : conditionMode.reasons;

    const mode = combineRollModes(
      input.mode,
      conditionMode.mode,
      farShot ? 'disadvantage' : 'normal',
    );

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
        // Who is swinging at whom, rather than a bare item name: a log full of
        // "Mace — attack" says nothing about who threw it or at what.
        label = target
          ? `${actor.name} attacks ${target.name} with ${item.name}`
          : `${actor.name} attacks with ${item.name}`;
        if (reasons.length > 0) label += ` (at ${mode}: ${reasons.join('; ')})`;
        break;

      case 'damage':
      case 'critical':
        expression = damageFor(item, scores, { critical: input.action === 'critical' });
        label = `${item.name} — ${input.action === 'critical' ? 'critical damage' : 'damage'}`;
        break;

      case 'heal':
        // Rolled and posted, never applied - exactly as damage behaves. Whose
        // hit points move stays the decision it already was, so this needs no
        // exception to "healing is the DM's".
        expression = String(s.healingDice ?? '');
        label = `${item.name} — healing`;
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

    /**
     * Hit or miss, said out loud.
     *
     * The roll was posted as a bare number and the player did the arithmetic -
     * even though this handler is holding both the total and the creature it
     * was aimed at. Comparing them here reveals nothing new: `ac` is on
     * `WireToken` for everyone who can see the token at all, unlike hit points,
     * and the board's hover tooltip has always printed it.
     *
     * A natural 20 hits and a natural 1 misses whatever the numbers say, which
     * is the one place the total is not the answer.
     */
    const struck =
      input.action === 'attack' && target && target.ac !== null && target.ac !== undefined
        ? attackVerdict(result.total, result.rolls[0], target.ac)
        : null;

    /**
     * The damage, rolled by the same press that landed the blow.
     *
     * Only on a hit: a swing that missed has no damage, and rolling it anyway
     * invites somebody to apply a number that never happened. A critical
     * doubles the dice here rather than needing its own button - the one case
     * where the attack roll changes what the damage roll is.
     *
     * It rides inside the attack rather than posting a message of its own. The
     * second message kept its Apply button and lost everything else: it named
     * the weapon and the target again because nothing tied it to the swing
     * above, and on a busy round it could arrive under two other rolls. The
     * button moves into the card with it - offered, never applied, because
     * whose hit points move is still a separate decision.
     */
    let damage: WireAttackDamage | null = null;
    if (struck?.hit && target && s.damageDice) {
      const twoHanded = Boolean(item.type === 'weapon' && input.versatile && s.versatileDice);
      const roll = rollExpression(
        damageFor(item, scores, { critical: struck.critical, versatile: twoHanded }),
        `${item.name} damage${struck.critical ? ' (critical)' : ''} to ${target.name}`,
      );

      // Decided before the card is built rather than after it is sent: the card
      // has to say whether the hit points have gone, and a button offered on a
      // blow that already landed is a way to apply it twice.
      const swinger = await getMembership(campaignId, user.id);
      const applied = Boolean(swinger?.isDM) || (await isFairGame(target));

      damage = {
        roll,
        type: String(s.damageType ?? ''),
        parts: damageBonusParts(s, scores, {
          published: actor.type === 'npc' && Boolean(actor.srdMonsterId),
          ability: item.type !== 'spell',
        }),
        critical: struck.critical,
        twoHanded,
        tokenId: target.id,
        applied,
      };
    }

    /**
     * The swing as one thing, rather than a sentence with the answer on the end.
     *
     * The body is still written out underneath, for the reason a group roll
     * writes its rows as text as well: a message stored before this column
     * existed still reads, and so does a client that has not been rebuilt.
     */
    const attackData: WireAttack | null =
      input.action === 'attack'
        ? {
            attacker: actor.name,
            target: target?.name ?? null,
            weapon: item.name,
            outcome: struck?.outcome ?? 'unresolved',
            reason: struck?.reason ?? (target ? 'no AC recorded' : 'no target'),
            mode,
            reasons,
            roll: result,
            toHitParts: attackBonusParts(
              item.type === 'spell'
                ? { ability: actor.spellcastingAbility as AbilityKey | undefined, proficient: true }
                : s,
              scores,
              actor.level,
              { published: actor.type === 'npc' && Boolean(actor.srdMonsterId) },
            ),
            damage,
          }
        : null;

    const body = attackData
      ? [
          label,
          `${OUTCOME_WORD[attackData.outcome]} — ${attackData.reason} (${result.output})`,
          damage
            ? `${damage.roll.expression}${damage.type ? ` ${damage.type}` : ''} damage: ${damage.roll.output}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : label;

    await persistAndDeliver(
      io,
      campaignId,
      {
        userId: user.id,
        actorId: actor.id,
        kind: 'roll',
        body,
        rollData: result,
        attackData,
        // Swinging something is combat; rolling a save off a card is not
        // necessarily, so it stays in the conversation.
        combat: input.action !== 'save',
      },
      { authorName: user.displayName, actorName: actor.name },
    );

    /**
     * A blow that landed takes the hit points, without being asked twice.
     *
     * Damage used to be offered rather than applied, because it gets rolled
     * for things that turn out not to count. That reason is gone here and only
     * here: this damage exists *because* an attack roll beat an armour class,
     * so there is nothing left to decide and the Apply button was a second
     * press confirming what the dice already said. Every other damage roll - a
     * fireball waiting on saves, a potion, the DM's own box - is still offered.
     *
     * Through `applyDamageTo`, the same path the button uses, so resistances,
     * the concentration save and the redaction all still happen. The rule about
     * whose hit points may move is unchanged: a player may subtract from a
     * monster and never from somebody's character, and the DM may touch
     * anything.
     */
    if (damage?.applied && target) {
      await applyDamageTo(io, campaignId, user.id, [target], {
        amount: damage.roll.total,
        damageType: damage.type,
      });
    }

    if (saveAgainst) {
      await resolveSave(io, campaignId, user.id, item, actor, saveAgainst, result.total);
    }

    // Nothing landed, so nothing will be applied - the board says so above the
    // creature rather than leaving it to be read out of the log.
    if (struck && !struck.hit && target) {
      io.to(campaignRoom(campaignId)).emit('attack:missed', { tokenId: target.id });
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
        groupData: (message.groupData ?? null) as WireGroupRoll | null,
        attackData: (message.attackData ?? null) as WireAttack | null,
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
async function casterOn(
  campaignId: string,
  actorId: string,
): Promise<{ token: Token; feetPerSquare: number } | null> {
  const rows = await db
    .select({ token: tokens, feetPerSquare: scenes.feetPerSquare })
    .from(tokens)
    .innerJoin(scenes, eq(tokens.sceneId, scenes.id))
    .innerJoin(campaigns, eq(campaigns.activeSceneId, scenes.id))
    .where(and(eq(campaigns.id, campaignId), eq(tokens.actorId, actorId)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Whether the shot is beyond normal range, measured now rather than when the
 * card was posted.
 *
 * The client used to work this out and send it with the card, which meant the
 * disadvantage was frozen at posting time: step into melee before pressing
 * Attack and the roll still carried it. Both circumstantial sources - the
 * target's conditions and the distance - are the server's to compute, for the
 * same reason ping colour is.
 */
function longRangeShot(
  item: Item,
  caster: { token: Token; feetPerSquare: number },
  target: Token,
): boolean {
  const range = (item.system as { range?: { value?: number; long?: number | null } }).range;
  if (!range?.long || !range.value) return false;

  const feet = tokenDistanceInFeet(caster.token, target, 'standard', caster.feetPerSquare);
  return feet > range.value && feet <= range.long;
}

/** The sheet behind a token, if it has one. */
async function actorOfToken(token: Token): Promise<Actor | null> {
  if (!token.actorId) return null;
  const rows = await db.select().from(actors).where(eq(actors.id, token.actorId)).limit(1);
  return rows[0] ?? null;
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

/**
 * One creature in a group roll, with everything its modifier needs.
 *
 * Flattened out of the actor row rather than passed as one, because a creature
 * rolls under the name on the *token* - five goblins off one stat block are
 * Goblin, Goblin 2 and Goblin 3 on the board and in the initiative order, and
 * five identical lines would be unreadable.
 */
interface GroupRoller {
  name: string;
  /** The sheet behind it, so a request knows whose row is whose. */
  actorId: string;
  /**
   * The creature on the board, where there is one.
   *
   * Carried so damage can be applied from the card. A creature roll always has
   * one - it started from a token; a character may not, if they have nothing
   * placed on the active scene.
   */
  tokenId: string | null;
  scores: AbilityScores;
  level: number;
  skillProficiencies: Actor['skillProficiencies'];
  saveProficiencies: Actor['saveProficiencies'];
  /** The stat block's own proficiencies, for a creature stamped from one. */
  published: unknown;
}

function rollerFromActor(
  actor: Actor,
  name: string,
  published: unknown,
  tokenId: string | null,
): GroupRoller {
  return {
    name,
    actorId: actor.id,
    tokenId,
    scores: {
      str: actor.str, dex: actor.dex, con: actor.con,
      int: actor.int, wis: actor.wis, cha: actor.cha,
    },
    level: actor.level,
    skillProficiencies: actor.skillProficiencies,
    saveProficiencies: actor.saveProficiencies,
    published,
  };
}

/**
 * The campaign's characters.
 *
 * Player characters only. NPC sheets are the DM's business, and rolling for
 * them here would quietly reveal the bestiary to anyone reading the log.
 *
 * Each one's token on the *active* scene comes along where they have one, so a
 * fireball that catches the party can be applied from the card exactly as one
 * that catches the goblins. Somebody with nothing on the board carries null and
 * is simply not damageable from there.
 */
async function partyRollers(campaignId: string): Promise<GroupRoller[]> {
  const rows = await db
    .select({ actor: actors })
    .from(actorCampaigns)
    .innerJoin(actors, eq(actorCampaigns.actorId, actors.id))
    .where(and(eq(actorCampaigns.campaignId, campaignId), eq(actors.type, 'character')));

  const placed = await db
    .select({ actorId: tokens.actorId, tokenId: tokens.id })
    .from(tokens)
    .innerJoin(scenes, eq(tokens.sceneId, scenes.id))
    .innerJoin(campaigns, eq(campaigns.activeSceneId, scenes.id))
    .where(eq(campaigns.id, campaignId));

  const onBoard = new Map(
    placed
      .filter((row): row is { actorId: string; tokenId: string } => Boolean(row.actorId))
      .map((row) => [row.actorId, row.tokenId]),
  );

  return rows.map(({ actor }) =>
    rollerFromActor(actor, actor.name, null, onBoard.get(actor.id) ?? null),
  );
}

/**
 * The creatures the DM named, as far as each one has a sheet to roll from.
 *
 * Ids are scoped through the scene's campaign, so one borrowed from another
 * table is simply not found - room membership authenticates and does not
 * authorize. A token somebody *owns* is dropped: rolling a player's dice for
 * them is the half of this feature that was asked to go, and it must not come
 * back through the creature list. A token with no sheet behind it is dropped
 * too, because there are no ability scores anywhere to roll against; the panel
 * greys those rather than hiding them, so the DM can see why one is missing.
 */
async function creatureRollers(campaignId: string, tokenIds: string[]): Promise<GroupRoller[]> {
  if (tokenIds.length === 0) return [];

  const rows = await db
    .select({ token: tokens, actor: actors })
    .from(tokens)
    .innerJoin(scenes, eq(tokens.sceneId, scenes.id))
    .leftJoin(actors, eq(tokens.actorId, actors.id))
    .where(and(inArray(tokens.id, tokenIds), eq(scenes.campaignId, campaignId)));

  const mine = rows
    .filter((row): row is { token: Token; actor: Actor } => !row.token.ownerUserId && Boolean(row.actor))
    // The order the DM sent, which is the order of the list they ticked.
    .sort((a, b) => tokenIds.indexOf(a.token.id) - tokenIds.indexOf(b.token.id));

  // One query for the stat blocks behind them, rather than one per goblin.
  const stampedIds = [
    ...new Set(mine.map((row) => row.actor.srdMonsterId).filter((v): v is string => Boolean(v))),
  ];
  const blocks =
    stampedIds.length === 0
      ? []
      : await db
          .select({ id: srdMonsters.id, data: srdMonsters.data })
          .from(srdMonsters)
          .where(inArray(srdMonsters.id, stampedIds));

  const published = new Map(
    blocks.map((block) => [
      block.id,
      (block.data as Record<string, unknown> | null)?.proficiencies ?? null,
    ]),
  );

  return mine.map(({ token, actor }) =>
    rollerFromActor(
      actor,
      token.name || actor.name,
      actor.srdMonsterId ? (published.get(actor.srdMonsterId) ?? null) : null,
      token.id,
    ),
  );
}

/**
 * What this creature adds to its d20.
 *
 * A stamped monster's published number wins outright, for the reason
 * `from-monster` cancels proficiency out of an attack: its actor row carries
 * level 1 and no proficiencies, because a stat line states neither. Recomputing
 * a goblin's Stealth from the sheet gives +2 where the book says +6, and an
 * Ancient Red Dragon's Dexterity save +0 where the book says +7. A block that
 * publishes nothing for the key falls through to the bare ability modifier,
 * which is exactly what a stat line with no such save means.
 *
 * A character, or an NPC written by hand, has no published block and uses its
 * own sheet - the same functions the sheet itself displays, so the two agree.
 */
function groupModifier(
  roller: GroupRoller,
  kind: GroupRollPayload['kind'],
  key: string,
): number {
  if (kind === 'ability') {
    return abilityModifier(roller.scores[key as AbilityKey] ?? 10);
  }

  const published = publishedMonsterBonus(roller.published, kind, key);
  if (published !== null) return published;

  if (kind === 'save') {
    const proficient = Boolean(roller.saveProficiencies?.[key as never]);
    return savingThrowBonus(roller.scores, roller.level, key as never, proficient);
  }

  const proficiency = (roller.skillProficiencies?.[key as never] ?? 0) as 0 | 1 | 2;
  return skillBonus(roller.scores, roller.level, key as never, proficiency);
}

/**
 * One rolled row.
 *
 * Shared by the creature path, which rolls every row at once, and by a single
 * answer arriving later - so a goblin's line and a player's line cannot come
 * out shaped differently.
 */
function rollWithModifier(
  modifier: number,
  label: string,
  dc: number | null,
): Pick<WireGroupRoll['rows'][number], 'dice' | 'modifier' | 'total' | 'passed'> {
  const expression = modifier >= 0 ? `1d20+${modifier}` : `1d20${modifier}`;
  const roll = rollExpression(expression, label);
  return {
    dice: roll.rolls,
    modifier,
    total: roll.total,
    passed: dc === null ? null : roll.total >= dc,
  };
}

function rollRow(
  roller: GroupRoller,
  kind: GroupRollPayload['kind'],
  key: string,
  dc: number | null,
): WireGroupRoll['rows'][number] {
  return {
    name: roller.name,
    // Nothing left to ask: the DM rolled it.
    actorId: null,
    tokenId: roller.tokenId,
    ...rollWithModifier(groupModifier(roller, kind, key), roller.name, dc),
  };
}

/**
 * The card written out as text.
 *
 * Rebuilt from the rows every time one is answered rather than appended to, so
 * the body and the rows cannot drift apart - and a request nobody ever answers
 * still reads as a request rather than as an empty roll.
 */
function groupBody(label: string, dc: number | null, rows: WireGroupRoll['rows']): string {
  const header = dc === null ? label : `${label} (DC ${dc})`;
  const lines = rows.map((row) => {
    if (row.total === null) return `${row.name}: waiting`;
    const sign = row.modifier >= 0 ? `+${row.modifier}` : `${row.modifier}`;
    const verdict = row.passed === null ? '' : row.passed ? '  ✓' : '  ✗';
    return `${row.name}: [${row.dice.join(' + ')}]${sign} = ${row.total}${verdict}`;
  });
  return [header, ...lines].join(String.fromCharCode(10));
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
