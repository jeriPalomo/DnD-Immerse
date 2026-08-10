import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { OWNERSHIP, type DocumentType, type OwnershipLevel } from '@dnd/shared';
import { db } from '../db/index.js';
import { campaignMembers, campaigns, ownership } from '../db/schema.js';
import { SESSION_COOKIE, validateSession } from './session.js';
import type { MemberRole } from '@dnd/shared';
import type { User } from '../db/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Resolves the session cookie onto `request.user`. Registered as a global hook
 * so every handler can read it; it does not itself reject anonymous requests.
 */
export async function attachUser(request: FastifyRequest): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE];
  request.user = await validateSession(token);
}

/** preHandler for routes that require a logged-in user. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: 'Not signed in' });
  }
}

export function assertUser(request: FastifyRequest): User {
  if (!request.user) throw new HttpError(401, 'Not signed in');
  return request.user;
}

/* ------------------------------------------------------------ membership */

export interface Membership {
  campaignId: string;
  userId: string;
  role: MemberRole;
  isDM: boolean;
}

export async function getMembership(
  campaignId: string,
  userId: string,
): Promise<Membership | null> {
  const rows = await db
    .select({ role: campaignMembers.role })
    .from(campaignMembers)
    .where(and(eq(campaignMembers.campaignId, campaignId), eq(campaignMembers.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return { campaignId, userId, role: row.role, isDM: row.role === 'dm' };
}

/**
 * Every campaign-scoped read and write goes through this. Membership is
 * re-checked per request rather than trusted from a prior step.
 */
export async function requireMembership(
  campaignId: string,
  userId: string,
): Promise<Membership> {
  const membership = await getMembership(campaignId, userId);
  if (!membership) throw new HttpError(404, 'Campaign not found');
  return membership;
}

export async function requireDM(campaignId: string, userId: string): Promise<Membership> {
  const membership = await requireMembership(campaignId, userId);
  if (!membership.isDM) throw new HttpError(403, 'Only the DM can do that');
  return membership;
}

export async function isDMOfCampaign(campaignId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.dmUserId, userId)))
    .limit(1);
  return rows.length > 0;
}

/* ------------------------------------------------------------- ownership */

/**
 * Access level for one user on one document. The DM implicitly owns every
 * document in their campaign, so only player grants need explicit rows.
 */
export async function getOwnershipLevel(
  documentType: DocumentType,
  documentId: string,
  userId: string,
  campaignId?: string,
): Promise<OwnershipLevel> {
  if (campaignId && (await isDMOfCampaign(campaignId, userId))) return OWNERSHIP.owner;

  const rows = await db
    .select({ level: ownership.level })
    .from(ownership)
    .where(
      and(
        eq(ownership.documentType, documentType),
        eq(ownership.documentId, documentId),
        eq(ownership.userId, userId),
      ),
    )
    .limit(1);

  return (rows[0]?.level ?? OWNERSHIP.none) as OwnershipLevel;
}

export async function setOwnershipLevel(
  documentType: DocumentType,
  documentId: string,
  userId: string,
  level: OwnershipLevel,
): Promise<void> {
  if (level === OWNERSHIP.none) {
    await db
      .delete(ownership)
      .where(
        and(
          eq(ownership.documentType, documentType),
          eq(ownership.documentId, documentId),
          eq(ownership.userId, userId),
        ),
      );
    return;
  }

  await db
    .insert(ownership)
    .values({ documentType, documentId, userId, level })
    .onConflictDoUpdate({
      target: [ownership.documentType, ownership.documentId, ownership.userId],
      set: { level },
    });
}

export function canRead(level: OwnershipLevel): boolean {
  return level >= OWNERSHIP.observer;
}

export function canWrite(level: OwnershipLevel): boolean {
  return level >= OWNERSHIP.owner;
}

/** Limited access shows a name and portrait but never the sheet contents. */
export function canSeeExistence(level: OwnershipLevel): boolean {
  return level >= OWNERSHIP.limited;
}
