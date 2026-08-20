import { and, asc, eq } from 'drizzle-orm';
import {
  DM_COLOR,
  OWNERSHIP,
  actorColor,
  campaignDmRoom,
  campaignRoom,
  clampToMap,
  deriveToken,
  DOOR_CLOSED,
  DOOR_LOCKED,
  DOOR_OPEN,
  PLAIN_WALL,
  SECRET_DOOR,
  drawingCreateSchema,
  encodeFog,
  encodeTerrain,
  footprintBlocked,
  movementBlocked,
  nextTokenName,
  paintTerrain,
  paintedCells,
  pathBlocked,
  revealAll,
  terrainForGrid,
  terrainPaintSchema,
  terrainMatchesGrid,
  movementQuerySchema,
  pingSchema,
  reachableCosts,
  reachableSquares,
  routeExists,
  costToFeet,
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
  blindedTokenIds,
  conditionsOf,
  effectsViewFor,
  setConditions,
  toWireEffects,
  type EffectsView,
} from '../lib/effects.js';
import {
  actorCampaigns,
  actors,
  campaignMembers,
  campaigns,
  encounters,
  fogExploration,
  initiativeEntries,
  sceneTerrain,
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
import type { TerrainMap } from '@dnd/shared';

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
const dragCache = new Map<
  string,
  { walls: Wall[]; tokens: Token[]; effects: EffectsView; allowsStats: boolean; at: number }
>();
const DRAG_CACHE_TTL_MS = 5000;

export function invalidateDragCache(sceneId: string): void {
  dragCache.delete(sceneId);
}

async function dragState(
  sceneId: string,
  campaignId: string,
): Promise<{ walls: Wall[]; tokens: Token[]; effects: EffectsView; allowsStats: boolean }> {
  const cached = dragCache.get(sceneId);
  if (cached && Date.now() - cached.at < DRAG_CACHE_TTL_MS) return cached;

  const [sceneWalls, sceneTokens] = await Promise.all([
    wallsOf(sceneId),
    db.select().from(tokens).where(eq(tokens.sceneId, sceneId)),
  ]);
  // Cached alongside the walls for the same reason: a blinded token's sight is
  // recomputed on every drag frame, and effects are what decide that.
  const effects = await effectsViewFor(campaignId, sceneTokens.map((token) => token.id));
  // Cached for the same reason again: token:move runs at ~30Hz per player, and
  // a per-frame lookup of a campaign setting would be a query per frame.
  const allowsStats = await campaignAllowsStats(campaignId);

  const entry = { walls: sceneWalls, tokens: sceneTokens, effects, allowsStats, at: Date.now() };
  dragCache.set(sceneId, entry);
  return entry;
}

/** The campaign's default for whether players may read enemy stat blocks. */
export async function campaignAllowsStats(campaignId: string): Promise<boolean> {
  const rows = await db
    .select({ allowed: campaigns.playersSeeEnemyStats })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  return rows[0]?.allowed ?? true;
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
/**
 * `showStats` covers what a creature *is* - the conditions it is under, and the
 * stat block reachable from it. `showHp` covers how close it is to dying, and
 * the two are deliberately separate decisions: a table can agree that knowing
 * an ogre is an ogre is ordinary play while "the ogre is on 7" stays the DM's
 * to narrate.
 */
function toWireToken(
  token: Token,
  effects: EffectsView,
  showHp = true,
  showStats = true,
  isDM = true,
): WireToken {
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
    // Derived from the token's effect rows rather than a column, so the label,
    // the mechanics and the timer are one thing that cannot disagree.
    conditions: showStats ? conditionsOf(effects.byToken.get(token.id)) : [],
    effects: showStats ? toWireEffects(effects.byToken.get(token.id), effects.round) : [],
    /** Whether this viewer may ask for the stat block. Never a client decision. */
    statsVisible: showStats,
    // Never leaked to players: see the note on WireToken.
    statsHidden: isDM ? token.statsHidden : false,
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
export function filterTokensFor(
  list: Token[],
  isDM: boolean,
  userId: string,
  effects: EffectsView,
  campaignAllowsStats: boolean,
): WireToken[] {
  if (isDM) return list.map((token) => toWireToken(token, effects));

  return list
    .filter((token) => {
      if (token.layer === 'gm') return false;
      if (token.hidden && token.ownerUserId !== userId) return false;
      return true;
    })
    .map((token) =>
      toWireToken(
        token,
        effects,
        Boolean(token.ownerUserId),
        mayReadStats(token, false, userId, campaignAllowsStats),
        false,
      ),
    );
}

/**
 * Whether a viewer may read what a creature is.
 *
 * One function, used by both the payload gate and the stat block route, so the
 * board and the API cannot disagree about who may see what. The per-token flag
 * is only ever restrictive - it cannot open a creature the campaign has closed
 * - which leaves one direction to reason about.
 */
export function mayReadStats(
  token: Token,
  isDM: boolean,
  userId: string,
  campaignAllowsStats: boolean,
): boolean {
  if (isDM) return true;
  if (token.ownerUserId === userId) return true;
  return campaignAllowsStats && !token.statsHidden;
}

/* ------------------------------------------------------------ permissions */

/** A player may move only tokens they own; the DM may move anything. */
function mayControl(token: Token, isDM: boolean, userId: string): boolean {
  if (isDM) return true;
  if (token.locked) return false;
  return token.ownerUserId === userId;
}

/**
 * The ground the DM has painted on a scene, at the grid it is on now.
 *
 * Dropped rather than reinterpreted when the grid has moved, the same rule fog
 * follows: the bits are indexed by width, so reading them at another width
 * paints a lake diagonally across the map.
 */
async function terrainOf(scene: Scene): Promise<TerrainMap> {
  const { gridWidth, gridHeight } = gridExtent(scene);
  const rows = await db
    .select()
    .from(sceneTerrain)
    .where(eq(sceneTerrain.sceneId, scene.id))
    .limit(1);

  return terrainForGrid(rows[0], gridWidth, gridHeight);
}

/**
 * Where a token stands in the fight, if there is one on its scene.
 *
 * Null when no encounter is running, when it is running somewhere else, or when
 * this creature is not in the order - a familiar the DM never rolled for is not
 * in the fight, and staging a monster mid-combat should not be refused.
 *
 * Entries are read in `sortOrder`, which is the order `broadcastEncounter`
 * builds the tracker with. Any other ordering here names a different creature
 * as the one acting, and the turn bar and the server would disagree about whose
 * turn it is.
 */
async function turnStateFor(
  token: Token,
  campaignId: string,
): Promise<{ encounterId: string; sceneId: string; isActing: boolean } | null> {
  const rows = await db
    .select()
    .from(encounters)
    .where(and(eq(encounters.campaignId, campaignId), eq(encounters.isActive, true)))
    .limit(1);

  const encounter = rows[0];
  if (!encounter || encounter.sceneId !== token.sceneId) return null;

  const order = await db
    .select({ tokenId: initiativeEntries.tokenId })
    .from(initiativeEntries)
    .where(eq(initiativeEntries.encounterId, encounter.id))
    .orderBy(asc(initiativeEntries.sortOrder));

  const index = order.findIndex((entry) => entry.tokenId === token.id);
  if (index === -1) return null;

  return {
    encounterId: encounter.id,
    sceneId: encounter.sceneId,
    isActing: index === encounter.activeIndex,
  };
}

/**
 * What a creature has left of its turn, in feet.
 *
 * Speed is folded through conditions first, so a creature that was restrained
 * after moving is held to the speed it has now. Clamped at zero: the DM is
 * never refused a move, so a monster dragged across the map can have spent more
 * than it had.
 */
function movementLeft(token: Token, speedFeet: number): number {
  return Math.max(0, speedFeet - token.movedFeet);
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
export async function tokenIn(tokenId: string, campaignId: string): Promise<Token | null> {
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
async function speedOf(token: Token, conditions: string[]): Promise<number> {
  const base = await baseSpeedOf(token);
  // Folded through the same pure function the HUD uses. Read raw, this reported
  // a paralyzed token's full 30 ft while the HUD beside it said 0 - and this is
  // the number a turn's movement is measured against, so an unconditioned one
  // would hand a paralyzed creature a full turn of walking.
  return deriveToken({ conditions }, base).speed;
}

async function baseSpeedOf(token: Token): Promise<number> {
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
  // A secret door is wall geometry: knowing there is a way through the north
  // wall of the library is the discovery, and sending it is the same leak as
  // sending the walls. Revealing one turns it into an ordinary door.
  const playerDoors = doors.filter((d) => d.door !== SECRET_DOOR);
  const notes = await db.select().from(mapNotes).where(eq(mapNotes.sceneId, sceneId));
  const drawings = await db.select().from(drawingsTable).where(eq(drawingsTable.sceneId, sceneId));
  // Once for the whole scene rather than once per viewer: effects do not differ
  // between audiences, only which tokens each viewer is sent.
  const effects = await effectsViewFor(campaignId, all.map((token) => token.id));
  const blinded = blindedTokenIds(effects.byToken);
  // Once for the whole push, like the effects above: it is the same answer for
  // every socket in the room.
  const allowsStats = await campaignAllowsStats(campaignId);

  // Per-socket, because both "hidden unless you own it" and line of sight
  // differ between players.
  // Once for the room, like the effects above: the painted ground is the same
  // for everyone who may see it at all.
  const { gridWidth, gridHeight } = gridExtent(scene);
  const storedTerrain = await db
    .select()
    .from(sceneTerrain)
    .where(eq(sceneTerrain.sceneId, scene.id))
    .limit(1);
  const terrain = terrainForGrid(storedTerrain[0], gridWidth, gridHeight);

  for (const socket of await io.in(campaignRoom(campaignId)).fetchSockets()) {
    const userId = socket.data.user.id;
    const isDM = socket.data.rooms.get(campaignId) === 'dm';

    if (isDM) {
      socket.emit('scene:state', {
        scene: wireScene,
        tokens: filterTokensFor(all, true, userId, effects, allowsStats),
        vision: null,
        doors,
        notes,
        drawings,
        walls: sceneWalls.map(toWireWall),
      });

      // Painted ground rides alongside, to the DM alone. Sent here as well as
      // on each stroke so opening a scene shows what is already painted.
      socket.emit('terrain:state', {
        sceneId: scene.id,
        terrain: {
          ...paintedCells(terrain),
          // The panel says so rather than the map quietly drawing nothing: this
          // is the DM's hand work, not something re-earned by walking.
          matchesGrid: terrainMatchesGrid(storedTerrain[0], gridWidth, gridHeight),
        },
      });
      continue;
    }

    const view = await computePlayerView(scene, sceneWalls, all, userId, blinded);
    // Two filters in sequence: hidden tokens first, then line of sight.
    const permitted = filterTokensFor(all, false, userId, effects, allowsStats);
    const sighted = view
      ? visibleTokens(
          all.filter((t) => permitted.some((p) => p.id === t.id)),
          view.polygons,
          userId,
        )
      : all.filter((t) => permitted.some((p) => p.id === t.id));

    socket.emit('scene:state', {
      scene: wireScene,
      tokens: filterTokensFor(sighted, false, userId, effects, allowsStats),
      vision: view?.vision ?? null,
      doors: playerDoors,
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

  // The whole scene's effects, not just this token's: a blinded viewer sees
  // nothing regardless of which token moved.
  const effects = await effectsViewFor(campaignId, all.length > 0 ? all.map((t) => t.id) : [token.id]);
  const blinded = blindedTokenIds(effects.byToken);
  const allowsStats = await campaignAllowsStats(campaignId);

  for (const socket of await io.in(campaignRoom(campaignId)).fetchSockets()) {
    const userId = socket.data.user.id;
    const isDM = socket.data.rooms.get(campaignId) === 'dm';

    let visible = filterTokensFor([token], isDM, userId, effects, allowsStats);

    // Out of sight is as good as hidden: a moving enemy behind a wall must not
    // stream its position to a player who cannot see it.
    if (visible.length > 0 && !isDM && scene?.visionEnabled) {
      const view = await computePlayerView(scene, sceneWalls, all, userId, blinded);
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
    // The campaign this socket declared it is acting in, not whichever room it
    // happens to have joined first.
    const campaignId = socket.data.activeCampaignId;
    if (!campaignId) return null;

    // Re-checked per event; room membership authenticates but does not authorize.
    const membership = await getMembership(campaignId, user.id);
    if (!membership) {
      socket.emit('error', { message: 'You are not in that campaign', code: 'NOT_A_MEMBER' });
      return null;
    }
    return { campaignId, isDM: membership.isDM };
  }

  /**
   * Fog the DM owns, rather than only the vision sweep owning it.
   *
   * Exploration was written per player as they walked and never touched again,
   * so there was no way to open a door dramatically and no way to reuse a map.
   * Both of these write the same per-player bitmap the sweep does, and both end
   * in a full scene push - a change that alters sight pushes the whole scene,
   * never one token.
   */
  /**
   * Paints ground, and tells the DM room what it now looks like.
   *
   * A pillar is four wall segments and drawing it that way is fine; a lake or a
   * cave's ragged edge is not, which is what this is for.
   *
   * The painted map goes to the DM room alone. It is a map of the dungeon in
   * the same way wall geometry is, and players feel it the same way they feel
   * walls - through a movement overlay and a refused drag, both computed on the
   * server.
   */
  socket.on('terrain:paint', async (payload) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can shape the ground' });
      return;
    }

    // Parsed, not destructured and cast. `brush` is used as a key into the
    // terrain map, so an unknown one threw inside `paintTerrain` rather than
    // being refused here, and `cells` was an unbounded array of arbitrary
    // numbers - fractional coordinates truncate into a different square's bit
    // than the one asked for.
    const { sceneId, brush, cells } = terrainPaintSchema.parse(payload);

    const scene = await sceneOf(sceneId);
    if (!scene || scene.campaignId !== ctx.campaignId) return;

    const { gridWidth, gridHeight } = gridExtent(scene);
    const painted = paintTerrain(await terrainOf(scene), cells, brush);
    const bitmaps = encodeTerrain(painted);

    await db
      .insert(sceneTerrain)
      .values({ sceneId: scene.id, gridWidth, gridHeight, ...bitmaps, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: sceneTerrain.sceneId,
        set: { gridWidth, gridHeight, ...bitmaps, updatedAt: Date.now() },
      });

    io.to(campaignDmRoom(ctx.campaignId)).emit('terrain:state', {
      sceneId: scene.id,
      terrain: { ...paintedCells(painted), matchesGrid: true },
    });
  });

  socket.on('fog:reveal', async ({ sceneId }) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can change the fog' });
      return;
    }

    // Resolved through the campaign rather than taken on trust, like every
    // other id-taking handler here.
    const scene = await sceneOf(sceneId);
    if (!scene || scene.campaignId !== ctx.campaignId) return;

    const { gridWidth, gridHeight } = gridExtent(scene);
    const bitmap = encodeFog(revealAll(gridWidth, gridHeight));

    const members = await db
      .select({ userId: campaignMembers.userId })
      .from(campaignMembers)
      .where(eq(campaignMembers.campaignId, ctx.campaignId));

    for (const { userId } of members) {
      await db
        .insert(fogExploration)
        .values({
          sceneId: scene.id,
          userId,
          // Stored with the bitmap so a later recalibration drops this the same
          // way it drops honestly explored ground: a different grid is a
          // different map, and the bits would decode smeared.
          gridWidth,
          gridHeight,
          exploredBitmap: bitmap,
          updatedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [fogExploration.sceneId, fogExploration.userId],
          set: { gridWidth, gridHeight, exploredBitmap: bitmap, updatedAt: Date.now() },
        });
    }

    await broadcastSceneState(io, ctx.campaignId);
  });

  socket.on('fog:reset', async ({ sceneId }) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can change the fog' });
      return;
    }

    const scene = await sceneOf(sceneId);
    if (!scene || scene.campaignId !== ctx.campaignId) return;

    // Rows away entirely rather than a cleared bitmap: the next sweep writes a
    // fresh one at whatever grid the scene has by then.
    await db.delete(fogExploration).where(eq(fogExploration.sceneId, scene.id));

    await broadcastSceneState(io, ctx.campaignId);
  });

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

    // No `scene:changed` here: it was emitted and nothing ever listened, and the
    // full scene push on the next line is what actually moves every client. An
    // emit nobody handles reads like working code, which is worse than nothing.
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
    const {
      walls: cachedWalls,
      tokens: cachedTokens,
      effects: cachedEffects,
      allowsStats: cachedAllowsStats,
    } = await dragState(token.sceneId, ctx.campaignId);
    const live = cachedTokens.map((t) =>
      t.id === input.tokenId ? { ...t, x: input.x, y: input.y } : t,
    );

    for (const s of await io.in(campaignRoom(ctx.campaignId)).fetchSockets()) {
      if (s.data.rooms.get(ctx.campaignId) === 'dm') continue;

      const viewerId = s.data.user.id;
      const polygons = computeLivePolygons(
        scene,
        cachedWalls,
        live,
        viewerId,
        blindedTokenIds(cachedEffects.byToken),
      );
      const permitted = filterTokensFor(live, false, viewerId, cachedEffects, cachedAllowsStats);
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
        tokens: filterTokensFor(sighted, false, viewerId, cachedEffects, cachedAllowsStats),
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

    // Walls and painted ground stop players, not the DM - who needs to place
    // things anywhere, including inside a wall.
    if (!ctx.isDM && scene) {
      const sceneWalls = await wallsOf(token.sceneId);
      const ground = await terrainOf(scene);
      const from = tokenCenter(token);
      const to = tokenCenter({ x: snapped.x, y: snapped.y, w, h });

      // The cheap answer first, and it is the one nearly every drop gets: a
      // clear straight line means there is obviously a way, with no search.
      const straight =
        !movementBlocked(from, to, sceneWalls) &&
        !footprintBlocked(ground, snapped.x, snapped.y, w, h) &&
        !pathBlocked(ground, from, to);

      // A blocked straight line is not a refusal, it is a question. Dragging a
      // token round a corner or along the shore of a lake traces a segment that
      // clips the thing being avoided, and testing that segment alone refused
      // moves the creature could plainly walk - while the movement overlay, a
      // flood fill, had been drawing those very squares as reachable. The board
      // offered a square and the server then bounced you off it.
      const { gridWidth, gridHeight } = gridExtent(scene);
      if (
        !straight &&
        !routeExists({
          origin: { x: token.x, y: token.y, w, h },
          destination: { x: snapped.x, y: snapped.y },
          walls: sceneWalls,
          bounds: { width: gridWidth, height: gridHeight },
          terrain: ground,
        })
      ) {
        // One refusal for both, because the difference is the DM's to know: a
        // player told "a wall" rather than "no footing" has learnt where the
        // wall is without ever seeing it.
        socket.emit('error', { message: 'There is no way through' });
        // Send the authoritative position back so the client snaps home.
        await broadcastToken(io, ctx.campaignId, token);
        return;
      }
    }

    /**
     * A turn's movement, which only exists while a fight is running.
     *
     * Out of combat nothing spends: players have free rein of the scene and
     * the overlay is advice. In combat the overlay becomes a promise - the
     * squares it draws are the squares the server will accept - which is the
     * only reading of it that is any use when a round is being counted.
     *
     * Priced with the same search that draws the overlay, so the two cannot
     * disagree about what a route through mud costs.
     */
    const turn = await turnStateFor(token, ctx.campaignId);

    if (turn && !ctx.isDM && !turn.isActing) {
      socket.emit('error', { message: 'It is not their turn' });
      await broadcastToken(io, ctx.campaignId, token);
      return;
    }

    let spend = 0;

    if (turn && scene) {
      const { walls: turnWalls, tokens: sceneTokens, effects: turnEffects } = await dragState(
        token.sceneId,
        ctx.campaignId,
      );
      const { gridWidth, gridHeight } = gridExtent(scene);
      const speed = await speedOf(token, conditionsOf(turnEffects.byToken.get(token.id)));
      const left = movementLeft(token, speed);

      const affordable = reachableCosts({
        origin: { x: token.x, y: token.y, w, h },
        speedFeet: left,
        feetPerSquare: scene.feetPerSquare,
        walls: turnWalls,
        // Creatures do not block a *drop* - `token:commit` has never refused a
        // move for occupancy, and starting now would strand anyone the party
        // has surrounded. They only shape what a route costs.
        occupied: [],
        bounds: { width: gridWidth, height: gridHeight },
        terrain: await terrainOf(scene),
      });

      const landed = affordable.get(`${snapped.x}:${snapped.y}`);

      if (!landed && !ctx.isDM) {
        socket.emit('error', {
          message:
            left > 0
              ? `That is further than ${token.name || 'this creature'} can move this turn — ${Math.round(left)} ft left`
              : `${token.name || 'This creature'} has no movement left this turn`,
        });
        await broadcastToken(io, ctx.campaignId, token);
        return;
      }

      // The DM is never refused, so a monster dragged past what it had spends
      // everything it had rather than a price this search cannot name.
      spend = landed ? costToFeet(landed.cost, scene.feetPerSquare) : left;

      // Unused tokens are ignored deliberately: this is about the creature
      // being moved, and reading the rest would be a query per drop.
      void sceneTokens;
    }

    await db
      .update(tokens)
      .set({
        x: snapped.x,
        y: snapped.y,
        w,
        h,
        rotation: input.rotation ?? token.rotation,
        ...(turn ? { movedFeet: token.movedFeet + spend } : {}),
      })
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
      // Scoped through `actorCampaigns` rather than taken on trust, the same
      // rule `tokenIn` and `wallIn` follow. A DM stamping a token could
      // otherwise name an actor id from somebody else's game and copy its
      // name, portrait, AC and hit points onto their own board. The Tokens
      // panel only ever offers actors assigned here, so nothing legitimate
      // changes.
      const assigned = await db
        .select({ id: actorCampaigns.actorId })
        .from(actorCampaigns)
        .where(
          and(
            eq(actorCampaigns.actorId, input.actorId),
            eq(actorCampaigns.campaignId, ctx.campaignId),
          ),
        )
        .limit(1);

      // Two ways to belong here, because the app writes both: assigned through
      // `actorCampaigns`, or authored inside this campaign (`actors.campaignId`,
      // which `from-monster` and the NPC form set). Either is a real signal;
      // neither admits an actor from somebody else's game.
      const found = await db
        .select()
        .from(actors)
        .where(
          and(
            eq(actors.id, input.actorId),
            assigned.length > 0 ? undefined : eq(actors.campaignId, ctx.campaignId),
          ),
        )
        .limit(1);
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

    // Placed one at a time inside a loop rather than in a batch, because each
    // copy has to see the ones before it: `firstFreeSquare` needs the square
    // its predecessor took, and `nextTokenName` needs its number. A batch would
    // stack six goblins on one square and call them all Goblin.
    const placedOnScene = [...existing];
    const created: Token[] = [];

    for (let copy = 0; copy < input.quantity; copy++) {
      const snapped = firstFreeSquare(
        snapTokenPosition({ x: input.x, y: input.y }, w, h),
        w,
        h,
        placedOnScene,
        scene,
      );

      const token = {
        id: newId(),
        sceneId: input.sceneId,
        name: nextTokenName(name ?? '', placedOnScene.map((t) => t.name)),
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
        hidden: input.hidden,
        locked: input.locked,
        statsHidden: input.statsHidden,
        createdAt: Date.now(),
      };

      await db.insert(tokens).values(token);
      // Conditions are rows, not a column, so a token stamped with any go in here.
      if (input.conditions.length > 0) await setConditions(token.id, input.conditions);

      placedOnScene.push(token as Token);
      created.push(token as Token);
    }

    invalidateDragCache(input.sceneId);

    // Sight is checked here as well as hidden-ness. Placing an ambusher behind
    // a wall used to ship its full stat line - name, HP, position - to every
    // player, and unlike a drag frame nothing corrected it until the next full
    // scene push.
    for (const made of created) {
      const placed = await tokenIn(made.id, ctx.campaignId);
      if (placed) await broadcastToken(io, ctx.campaignId, placed, 'token:created');
    }
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
      // What a player may know about a creature is the DM's call, for the same
      // reason `disposition` is: a player able to set this could simply share
      // the boss with themselves.
      'statsHidden',
    ];
    const touchesDmField = dmOnly.some((key) => key in input);

    if (!ctx.isDM && (touchesDmField || token.ownerUserId !== user.id)) {
      socket.emit('error', { message: 'You cannot change that token' });
      return;
    }

    const { tokenId, conditions, ...fields } = input;
    // Conditions live in `active_effects` now. Reconciled rather than written
    // wholesale so clicking one chip does not reset the timers on the others.
    if (conditions !== undefined) await setConditions(tokenId, conditions);
    if (Object.keys(fields).length > 0) {
      await db.update(tokens).set(fields).where(eq(tokens.id, tokenId));
    }

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

    // The drag cache holds this scene's tokens and their effects for 5 s, and
    // both just changed.
    invalidateDragCache(token.sceneId);

    // Some of these fields decide what a player can SEE, not just what one
    // token looks like: blinding a token collapses its owner's sight polygon,
    // and the light and vision ranges are what the sweep measures from. A
    // per-token broadcast cannot express that, so the whole scene is recomputed
    // and every player's vision goes out with it. Without this the change did
    // not land until some unrelated event happened to push a full scene state.
    const changesSight =
      conditions !== undefined ||
      ['visionRange', 'darkvisionRange', 'lightBright', 'lightDim'].some((key) => key in input);

    if (changesSight) {
      await broadcastSceneState(io, ctx.campaignId);
      return;
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
      // Scoped to this campaign, like every other client-supplied id. Taken on
      // trust, a DM of their own game could rub out somebody else's annotation.
      const rows = await db
        .select({ drawing: drawingsTable })
        .from(drawingsTable)
        .innerJoin(scenes, eq(drawingsTable.sceneId, scenes.id))
        .where(and(eq(drawingsTable.id, drawingId), eq(scenes.campaignId, ctx.campaignId)))
        .limit(1);
      const drawing = rows[0]?.drawing;
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

    // `sceneId` is dropped rather than accepted: the schema permitted it, and
    // `wallIn` validates the scene the wall is in NOW - so a wall could be
    // moved into another campaign's scene through a check that had already
    // passed. Moving a wall between scenes is not a thing the app does.
    const { wallId, sceneId: _ignored, ...fields } = wallUpdateSchema.parse(payload);
    const wall = await wallIn(wallId, ctx.campaignId);
    if (!wall) return;

    // Drizzle throws on `set({})`, and every field is optional, so a payload of
    // just an id used to be an error rather than a no-op.
    if (Object.keys(fields).length === 0) return;

    await db.update(wallsTable).set(fields).where(eq(wallsTable.id, wallId));
    invalidateDragCache(wall.sceneId);

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
    if (!wall || wall.door === PLAIN_WALL) return;

    // A player is never sent a secret door, so an id for one did not come from
    // their board. Refuse it silently rather than confirming it exists.
    if (wall.door === SECRET_DOOR && !ctx.isDM) return;

    if (wall.doorState === DOOR_LOCKED && !ctx.isDM) {
      socket.emit('error', { message: 'That door is locked' });
      return;
    }

    const doorState = wall.doorState === DOOR_OPEN ? DOOR_CLOSED : DOOR_OPEN;
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

    const {
      walls: sceneWalls,
      tokens: sceneTokens,
      effects,
      allowsStats,
    } = await dragState(scene.id, ctx.campaignId);
    const { gridWidth, gridHeight } = gridExtent(scene);
    const bounds = { width: gridWidth, height: gridHeight };

    // What this viewer may act on at all. A player asking about a token they
    // cannot see gets nothing back rather than a shape to infer from.
    const view = ctx.isDM
      ? null
      : await computePlayerView(
          scene,
          sceneWalls,
          sceneTokens,
          user.id,
          blindedTokenIds(effects.byToken),
        );
    // Two filters in sequence, exactly as `broadcastSceneState` does it: hidden
    // tokens first, then line of sight - and the second only when there is a
    // view to apply.
    //
    // `visibleTokens` reads an empty polygon list as "sees nothing but its own
    // tokens", which is right for a blinded player and wrong for a scene with
    // dynamic vision switched off, where `computePlayerView` returns null and
    // nothing is hidden from anyone. Passing `[]` there left a player with only
    // their own tokens in hand: the threat overlay had no enemies to union and
    // came back empty on every ordinary scene, and their own range routed
    // straight through creatures it should have gone around.
    const permitted = sceneTokens.filter(
      (t) => t.layer !== 'gm' && (!t.hidden || t.ownerUserId === user.id),
    );
    const visible = ctx.isDM
      ? sceneTokens
      : view
        ? visibleTokens(permitted, view.polygons, user.id)
        : permitted;

    // Occupancy is drawn from what this viewer can see, NOT from every token on
    // the scene. A hidden ambusher standing in a corridor would otherwise punch
    // a creature-shaped hole in the player's range and give itself away - the
    // same leak as sending the token, arrived at by inference. The cost is that
    // a range can cross a square that turns out to be occupied, which
    // `token:commit` rejects anyway.
    const blockers = ctx.isDM ? sceneTokens : visible;

    const terrain = await terrainOf(scene);

    /**
     * What a creature may still spend.
     *
     * A full turn's speed out of combat, where nothing is counted, and what is
     * left of the turn once a fight is running - so the overlay shrinks as a
     * creature walks and the squares it draws stay the squares `token:commit`
     * will accept.
     */
    const budgetFor = async (token: Token): Promise<{ left: number; max: number }> => {
      const max = await speedOf(token, conditionsOf(effects.byToken.get(token.id)));
      const turn = await turnStateFor(token, ctx.campaignId);
      return { left: turn ? movementLeft(token, max) : max, max };
    };

    const rangeFor = async (token: Token) =>
      reachableSquares({
        origin: { x: token.x, y: token.y, w: token.w, h: token.h },
        speedFeet: (await budgetFor(token)).left,
        feetPerSquare: scene.feetPerSquare,
        walls: sceneWalls,
        occupied: blockers.filter((t) => t.id !== token.id),
        bounds,
        // The overlay stops where the ground does. Players are never sent the
        // terrain itself - they are sent the squares it leaves them, exactly as
        // they are sent a vision polygon rather than the walls behind it.
        terrain,
      });

    let squares: [number, number][] = [];

    if (input.threat) {
      // Hostile only. Neutral is an ally, or an ally for now, and painting it
      // as a threat is the thing that makes the overlay untrustworthy.
      const enemies = visible.filter((t) => t.disposition === 'hostile');
      squares = unionOfReach(await Promise.all(enemies.map(rangeFor)));
    } else if (input.tokenId) {
      const token = visible.find((t) => t.id === input.tokenId);

      // A reach is a speed drawn on the board, and speed is stat block data -
      // so this asks the same question the stat block route asks, through the
      // same function. Without it a player could read the speed of a creature
      // whose stats the DM had closed, by asking for its range instead: a
      // second gate on the same data that disagreed with the first.
      //
      // The threat union above is deliberately not gated. It covers hostiles
      // only, it is a union rather than one creature's answer, and offering it
      // is the whole point of the overlay.
      const allowed =
        token &&
        (mayControl(token, ctx.isDM, user.id) ||
          mayReadStats(token, ctx.isDM, user.id, allowsStats));

      if (token && allowed) squares = await rangeFor(token);
    }

    // Clipped to ground this player has already walked or seen. Without it a
    // goblin's reach spilling round a corner is a free map of the corridor.
    //
    // Only when there is a view to clip against. `computePlayerView` returns
    // null on a scene with dynamic vision off, and the clip then filtered
    // against an empty set and threw the whole range away - so on a scene with
    // vision off, which is the default, a player selected their token and saw
    // nothing at all. Nothing is hidden on such a scene, so there is nothing to
    // leak by drawing the range in full.
    if (!ctx.isDM && view && squares.length > 0) {
      const explored = new Set((view?.vision.explored ?? []).map(([x, y]) => `${x}:${y}`));
      squares = squares.filter(([x, y]) => explored.has(`${x}:${y}`));
    }

    // Only for one creature's own range, and only while a fight is running.
    // A threat union is several creatures at once, so a single budget would be
    // a number about nobody.
    const asked = input.threat || !input.tokenId ? null : visible.find((t) => t.id === input.tokenId);
    const inFight = asked ? await turnStateFor(asked, ctx.campaignId) : null;
    const budget = asked && inFight ? await budgetFor(asked) : null;

    socket.emit('movement:range', {
      tokenId: input.tokenId,
      threat: input.threat,
      squares,
      leftFeet: budget ? budget.left : null,
      maxFeet: budget ? budget.max : null,
    });
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
