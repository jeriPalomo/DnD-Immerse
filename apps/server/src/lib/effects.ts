import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  CONDITION_EFFECTS,
  conditionEffect,
  deriveToken,
  expiredEffects,
  type ActiveEffect,
  type WireEffect,
} from '@dnd/shared';
import { db } from '../db/index.js';
import { activeEffects, encounters, scenes, tokens } from '../db/schema.js';
import { newId } from './id.js';
import type { ActiveEffect as EffectRow } from '../db/schema.js';

/**
 * The one store for conditions, buffs and debuffs.
 *
 * `active_effects` was built with durations, an expiry hook and unit tests and
 * then never given a single insert path, while conditions lived as a JSON array
 * on the token that only the browser understood. So the HUD showed a paralyzed
 * token Speed 0 while the server offered it a full 30 ft of movement range, at
 * the same time, on the same screen. Everything now goes through here.
 *
 * A condition row carries an empty `changes` and names the condition in
 * `statusId`; its mechanics are looked up from `CONDITION_EFFECTS` when the row
 * is read. Copying the changes into the row would freeze them, so a fix to what
 * "prone" means would apply only to tokens that went prone afterwards.
 */

/** Whether a `statusId` names one of the 5e conditions we model mechanically. */
export function isCondition(statusId: string | null): boolean {
  return statusId !== null && statusId in CONDITION_EFFECTS;
}

/**
 * A database row as the pure derive layer wants it.
 *
 * Condition rows get their changes from `CONDITION_EFFECTS`; a custom buff uses
 * the changes it was created with. `concentrating` is a real condition with no
 * mechanical changes, so it falls through to an empty list rather than null.
 */
export function toActiveEffect(row: EffectRow): ActiveEffect {
  const fromCondition = row.statusId ? conditionEffect(row.statusId) : null;

  return {
    id: row.id,
    name: row.name,
    changes: fromCondition ? fromCondition.changes : (row.changes ?? []),
    disabled: row.disabled,
    duration: row.duration ?? null,
    statusId: row.statusId,
  };
}

/**
 * Effects on each of the given tokens, keyed by token id.
 *
 * One query for a whole scene rather than one per token: this runs on every
 * scene payload, which is once per player per commit.
 */
export async function effectsByToken(tokenIds: string[]): Promise<Map<string, EffectRow[]>> {
  const byToken = new Map<string, EffectRow[]>();
  if (tokenIds.length === 0) return byToken;

  const rows = await db
    .select()
    .from(activeEffects)
    .where(inArray(activeEffects.ownerTokenId, tokenIds));

  for (const row of rows) {
    if (!row.ownerTokenId) continue;
    const list = byToken.get(row.ownerTokenId);
    if (list) list.push(row);
    else byToken.set(row.ownerTokenId, [row]);
  }

  return byToken;
}

/** The condition names on a token, which is what the board and HUD draw. */
export function conditionsOf(rows: EffectRow[] | undefined): string[] {
  if (!rows) return [];
  return rows
    .filter((row) => row.statusId !== null && !row.disabled)
    .map((row) => row.statusId as string);
}

/**
 * Effects as a player sees them, with the countdown resolved.
 *
 * `roundsRemaining` is computed from the encounter's current round rather than
 * stored, for the same reason ability modifiers are: a stored counter drifts
 * the moment a round is rewound.
 */
export function toWireEffects(rows: EffectRow[] | undefined, round: number | null): WireEffect[] {
  if (!rows) return [];

  return rows.map((row) => {
    const duration = row.duration ?? null;
    const remaining =
      duration && duration.rounds !== null && duration.startRound !== null && round !== null
        ? Math.max(0, duration.startRound + duration.rounds - round)
        : null;

    return {
      id: row.id,
      name: row.name,
      statusId: row.statusId,
      disabled: row.disabled,
      roundsRemaining: remaining,
    };
  });
}

/**
 * Tokens that cannot see, so the vision sweep can give them a zero radius.
 *
 * A Set of ids rather than the whole effects view, because that is all the
 * geometry needs to know and it is recomputed on every drag frame.
 */
export function blindedTokenIds(byToken: Map<string, EffectRow[]>): Set<string> {
  const blinded = new Set<string>();

  for (const [tokenId, rows] of byToken) {
    if (deriveToken({ conditions: conditionsOf(rows) }).blinded) blinded.add(tokenId);
  }

  return blinded;
}

/**
 * The round that timers count against, or null when no fight is running.
 *
 * Durations are measured in rounds, so nothing counts down outside combat —
 * a deliberate limit, not an oversight. Out of combat the DM removes by hand.
 */
