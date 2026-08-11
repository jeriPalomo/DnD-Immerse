import { and, asc, eq } from 'drizzle-orm';
import {
  campaignDmRoom,
  campaignRoom,
  snapTokenPosition,
  tokenCommitSchema,
  tokenCreateSchema,
  tokenMoveSchema,
  tokenUpdateSchema,
} from '@dnd/shared';
import type { Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  WireScene,
  WireToken,
} from '@dnd/shared';
import { wallCreateSchema, wallUpdateSchema } from '@dnd/shared';
import { db } from '../db/index.js';
import { actors, campaigns, scenes, tokens, walls as wallsTable } from '../db/schema.js';
import { computePlayerView, toWireDoor, toWireWall, visibleTokens, wallsOf } from './vision.js';
import { getMembership } from '../auth/guards.js';
import { newId } from '../lib/id.js';
import type { IOServer, SocketData } from './index.js';
import type { Scene, Token } from '../db/schema.js';

type SceneSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/* ----------------------------------------------------------- projection */

function toWireScene(scene: Scene): WireScene {
  return {
    id: scene.id,
    campaignId: scene.campaignId,
    name: scene.name,
    mapImageUrl: scene.mapImageUrl,
    mapWidth: scene.mapWidth,
    mapHeight: scene.mapHeight,
    gridSize: scene.gridSize,
    gridOffsetX: scene.gridOffsetX,
    gridOffsetY: scene.gridOffsetY,
    gridVisible: scene.gridVisible,
    feetPerSquare: scene.feetPerSquare,
    visionEnabled: scene.visionEnabled,
    globalIllumination: scene.globalIllumination,
    darkness: scene.darkness,
  };
}

function toWireToken(token: Token): WireToken {
  return {
    id: token.id,
    sceneId: token.sceneId,
    name: token.name,
    imageUrl: token.imageUrl,
    x: token.x,
    y: token.y,
    w: token.w,
    h: token.h,
    rotation: token.rotation,
    layer: token.layer,
    ownerUserId: token.ownerUserId,
    actorId: token.actorId,
    actorLinked: token.actorLinked,
    disposition: token.disposition,
    hp: token.hp,
    maxHp: token.maxHp,
    ac: token.ac,
    conditions: token.conditions,
    hidden: token.hidden,
    locked: token.locked,
  };
}

/**
 * The payload a player is allowed to receive.
 *
 * Hidden tokens are removed from the array entirely rather than sent with a
 * flag - a client that merely declines to draw them is a devtools inspection
 * away from spoiling an ambush. The `gm` layer is DM scratch space and is
 * stripped for the same reason.
 *
 * Phase 5 adds a second filter here for tokens outside the viewer's vision.
 */
export function filterTokensFor(list: Token[], isDM: boolean, userId: string): WireToken[] {
  if (isDM) return list.map(toWireToken);

  return list
    .filter((token) => {
      if (token.layer === 'gm') return false;
      if (token.hidden && token.ownerUserId !== userId) return false;
      return true;
    })
    .map(toWireToken);
}

/* ------------------------------------------------------------ permissions */

/** A player may move only tokens they own; the DM may move anything. */
function mayControl(token: Token, isDM: boolean, userId: string): boolean {
  if (isDM) return true;
  if (token.locked) return false;
  return token.ownerUserId === userId;
}

async function sceneOf(sceneId: string): Promise<Scene | null> {
  const rows = await db.select().from(scenes).where(eq(scenes.id, sceneId)).limit(1);
  return rows[0] ?? null;
}

async function tokenOf(tokenId: string): Promise<Token | null> {
  const rows = await db.select().from(tokens).where(eq(tokens.id, tokenId)).limit(1);
  return rows[0] ?? null;
}

/* ------------------------------------------------------------ broadcasting */

/**
 * Sends each audience the scene state it is allowed to see. The DM room gets
 * the full token list; the campaign room gets the filtered one.
 */
