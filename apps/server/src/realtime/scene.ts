import { and, asc, eq } from 'drizzle-orm';
import {
  DM_COLOR,
  OWNERSHIP,
  actorColor,
  campaignDmRoom,
  campaignRoom,
  clampToMap,
  drawingCreateSchema,
  movementBlocked,
  movementQuerySchema,
  pingSchema,
  reachableSquares,
  unionOfReach,
  snapTokenPosition,
  tokenCenter,
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
import { getActorAccess } from '../lib/access.js';
import {
  actors,
  campaigns,
  drawings as drawingsTable,
  mapNotes,
  scenes,
  tokens,
  walls as wallsTable,
} from '../db/schema.js';
import {
  computeLivePolygons,
  computePlayerView,
  gridExtent,
  toWireDoor,
  toWireWall,
  visibleTokens,
  wallsOf,
} from './vision.js';
import { getMembership } from '../auth/guards.js';
import { newId } from '../lib/id.js';
import type { IOServer, SocketData } from './index.js';
import type { Scene, Token, Wall } from '../db/schema.js';

type SceneSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/** The scene a campaign is currently showing, or null. */
async function activeSceneOf(campaignId: string) {
  const rows = await db
    .select({ activeSceneId: campaigns.activeSceneId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);

  const sceneId = rows[0]?.activeSceneId;
  return sceneId ? ((await sceneOf(sceneId)) ?? null) : null;
}

/**
 * Walls and tokens for the scene currently being dragged over.
 *
 * A drag emits ~30 times a second; re-reading the wall table on each frame
 * would put the database in the hot path of a mouse move. The cache is
 * invalidated whenever walls change or a token is committed.
 */
const dragCache = new Map<string, { walls: Wall[]; tokens: Token[]; at: number }>();
const DRAG_CACHE_TTL_MS = 5000;

export function invalidateDragCache(sceneId: string): void {
  dragCache.delete(sceneId);
}

async function dragState(sceneId: string): Promise<{ walls: Wall[]; tokens: Token[] }> {
  const cached = dragCache.get(sceneId);
  if (cached && Date.now() - cached.at < DRAG_CACHE_TTL_MS) return cached;

  const [sceneWalls, sceneTokens] = await Promise.all([
    wallsOf(sceneId),
    db.select().from(tokens).where(eq(tokens.sceneId, sceneId)),
  ]);

  const entry = { walls: sceneWalls, tokens: sceneTokens, at: Date.now() };
  dragCache.set(sceneId, entry);
  return entry;
}

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
    weather: scene.weather,
    weatherIntensity: scene.weatherIntensity,
    playerDrawing: scene.playerDrawing,
  };
}

/**
 * `hp`/`maxHp` are the DM's to reveal.
 *
 * The initiative tracker took care to redact them and then every other channel
 * published them anyway - the board tooltip, the token HUD and the target panel
 * all read `token.hp` straight off the wire. Redacting at the point the row
 * becomes a payload is the only place it can be done once.
 *
 * A player keeps full numbers for anything they own, and for anything owned by
 * another player: the party knowing each other's hit points is the point of a
 * party panel. What is hidden is unowned tokens - monsters.
 */