export async function currentRound(campaignId: string): Promise<number | null> {
  const rows = await db
    .select({ round: encounters.round })
    .from(encounters)
    .where(and(eq(encounters.campaignId, campaignId), eq(encounters.isActive, true)))
    .limit(1);
  return rows[0]?.round ?? null;
}

/**
 * Everything a scene payload needs to describe its tokens' effects: the rows
 * themselves, and the round their countdowns are measured against.
 */
export interface EffectsView {
  byToken: Map<string, EffectRow[]>;
  round: number | null;
}

export async function effectsViewFor(
  campaignId: string,
  tokenIds: string[],
): Promise<EffectsView> {
  const [byToken, round] = await Promise.all([
    effectsByToken(tokenIds),
    currentRound(campaignId),
  ]);
  return { byToken, round };
}

/**
 * Puts a condition on a token, or refreshes its duration if it is already there.
 *
 * Re-casting Hold Person on an already-paralyzed creature should reset the
 * clock, not stack a second identical row that has to be removed twice.
 */
export async function applyCondition(
  tokenId: string,
  condition: string,
  duration: { rounds: number | null; startRound: number | null } | null = null,
  sourceItemId: string | null = null,
): Promise<void> {
  const existing = await db
    .select({ id: activeEffects.id })
    .from(activeEffects)
    .where(and(eq(activeEffects.ownerTokenId, tokenId), eq(activeEffects.statusId, condition)))
    .limit(1);

  if (existing[0]) {
    await db.update(activeEffects).set({ duration }).where(eq(activeEffects.id, existing[0].id));
    return;
  }

  await db.insert(activeEffects).values({
    id: newId(),
    ownerTokenId: tokenId,
    ownerItemId: sourceItemId,
    name: condition.charAt(0).toUpperCase() + condition.slice(1),
    changes: [],
    duration,
    statusId: condition,
  });
}

export async function removeCondition(tokenId: string, condition: string): Promise<void> {
  await db
    .delete(activeEffects)
    .where(and(eq(activeEffects.ownerTokenId, tokenId), eq(activeEffects.statusId, condition)));
}

/**
 * Reconciles a token's conditions against a full list.
 *
 * The token HUD sends the whole set it wants, which is how it worked when this
 * was a JSON array. Adding and removing the difference keeps the durations on
 * conditions that were already there — writing the set wholesale would reset
 * every timer each time an unrelated chip was clicked.
 */
export async function setConditions(tokenId: string, wanted: string[]): Promise<void> {
  const rows = await db
    .select({ statusId: activeEffects.statusId })
    .from(activeEffects)
    .where(and(eq(activeEffects.ownerTokenId, tokenId), isNotNull(activeEffects.statusId)));

  const current = new Set(rows.map((row) => row.statusId as string));
  const target = new Set(wanted);

  for (const condition of target) {
    if (!current.has(condition)) await applyCondition(tokenId, condition);
  }
  for (const condition of current) {
    if (!target.has(condition)) await removeCondition(tokenId, condition);
  }
}

/** Whether a token currently has a given condition. */
export async function hasCondition(tokenId: string, condition: string): Promise<boolean> {
  const rows = await db
    .select({ id: activeEffects.id })
    .from(activeEffects)
    .where(and(eq(activeEffects.ownerTokenId, tokenId), eq(activeEffects.statusId, condition)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Removes effects whose duration has elapsed, returning what wore off so the
 * table is told rather than silently losing a buff.
 *
 * Scoped to one campaign by joining through the scene the token is on. Without
 * that join this deleted from every campaign on the server — harmless only for
 * as long as the table had no insert path, which is no longer true.
 */
export async function expireEffectsIn(
  campaignId: string,
  round: number,
): Promise<{ names: string[]; tokenIds: string[] }> {
  const rows = await db
    .select({ effect: activeEffects, tokenId: tokens.id })
    .from(activeEffects)
    .innerJoin(tokens, eq(activeEffects.ownerTokenId, tokens.id))
    .innerJoin(scenes, eq(tokens.sceneId, scenes.id))
    .where(eq(scenes.campaignId, campaignId));

  const expired = expiredEffects(
    rows.map(({ effect }) => toActiveEffect(effect)),
    round,
  );
  if (expired.length === 0) return { names: [], tokenIds: [] };

  const ids = new Set(expired.map((effect) => effect.id));
  await db.delete(activeEffects).where(
    inArray(activeEffects.id, [...ids]),
  );

  return {
    names: expired.map((effect) => effect.name),
    tokenIds: [...new Set(rows.filter((row) => ids.has(row.effect.id)).map((row) => row.tokenId))],
  };
}