export async function broadcastSceneState(io: IOServer, campaignId: string): Promise<void> {
  const campaign = await db
    .select({ activeSceneId: campaigns.activeSceneId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  const sceneId = campaign[0]?.activeSceneId ?? null;
  if (!sceneId) {
    io.to(campaignRoom(campaignId)).emit('scene:state', {
      scene: null,
      tokens: [],
      vision: null,
      doors: [],
    });
    return;
  }

  const scene = await sceneOf(sceneId);
  if (!scene) return;

  const all = await db
    .select()
    .from(tokens)
    .where(eq(tokens.sceneId, sceneId))
    .orderBy(asc(tokens.createdAt));

  const wireScene = toWireScene(scene);
  const sceneWalls = await wallsOf(sceneId);
  const doors = sceneWalls.filter((w) => w.door > 0).map(toWireDoor);

  // Per-socket, because both "hidden unless you own it" and line of sight
  // differ between players.
  for (const socket of await io.in(campaignRoom(campaignId)).fetchSockets()) {
    const userId = socket.data.user.id;
    const isDM = socket.data.rooms.get(campaignId) === 'dm';

    if (isDM) {
      socket.emit('scene:state', {
        scene: wireScene,
        tokens: filterTokensFor(all, true, userId),
        vision: null,
        doors,
        walls: sceneWalls.map(toWireWall),
      });
      continue;
    }

    const view = await computePlayerView(scene, sceneWalls, all, userId);
    // Two filters in sequence: hidden tokens first, then line of sight.
    const permitted = filterTokensFor(all, false, userId);
    const sighted = view
      ? visibleTokens(
          all.filter((t) => permitted.some((p) => p.id === t.id)),
          view.polygons,
          userId,
        )
      : all.filter((t) => permitted.some((p) => p.id === t.id));

    socket.emit('scene:state', {
      scene: wireScene,
      tokens: filterTokensFor(sighted, false, userId),
      vision: view?.vision ?? null,
      doors,
      // No `walls` key at all for a player - not an empty array, absent.
    });
  }
}

/** Broadcasts one token, or a deletion for viewers who may not see it. */
async function broadcastToken(io: IOServer, campaignId: string, token: Token): Promise<void> {
  const scene = await sceneOf(token.sceneId);
  const sceneWalls = scene?.visionEnabled ? await wallsOf(token.sceneId) : [];
  const all = scene?.visionEnabled
    ? await db.select().from(tokens).where(eq(tokens.sceneId, token.sceneId))
    : [];

  for (const socket of await io.in(campaignRoom(campaignId)).fetchSockets()) {
    const userId = socket.data.user.id;
    const isDM = socket.data.rooms.get(campaignId) === 'dm';

    let visible = filterTokensFor([token], isDM, userId);

    // Out of sight is as good as hidden: a moving enemy behind a wall must not
    // stream its position to a player who cannot see it.
    if (visible.length > 0 && !isDM && scene?.visionEnabled) {
      const view = await computePlayerView(scene, sceneWalls, all, userId);
      if (view && visibleTokens([token], view.polygons, userId).length === 0) visible = [];
    }

    if (visible.length > 0) socket.emit('token:updated', { token: visible[0] });
    else socket.emit('token:deleted', { tokenId: token.id });
  }
}

/**
 * Finds a free square near the requested position.
 *
 * Without this every token dropped from the sidebar lands on the same square,
 * so a Gargantuan dragon buries the party under itself. Searches outward in
 * rings, which keeps the placement close to where the DM aimed.
 */
function firstFreeSquare(
  start: { x: number; y: number },
  w: number,
  h: number,
  existing: Token[],
  scene: Scene,
): { x: number; y: number } {
  const overlaps = (x: number, y: number) =>
    existing.some(
      (t) => x < t.x + t.w && t.x < x + w && y < t.y + t.h && t.y < y + h,
    );

  if (!overlaps(start.x, start.y)) return start;

  const maxX = scene.gridSize > 0 ? Math.floor(scene.mapWidth / scene.gridSize) : 40;
  const maxY = scene.gridSize > 0 ? Math.floor(scene.mapHeight / scene.gridSize) : 40;

  for (let ring = 1; ring <= 40; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        // Only the perimeter of each ring is new.
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;

        const x = start.x + dx;
        const y = start.y + dy;
        if (x < 0 || y < 0) continue;
        if (maxX && x + w > maxX) continue;
        if (maxY && y + h > maxY) continue;
        if (!overlaps(x, y)) return { x, y };
      }
    }
  }

  return start;
}

/* --------------------------------------------------------------- handlers */