function toWireToken(token: Token, showHp = true): WireToken {
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
    visionRange: token.visionRange,
    darkvisionRange: token.darkvisionRange,
    lightBright: token.lightBright,
    lightDim: token.lightDim,
    lightColor: token.lightColor,
    hp: showHp ? token.hp : null,
    maxHp: showHp ? token.maxHp : null,
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
 * Hit points are redacted for anything the party does not own. Line of sight is
 * a separate filter applied by the callers that have a vision polygon to hand.
 */
export function filterTokensFor(list: Token[], isDM: boolean, userId: string): WireToken[] {
  if (isDM) return list.map((token) => toWireToken(token));

  return list
    .filter((token) => {
      if (token.layer === 'gm') return false;
      if (token.hidden && token.ownerUserId !== userId) return false;
      return true;
    })
    .map((token) => toWireToken(token, Boolean(token.ownerUserId)));
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

/**
 * A token, but only if it belongs to the campaign this socket is acting in.
 *
 * Room membership says which campaigns you are in; it does not say which one a
 * given id came from. A socket can be joined to two campaigns, and `context()`
 * reports the first - so "is this socket a DM" was answered about the wrong
 * table, and a DM of their own game could act on ids from somebody else's.
 * Scoping the lookup makes that unrepresentable rather than remembered.
 */
async function tokenIn(tokenId: string, campaignId: string): Promise<Token | null> {
  const rows = await db
    .select({ token: tokens })
    .from(tokens)
    .innerJoin(scenes, eq(tokens.sceneId, scenes.id))
    .where(and(eq(tokens.id, tokenId), eq(scenes.campaignId, campaignId)))
    .limit(1);
  return rows[0]?.token ?? null;
}

/**
 * How fast a token moves.
 *
 * Speed lives on the actor, not the token, and is not on the wire at all - so
 * this is the only place that can answer it. A token with no sheet behind it
 * gets the default humanoid 30.
 */
async function speedOf(token: Token): Promise<number> {
  if (!token.actorId) return 30;
  const rows = await db
    .select({ speed: actors.speed })
    .from(actors)
    .where(eq(actors.id, token.actorId))
    .limit(1);
  return rows[0]?.speed ?? 30;
}

/** The same, for walls and doors. */
async function wallIn(wallId: string, campaignId: string) {
  const rows = await db
    .select({ wall: wallsTable })
    .from(wallsTable)
    .innerJoin(scenes, eq(wallsTable.sceneId, scenes.id))
    .where(and(eq(wallsTable.id, wallId), eq(scenes.campaignId, campaignId)))
    .limit(1);
  return rows[0]?.wall ?? null;
}

/**
 * What colour someone points in.
 *
 * The DM speaks as the table, so they get the one fixed colour. A player gets
 * their character's - but the claim is checked here rather than trusted, or a
 * modified client could point in someone else's name. Falling back to the user
 * id still yields a stable colour of their own, so a player between characters
 * is never invisible.
 */
async function pointerColor(
  isDM: boolean,
  actorId: string | null,
  userId: string,
): Promise<string> {
  if (isDM) return DM_COLOR;
  if (!actorId) return actorColor(userId);

  const access = await getActorAccess(actorId, userId);
  return actorColor(access && access.level >= OWNERSHIP.owner ? actorId : userId);
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
      notes: [],
      drawings: [],
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
  const notes = await db.select().from(mapNotes).where(eq(mapNotes.sceneId, sceneId));
  const drawings = await db.select().from(drawingsTable).where(eq(drawingsTable.sceneId, sceneId));

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
        notes,
        drawings,
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
      // A pin the DM has not revealed is absent, like a hidden token.
      notes: notes.filter((note) => !note.hidden),
      // Drawings are shared by design - annotating the map is how you point.
      drawings,
      // No `walls` key at all for a player - not an empty array, absent.
    });
  }
}

