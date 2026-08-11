import { z } from 'zod';
import {
  cardActionSchema,
  cardRequestSchema,
  rollRequestSchema,
  sendMessageSchema,
  tokenInputSchema,
} from './schemas.js';
import type { ChatKind, MemberRole, RollResult, TokenLayer } from './schemas.js';

/**
 * The socket contract, shared by client and server.
 *
 * Every payload is defined once here so a protocol change surfaces as a
 * compile error on both sides rather than a runtime mystery.
 */

/* ------------------------------------------------------------ wire types */

export interface PublicUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface WireToken {
  id: string;
  sceneId: string;
  name: string;
  imageUrl: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  layer: TokenLayer;
  ownerUserId: string | null;
  actorId: string | null;
  hp: number | null;
  maxHp: number | null;
  ac: number | null;
  conditions: string[];
  /** Only ever true in a DM payload; hidden tokens are stripped for players. */
  hidden: boolean;
  locked: boolean;
}

export interface WireScene {
  id: string;
  campaignId: string;
  name: string;
  mapImageUrl: string | null;
  mapWidth: number;
  mapHeight: number;
  gridSize: number;
  gridOffsetX: number;
  gridOffsetY: number;
  gridVisible: boolean;
  fogEnabled: boolean;
  feetPerSquare: number;
  /** Polygons in grid units marking the revealed (un-fogged) area. */
  revealedPolygons: { x: number; y: number }[][];
}

export interface WireCard {
  itemId: string;
  actorId: string;
  itemType: string;
  itemName: string;
  subtitle: string;
  description: string;
  /** Buttons the viewer may press, already filtered by what the item supports. */
  actions: ('attack' | 'damage' | 'critical' | 'save' | 'versatile')[];
  saveAbility: string | null;
  saveDC: number | null;
}

export interface WireChatMessage {
  id: string;
  campaignId: string;
  userId: string;
  authorName: string;
  actorName: string | null;
  kind: ChatKind;
  body: string;
  rollData: RollResult | null;
  cardData: WireCard | null;
  whisperToUserId: string | null;
  createdAt: number;
}

export interface WireInitiativeEntry {
  id: string;
  tokenId: string | null;
  name: string;
  initiative: number;
  sortOrder: number;
}

export interface WireEncounter {
  id: string;
  sceneId: string | null;
  round: number;
  activeIndex: number;
  isActive: boolean;
  entries: WireInitiativeEntry[];
}

export interface WireAudioState {
  trackId: string | null;
  trackUrl: string | null;
  trackName: string | null;
  playing: boolean;
  loop: boolean;
  /** Server epoch ms when playback started; clients derive their own seek. */
  startedAt: number | null;
  volume: number;
}

export interface WirePresence {
  user: PublicUser;
  role: MemberRole;
  online: boolean;
}

/* --------------------------------------------------------- event payloads */

export const tokenMoveSchema = z.object({
  tokenId: z.string(),
  x: z.number(),
  y: z.number(),
});

export const tokenCommitSchema = z.object({
  tokenId: z.string(),
  x: z.number(),
  y: z.number(),
  rotation: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
});

export const tokenCreateSchema = tokenInputSchema.extend({ sceneId: z.string() });

export const tokenUpdateSchema = tokenInputSchema.partial().extend({ tokenId: z.string() });

export const fogUpdateSchema = z.object({
  sceneId: z.string(),
  /** Full replacement of the revealed set; simplest correct model at this scale. */
  revealedPolygons: z.array(z.array(z.object({ x: z.number(), y: z.number() }))),
});

export const pingSchema = z.object({
  sceneId: z.string(),
  x: z.number(),
  y: z.number(),
});

export const audioControlSchema = z.object({
  trackId: z.string().nullable(),
  playing: z.boolean(),
  loop: z.boolean().default(true),
});

export const initiativeUpdateSchema = z.object({
  encounterId: z.string(),
  round: z.number().int().min(1).optional(),
  activeIndex: z.number().int().min(0).optional(),
  entries: z
    .array(
      z.object({
        id: z.string(),
        initiative: z.number(),
        sortOrder: z.number().int(),
      }),
    )
    .optional(),
});

export type TokenMovePayload = z.infer<typeof tokenMoveSchema>;
export type TokenCommitPayload = z.infer<typeof tokenCommitSchema>;
export type TokenCreatePayload = z.infer<typeof tokenCreateSchema>;
export type TokenUpdatePayload = z.infer<typeof tokenUpdateSchema>;
export type FogUpdatePayload = z.infer<typeof fogUpdateSchema>;
export type PingPayload = z.infer<typeof pingSchema>;
export type AudioControlPayload = z.infer<typeof audioControlSchema>;
export type InitiativeUpdatePayload = z.infer<typeof initiativeUpdateSchema>;

/* ---------------------------------------------------------------- events */

export interface ServerToClientEvents {
  'scene:state': (payload: { scene: WireScene | null; tokens: WireToken[] }) => void;
  'scene:changed': (payload: { sceneId: string }) => void;
  'scene:updated': (payload: { scene: WireScene }) => void;

  'token:moved': (payload: TokenMovePayload & { byUserId: string }) => void;
  'token:created': (payload: { token: WireToken }) => void;
  'token:updated': (payload: { token: WireToken }) => void;
  'token:deleted': (payload: { tokenId: string }) => void;

  'fog:updated': (payload: FogUpdatePayload) => void;

  'chat:message': (payload: { message: WireChatMessage }) => void;
  'chat:history': (payload: { messages: WireChatMessage[] }) => void;

  'initiative:state': (payload: { encounter: WireEncounter | null }) => void;

  'audio:state': (payload: WireAudioState) => void;

  'ping:map': (payload: PingPayload & { byUserId: string; color: string }) => void;

  presence: (payload: { members: WirePresence[] }) => void;

  error: (payload: { message: string; code?: string }) => void;
}

export interface ClientToServerEvents {
  'campaign:join': (payload: { campaignId: string }) => void;
  'campaign:leave': (payload: { campaignId: string }) => void;

  'scene:activate': (payload: { sceneId: string }) => void;

  'token:move': (payload: TokenMovePayload) => void;
  'token:commit': (payload: TokenCommitPayload) => void;
  'token:create': (payload: TokenCreatePayload) => void;
  'token:update': (payload: TokenUpdatePayload) => void;
  'token:delete': (payload: { tokenId: string }) => void;

  'fog:update': (payload: FogUpdatePayload) => void;

  'chat:send': (payload: z.infer<typeof sendMessageSchema>) => void;
  'chat:roll': (payload: z.infer<typeof rollRequestSchema>) => void;
  'chat:card': (payload: z.infer<typeof cardRequestSchema>) => void;
  'chat:cardAction': (payload: z.infer<typeof cardActionSchema>) => void;

  'initiative:update': (payload: InitiativeUpdatePayload) => void;

  'audio:control': (payload: AudioControlPayload) => void;

  'ping:map': (payload: PingPayload) => void;
}

/** Room naming. The `:dm` room is what keeps DM-only data structurally separate. */
export function campaignRoom(campaignId: string): string {
  return `campaign:${campaignId}`;
}

export function campaignDmRoom(campaignId: string): string {
  return `campaign:${campaignId}:dm`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** How often a dragging client emits position updates, in ms (~30Hz). */
export const TOKEN_MOVE_THROTTLE_MS = 33;