export function registerSceneHandlers(io: IOServer, socket: SceneSocket): void {
  const user = socket.data.user;

  async function context(): Promise<{ campaignId: string; isDM: boolean } | null> {
    const [campaignId] = socket.data.rooms.keys();
    if (!campaignId) return null;

    // Re-checked per event; room membership authenticates but does not authorize.
    const membership = await getMembership(campaignId, user.id);
    if (!membership) {
      socket.emit('error', { message: 'You are not in that campaign', code: 'NOT_A_MEMBER' });
      return null;
    }
    return { campaignId, isDM: membership.isDM };
  }

  socket.on('scene:activate', async ({ sceneId }) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can change the scene' });
      return;
    }

    const scene = await sceneOf(sceneId);
    if (!scene || scene.campaignId !== ctx.campaignId) {
      socket.emit('error', { message: 'Scene not found' });
      return;
    }

    await db
      .update(campaigns)
      .set({ activeSceneId: sceneId })
      .where(eq(campaigns.id, ctx.campaignId));

    io.to(campaignRoom(ctx.campaignId)).emit('scene:changed', { sceneId });
    await broadcastSceneState(io, ctx.campaignId);
  });

  /**
   * Drag frames. Deliberately does NOT touch the database: a drag emits ~30
   * times a second, and persisting each frame would mean thousands of pointless
   * writes per combat. `token:commit` persists once, on drop.
   */
  socket.on('token:move', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = tokenMoveSchema.parse(payload);
    const token = await tokenOf(input.tokenId);
    if (!token || !mayControl(token, ctx.isDM, user.id)) return;

    // A hidden token's position streams only to the DM room; players are never
    // joined to it, so an invisible token cannot be tracked by its updates.
    const target = token.hidden
      ? campaignDmRoom(ctx.campaignId)
      : campaignRoom(ctx.campaignId);

    socket.broadcast.to(target).emit('token:moved', { ...input, byUserId: user.id });
  });

  socket.on('token:commit', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = tokenCommitSchema.parse(payload);
    const token = await tokenOf(input.tokenId);
    if (!token || !mayControl(token, ctx.isDM, user.id)) {
      socket.emit('error', { message: 'You cannot move that token' });
      // Snap it back on the mover's screen.
      if (token) await broadcastToken(io, ctx.campaignId, token);
      return;
    }

    const w = input.w ?? token.w;
    const h = input.h ?? token.h;
    // Snapping is applied server-side so every client agrees on the position.
    const snapped = snapTokenPosition({ x: input.x, y: input.y }, w, h);

    await db
      .update(tokens)
      .set({ x: snapped.x, y: snapped.y, w, h, rotation: input.rotation ?? token.rotation })
      .where(eq(tokens.id, input.tokenId));

    const updated = await tokenOf(input.tokenId);
    if (updated) await broadcastToken(io, ctx.campaignId, updated);
  });

  socket.on('token:create', async (payload) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can place tokens' });
      return;
    }

    const input = tokenCreateSchema.parse(payload);
    const scene = await sceneOf(input.sceneId);
    if (!scene || scene.campaignId !== ctx.campaignId) return;

    let { name, imageUrl, w, h, hp, maxHp, ac, actorLinked, disposition, ownerUserId } = input;

    // Stamp defaults from the actor's prototype token, so dropping an Ancient
    // Red Dragon lands a 4x4 unlinked token without the DM configuring it.
    if (input.actorId) {
      const found = await db.select().from(actors).where(eq(actors.id, input.actorId)).limit(1);
      const actor = found[0];
      if (actor) {
        const proto = actor.prototypeToken;
        name = name || actor.name;
        imageUrl = imageUrl ?? actor.portraitUrl;
        w = w !== 1 ? w : (proto.w ?? 1);
        h = h !== 1 ? h : (proto.h ?? 1);
        actorLinked = proto.actorLinked ?? false;
        disposition = proto.disposition ?? 'hostile';
        ac = ac ?? actor.armorClass;
        // An unlinked token copies HP so each goblin tracks its own.
        hp = hp ?? actor.hpCurrent;
        maxHp = maxHp ?? actor.hpMax;
        ownerUserId = ownerUserId ?? (actor.type === 'character' ? actor.ownerUserId : null);
      }
    }

    const existing = await db.select().from(tokens).where(eq(tokens.sceneId, input.sceneId));
    const snapped = firstFreeSquare(
      snapTokenPosition({ x: input.x, y: input.y }, w, h),
      w,
      h,
      existing,
      scene,
    );

    const token = {
      id: newId(),
      sceneId: input.sceneId,
      name: name ?? '',
      imageUrl: imageUrl ?? null,
      actorId: input.actorId,
      actorLinked,
      ownerUserId: ownerUserId ?? null,
      x: snapped.x,
      y: snapped.y,
      w,
      h,
      rotation: input.rotation,
      layer: input.layer,
      disposition,
      visionRange: input.visionRange,
      darkvisionRange: input.darkvisionRange,
      lightBright: input.lightBright,
      lightDim: input.lightDim,
      hp: hp ?? null,
      maxHp: maxHp ?? null,
      ac: ac ?? null,
      conditions: input.conditions,
      hidden: input.hidden,
      locked: input.locked,
      createdAt: Date.now(),
    };

    await db.insert(tokens).values(token);

    for (const s of await io.in(campaignRoom(ctx.campaignId)).fetchSockets()) {
      const visible = filterTokensFor([token as Token], s.data.rooms.get(ctx.campaignId) === 'dm', s.data.user.id);
      if (visible.length > 0) s.emit('token:created', { token: visible[0] });
    }
  });

  socket.on('token:update', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = tokenUpdateSchema.parse(payload);
    const token = await tokenOf(input.tokenId);
    if (!token) return;

    // Players may edit HP and conditions on tokens they own; everything else
    // (hiding, locking, resizing, re-owning) is the DM's.
    const dmOnly = ['hidden', 'locked', 'ownerUserId', 'actorId', 'actorLinked', 'layer', 'w', 'h'];
    const touchesDmField = dmOnly.some((key) => key in input);

    if (!ctx.isDM && (touchesDmField || token.ownerUserId !== user.id)) {
      socket.emit('error', { message: 'You cannot change that token' });
      return;
    }

    const { tokenId, ...fields } = input;
    await db.update(tokens).set(fields).where(eq(tokens.id, tokenId));

    // A linked token is a view onto its actor: HP written here writes through,
    // so the sheet and the board never disagree.
    if (token.actorLinked && token.actorId && (fields.hp !== undefined || fields.maxHp !== undefined)) {
      await db
        .update(actors)
        .set({
          ...(fields.hp !== undefined ? { hpCurrent: fields.hp ?? 0 } : {}),
          ...(fields.maxHp !== undefined ? { hpMax: fields.maxHp ?? 0 } : {}),
          updatedAt: Date.now(),
        })
        .where(eq(actors.id, token.actorId));
    }

    const updated = await tokenOf(tokenId);
    if (updated) await broadcastToken(io, ctx.campaignId, updated);
  });

  socket.on('token:delete', async ({ tokenId }) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can remove tokens' });
      return;
    }

    await db.delete(tokens).where(eq(tokens.id, tokenId));
    io.to(campaignRoom(ctx.campaignId)).emit('token:deleted', { tokenId });
  });

  /* ------------------------------------------------------------- walls */

  socket.on('wall:create', async (payload) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can build walls' });
      return;
    }

    const input = wallCreateSchema.parse(payload);
    const scene = await sceneOf(input.sceneId);
    if (!scene || scene.campaignId !== ctx.campaignId) return;

    const wall = { id: newId(), ...input };
    await db.insert(wallsTable).values(wall);

    // Walls go to the DM room only. Players never receive the geometry - if it
    // is a door they get it via the door list, which carries no other walls.
    io.to(campaignDmRoom(ctx.campaignId)).emit('wall:created', { wall: toWireWall(wall as never) });
    await broadcastSceneState(io, ctx.campaignId);
  });

  socket.on('wall:update', async (payload) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can edit walls' });
      return;
    }

    const { wallId, ...fields } = wallUpdateSchema.parse(payload);
    await db.update(wallsTable).set(fields).where(eq(wallsTable.id, wallId));

    const rows = await db.select().from(wallsTable).where(eq(wallsTable.id, wallId)).limit(1);
    if (rows[0]) io.to(campaignDmRoom(ctx.campaignId)).emit('wall:updated', { wall: toWireWall(rows[0]) });

    await broadcastSceneState(io, ctx.campaignId);
  });

  socket.on('wall:delete', async ({ wallId }) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can remove walls' });
      return;
    }

    await db.delete(wallsTable).where(eq(wallsTable.id, wallId));
    io.to(campaignDmRoom(ctx.campaignId)).emit('wall:deleted', { wallId });
    await broadcastSceneState(io, ctx.campaignId);
  });

  /**
   * Opening a door is deliberately available to players - it is the best
   * moment the board produces. Locked doors stay shut for everyone but the DM.
   */
  socket.on('door:toggle', async ({ wallId }) => {
    const ctx = await context();
    if (!ctx) return;

    const rows = await db.select().from(wallsTable).where(eq(wallsTable.id, wallId)).limit(1);
    const wall = rows[0];
    if (!wall || wall.door === 0) return;

    if (wall.doorState === 2 && !ctx.isDM) {
      socket.emit('error', { message: 'That door is locked' });
      return;
    }

    const doorState = wall.doorState === 1 ? 0 : 1;
    await db.update(wallsTable).set({ doorState }).where(eq(wallsTable.id, wallId));

    io.to(campaignRoom(ctx.campaignId)).emit('door:updated', {
      door: toWireDoor({ ...wall, doorState }),
    });
    // Everyone's sight changes the moment a door swings.
    await broadcastSceneState(io, ctx.campaignId);
  });

  socket.on('ping:map', async ({ sceneId, x, y }) => {
    const ctx = await context();
    if (!ctx) return;

    io.to(campaignRoom(ctx.campaignId)).emit('ping:map', {
      sceneId,
      x,
      y,
      byUserId: user.id,
      color: ctx.isDM ? '#e8853f' : '#8b7bf0',
    });
  });
}