/** Broadcasts one token, or a deletion for viewers who may not see it. */
async function broadcastToken(
  io: IOServer,
  campaignId: string,
  token: Token,
  event: 'token:updated' | 'token:created' = 'token:updated',
): Promise<void> {
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

    // A viewer who may not see it is told to drop it - which for a token they
    // never had is simply a no-op on the client.
    if (visible.length > 0) socket.emit(event, { token: visible[0] });
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
    const token = await tokenIn(input.tokenId, ctx.campaignId);
    if (!token || !mayControl(token, ctx.isDM, user.id)) return;

    const scene = await sceneOf(token.sceneId);

    // A hidden token's position streams only to the DM room; players are never
    // joined to it, so an invisible token cannot be tracked by its updates.
    //
    // With vision on, the DM room alone gets the fast path: a visible-but-
    // unsighted monster being dragged behind a wall would otherwise stream its
    // coordinates to every player at 30Hz. The per-socket loop below re-emits
    // to the players who can actually see it.
    const fastPath =
      token.hidden || scene?.visionEnabled
        ? campaignDmRoom(ctx.campaignId)
        : campaignRoom(ctx.campaignId);

    socket.broadcast.to(fastPath).emit('token:moved', { ...input, byUserId: user.id });

    if (!scene?.visionEnabled) return;

    // Recompute sight against the dragged position so fog moves with the
    // token rather than snapping when the mouse is released.
    const { walls: cachedWalls, tokens: cachedTokens } = await dragState(token.sceneId);
    const live = cachedTokens.map((t) =>
      t.id === input.tokenId ? { ...t, x: input.x, y: input.y } : t,
    );

    for (const s of await io.in(campaignRoom(ctx.campaignId)).fetchSockets()) {
      if (s.data.rooms.get(ctx.campaignId) === 'dm') continue;

      const viewerId = s.data.user.id;
      const polygons = computeLivePolygons(scene, cachedWalls, live, viewerId);
      const permitted = filterTokensFor(live, false, viewerId);
      const sighted = visibleTokens(
        live.filter((t) => permitted.some((p) => p.id === t.id)),
        polygons,
        viewerId,
      );

      // The drag frame, but only to a player who can see the thing being
      // dragged. Skipping the sender keeps their own drag from fighting the
      // echo, exactly as `socket.broadcast` does above.
      if (s.id !== socket.id && sighted.some((t) => t.id === input.tokenId)) {
        s.emit('token:moved', { ...input, byUserId: user.id });
      }

      s.emit('vision:update', {
        polygons,
        tokens: filterTokensFor(sighted, false, viewerId),
      });
    }
  });

  socket.on('token:commit', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = tokenCommitSchema.parse(payload);
    const token = await tokenIn(input.tokenId, ctx.campaignId);
    if (!token || !mayControl(token, ctx.isDM, user.id)) {
      socket.emit('error', { message: 'You cannot move that token' });
      // Snap it back on the mover's screen.
      if (token) await broadcastToken(io, ctx.campaignId, token);
      return;
    }

    const w = input.w ?? token.w;
    const h = input.h ?? token.h;
    const scene = await sceneOf(token.sceneId);

    // Kept on the map, then snapped - server-side, so every client agrees.
    const bounded =
      scene && scene.gridSize > 0 && scene.mapWidth > 0
        ? clampToMap(
            { x: input.x, y: input.y },
            w,
            h,
            scene.mapWidth / scene.gridSize,
            scene.mapHeight / scene.gridSize,
          )
        : { x: input.x, y: input.y };
    const snapped = snapTokenPosition(bounded, w, h);

    // Walls stop players, not the DM - who needs to place things anywhere,
    // including inside walls.
    if (!ctx.isDM) {
      const sceneWalls = await wallsOf(token.sceneId);
      const from = tokenCenter(token);
      const to = tokenCenter({ x: snapped.x, y: snapped.y, w, h });

      if (movementBlocked(from, to, sceneWalls)) {
        socket.emit('error', { message: 'A wall blocks the way' });
        // Send the authoritative position back so the client snaps home.
        await broadcastToken(io, ctx.campaignId, token);
        return;
      }
    }

    await db
      .update(tokens)
      .set({ x: snapped.x, y: snapped.y, w, h, rotation: input.rotation ?? token.rotation })
      .where(eq(tokens.id, input.tokenId));

    invalidateDragCache(token.sceneId);
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
        // `??`-guarded like ac/hp/maxHp below, rather than the unconditional
        // overwrite this used to be: an explicit disposition on the wire is a
        // deliberate choice, and undo re-creating a deleted token was silently
        // losing it.
        disposition = disposition ?? proto.disposition;
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
      // Last stop for the default, now that the schema no longer applies one.
      disposition: disposition ?? 'hostile',
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
    invalidateDragCache(input.sceneId);

    // Sight is checked here as well as hidden-ness. Placing an ambusher behind
    // a wall used to ship its full stat line - name, HP, position - to every
    // player, and unlike a drag frame nothing corrected it until the next full
    // scene push.
    const placed = await tokenIn(token.id, ctx.campaignId);
    if (placed) await broadcastToken(io, ctx.campaignId, placed, 'token:created');
  });

  socket.on('token:update', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = tokenUpdateSchema.parse(payload);
    const token = await tokenIn(input.tokenId, ctx.campaignId);
    if (!token) return;

    // Players may edit HP and conditions on tokens they own; everything else
    // (hiding, locking, resizing, re-owning) is the DM's.
    //
    // `x`/`y` are here because `token:commit` is the only path that clamps to
    // the map and runs the wall check - writing them through this event walked
    // straight through walls. The sight and light fields are here because a
    // token's own `visionRange` is what the vision sweep measures from, so a
    // player could grant themselves the whole map, permanently: the fog
    // exploration it produces is persisted.
    // `disposition` is here because it decides who the threat overlay paints
    // red: a player able to re-flag their own token could simply opt out of
    // being a threat. Allegiance is the DM's to declare.
    const dmOnly = [
      'hidden', 'locked', 'ownerUserId', 'actorId', 'actorLinked', 'layer', 'w', 'h',
      'x', 'y', 'visionRange', 'darkvisionRange', 'lightBright', 'lightDim', 'lightColor',
      'disposition',
    ];
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

    const doomed = await tokenIn(tokenId, ctx.campaignId);
    if (!doomed) return;

    await db.delete(tokens).where(eq(tokens.id, tokenId));

    if (doomed) {
      invalidateDragCache(doomed.sceneId);
      // Only if nothing else points at it - token art is often the actor's
      // portrait, and several tokens can share one image.
      const { deleteOrphanedUploads } = await import('../lib/orphans.js');
      await deleteOrphanedUploads([doomed.imageUrl]);
    }
    io.to(campaignRoom(ctx.campaignId)).emit('token:deleted', { tokenId });
  });

  /* ------------------------------------------------------------- walls */

  socket.on('drawing:create', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = drawingCreateSchema.parse(payload);
    const scene = await sceneOf(input.sceneId);
    if (!scene || scene.campaignId !== ctx.campaignId) return;

    // Enforced here, not by hiding the tool: a modified client would otherwise
    // draw straight through the DM having closed it.
    if (!ctx.isDM && !scene.playerDrawing) {
      socket.emit('error', { message: 'The DM has closed drawing on this scene' });
      return;
    }

    await db.insert(drawingsTable).values({
      id: newId(),
      sceneId: input.sceneId,
      ownerUserId: user.id,
      kind: input.kind,
      points: input.points,
      color: input.color,
      text: input.text,
      width: input.width,
    });

    await broadcastSceneState(io, ctx.campaignId);
  });

  socket.on('drawing:delete', async ({ drawingId }) => {
    const ctx = await context();
    if (!ctx) return;

    const scene = await activeSceneOf(ctx.campaignId);
    if (!scene) return;

    if (drawingId === 'all') {
      // Clearing everyone's annotations is the DM's call.
      if (!ctx.isDM) {
        socket.emit('error', { message: 'Only the DM can clear everything' });
        return;
      }
      await db.delete(drawingsTable).where(eq(drawingsTable.sceneId, scene.id));
    } else if (drawingId === 'mine') {
      await db
        .delete(drawingsTable)
        .where(and(eq(drawingsTable.sceneId, scene.id), eq(drawingsTable.ownerUserId, user.id)));
    } else {
      const rows = await db.select().from(drawingsTable).where(eq(drawingsTable.id, drawingId)).limit(1);
      const drawing = rows[0];
      if (!drawing) return;

      if (!ctx.isDM && drawing.ownerUserId !== user.id) {
        socket.emit('error', { message: 'That is not your drawing' });
        return;
      }
      await db.delete(drawingsTable).where(eq(drawingsTable.id, drawingId));
    }

    await broadcastSceneState(io, ctx.campaignId);
  });

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
    invalidateDragCache(input.sceneId);

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
    if (!(await wallIn(wallId, ctx.campaignId))) return;

    await db.update(wallsTable).set(fields).where(eq(wallsTable.id, wallId));

    const changed = await db.select().from(wallsTable).where(eq(wallsTable.id, wallId)).limit(1);
    if (changed[0]) invalidateDragCache(changed[0].sceneId);

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

    const removed = await wallIn(wallId, ctx.campaignId);
    if (!removed) return;

    await db.delete(wallsTable).where(eq(wallsTable.id, wallId));
    invalidateDragCache(removed.sceneId);
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

    const wall = await wallIn(wallId, ctx.campaignId);
    if (!wall || wall.door === 0) return;

    if (wall.doorState === 2 && !ctx.isDM) {
      socket.emit('error', { message: 'That door is locked' });
      return;
    }

    const doorState = wall.doorState === 1 ? 0 : 1;
    await db.update(wallsTable).set({ doorState }).where(eq(wallsTable.id, wallId));
    invalidateDragCache(wall.sceneId);

    io.to(campaignRoom(ctx.campaignId)).emit('door:updated', {
      door: toWireDoor({ ...wall, doorState }),
    });
    // Everyone's sight changes the moment a door swings.
    await broadcastSceneState(io, ctx.campaignId);

  });

  /**
   * Where something can move.
   *
   * A query, answered to the asking socket alone - the established shape for
   * this codebase, since no handler anywhere uses an acknowledgement. It has to
   * be computed here rather than in the browser for the same reason vision is:
   * players are never sent wall geometry, so a client cannot know what stops a
   * step.
   */
  socket.on('movement:query', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = movementQuerySchema.parse(payload);
    const scene = await activeSceneOf(ctx.campaignId);
    if (!scene) return;

    const { walls: sceneWalls, tokens: sceneTokens } = await dragState(scene.id);
    const { gridWidth, gridHeight } = gridExtent(scene);
    const bounds = { width: gridWidth, height: gridHeight };

    // What this viewer may act on at all. A player asking about a token they
    // cannot see gets nothing back rather than a shape to infer from.
    const view = ctx.isDM ? null : await computePlayerView(scene, sceneWalls, sceneTokens, user.id);
    const visible = ctx.isDM
      ? sceneTokens
      : visibleTokens(
          sceneTokens.filter((t) => t.layer !== 'gm' && (!t.hidden || t.ownerUserId === user.id)),
          view?.polygons ?? [],
          user.id,
        );

    // Occupancy is drawn from what this viewer can see, NOT from every token on
    // the scene. A hidden ambusher standing in a corridor would otherwise punch
    // a creature-shaped hole in the player's range and give itself away - the
    // same leak as sending the token, arrived at by inference. The cost is that
    // a range can cross a square that turns out to be occupied, which
    // `token:commit` rejects anyway.
    const blockers = ctx.isDM ? sceneTokens : visible;

    const rangeFor = async (token: Token) =>
      reachableSquares({
        origin: { x: token.x, y: token.y, w: token.w, h: token.h },
        speedFeet: await speedOf(token),
        feetPerSquare: scene.feetPerSquare,
        walls: sceneWalls,
        occupied: blockers.filter((t) => t.id !== token.id),
        bounds,
      });

    let squares: [number, number][] = [];

    if (input.threat) {
      // Hostile only. Neutral is an ally, or an ally for now, and painting it
      // as a threat is the thing that makes the overlay untrustworthy.
      const enemies = visible.filter((t) => t.disposition === 'hostile');
      squares = unionOfReach(await Promise.all(enemies.map(rangeFor)));
    } else if (input.tokenId) {
      const token = visible.find((t) => t.id === input.tokenId);
      if (token) squares = await rangeFor(token);
    }

    // Clipped to ground this player has already walked or seen. Without it a
    // goblin's reach spilling round a corner is a free map of the corridor.
    if (!ctx.isDM && squares.length > 0) {
      const explored = new Set((view?.vision.explored ?? []).map(([x, y]) => `${x}:${y}`));
      squares = squares.filter(([x, y]) => explored.has(`${x}:${y}`));
    }

    socket.emit('movement:range', { tokenId: input.tokenId, threat: input.threat, squares });
  });

  /**
   * A ping, which may be a dragged stroke rather than a dot.
   *
   * Never persisted: it is a gesture, not an annotation, and the client expires
   * it a few seconds later. The colour is resolved here from the player's
   * active character so nobody can ping in someone else's colour.
   */
  socket.on('ping:map', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = pingSchema.parse(payload);
    const scene = await sceneOf(input.sceneId);
    if (!scene || scene.campaignId !== ctx.campaignId) return;

    if (!ctx.isDM && !scene.playerDrawing) return;

    io.to(campaignRoom(ctx.campaignId)).emit('ping:map', {
      ...input,
      byUserId: user.id,
      color: await pointerColor(ctx.isDM, input.actorId, user.id),
    });
  });
}
