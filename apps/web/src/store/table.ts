import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { api } from '../lib/api.js';
import { getPref, setPref } from '../lib/prefs.js';
import type {
  ClientToServerEvents,
  TerrainBrush,
  TerrainCells,
  RollMode,
  ServerToClientEvents,
  WireChatMessage,
  WirePresence,
  WireDoor,
  WireDrawing,
  WireEncounter,
  WireMapNote,
  WireTemplate,
  WireScene,
  WireToken,
  WireVision,
  WireWall,
} from '@dnd/shared';

type TableSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * What clicking the board does. Named once: it was spelled out twice, in the
 * field and in the setter, so adding a brush meant editing both and the two
 * had already drifted by one entry.
 */
export type BoardTool =
  | 'off'
  | 'wall'
  | 'door'
  | 'secret'
  | 'note'
  | 'draw'
  | 'arrow'
  | TerrainBrush;

interface TableState {
  socket: TableSocket | null;
  campaignId: string | null;
  connected: boolean;
  messages: WireChatMessage[];
  members: WirePresence[];
  error: string | null;

  scene: WireScene | null;
  tokens: WireToken[];
  /** Null when the scene has vision off - everyone sees the whole map. */
  vision: WireVision | null;
  doors: WireDoor[];
  notes: WireMapNote[];
  drawings: WireDrawing[];
  /** Only ever populated for the DM; players never receive wall geometry. */
  walls: WireWall[];
  /** DM wall-drawing mode. */
  wallTool: BoardTool;
  /** Painted ground. DM-only: a player is never sent this. */
  terrain: TerrainCells;
  encounter: WireEncounter | null;
  templates: WireTemplate[];
  /**
   * Recent reversible actions, newest last. Bounded, because an undo stack
   * that grows all session is a memory leak nobody notices.
   */
  undoStack: UndoEntry[];
  /** A short-lived message with an undo affordance. */
  toast: { message: string; undo: boolean } | null;

  /** Most recent damage results, shown briefly then cleared. */
  lastDamage: { tokenId: string; name: string; before: number; after: number; reason: string }[] | null;

  /**
   * Bumped when the journal changes. The panel refetches on it rather than
   * receiving entries over the socket, so the server stays the only thing that
   * decides which entries a player is allowed to hold.
   */
  journalVersion: number;
  selectedTokenId: string | null;
  /** The token a player has targeted, which drives the action panel. */
  targetTokenId: string | null;
  /** Ephemeral. A ping with `points` is a dragged stroke rather than a dot. */
  pings: { id: number; x: number; y: number; color: string; points: number[] }[];

  /** The character the player is speaking and rolling as. */
  activeActorId: string | null;
  setActiveActor: (actorId: string | null) => void;

  connect: (campaignId: string) => void;
  disconnect: () => void;

  send: (body: string, whisperToUserId?: string | null) => void;
  roll: (expression: string, label?: string, secret?: boolean) => void;
  postCard: (itemId: string, actorId: string, targetTokenId?: string | null) => void;
  select: (tokenId: string | null) => void;
  target: (tokenId: string | null) => void;

  activateScene: (sceneId: string) => void;
  /** DM-only fog controls; the server refuses anyone else. */
  revealFog: (sceneId: string) => void;
  resetFog: (sceneId: string) => void;
  paintTerrain: (sceneId: string, brush: TerrainBrush, cells: [number, number][]) => void;
  createToken: (payload: Record<string, unknown>) => void;
  moveToken: (tokenId: string, x: number, y: number) => void;
  commitToken: (tokenId: string, x: number, y: number) => void;
  updateToken: (tokenId: string, fields: Record<string, unknown>) => void;
  deleteToken: (tokenId: string) => void;
  /** `points` carries a dragged stroke, in grid units; empty for a plain dot. */
  pingMap: (x: number, y: number, points?: number[]) => void;
  setWallTool: (tool: BoardTool) => void;
  addDrawing: (kind: 'freehand' | 'arrow' | 'text', points: number[], color: string, text?: string) => void;
  eraseDrawing: (id: string | 'mine' | 'all') => void;
  placeNote: (x: number, y: number) => Promise<void>;
  toggleNote: (noteId: string, hidden: boolean) => Promise<void>;
  removeNote: (noteId: string) => Promise<void>;
  createWall: (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    kind: 'wall' | 'door' | 'secret',
  ) => void;
  deleteWall: (wallId: string) => void;
  /** DM only. Locking a door and revealing a secret one both live here. */
  updateWall: (
    wallId: string,
    fields: Partial<{ door: number; doorState: number; blocksSight: number; blocksMovement: number }>,
  ) => void;
  toggleDoor: (wallId: string) => void;

  startEncounter: () => void;
  endEncounter: () => void;
  addToInitiative: (tokenIds: string[]) => void;
  removeFromInitiative: (entryId: string) => void;
  nextTurn: () => void;
  previousTurn: () => void;
  placeTemplate: (payload: Record<string, unknown>) => void;
  clearTemplate: (templateId: string) => void;
  groupRoll: (kind: 'skill' | 'save' | 'ability', key: string, dc: number | null, secret: boolean) => void;
  rollDeathSave: (tokenId: string) => void;
  showHandout: (pageId: string) => void;
  /** A handout being shown large right now. */
  reveal: { imageUrl: string; title: string } | null;
  dismissReveal: () => void;
  undo: () => void;
  dismissToast: () => void;
  applyDamage: (
    tokenIds: string[],
    amount: number,
    damageType: string,
    healing?: boolean,
    halved?: boolean,
  ) => void;
  /** `rounds` null lasts until removed; a number counts down in combat. */
  applyEffect: (tokenIds: string[], condition: string, rounds?: number | null) => void;
  updateEffect: (effectId: string, patch: { rounds?: number | null; disabled?: boolean }) => void;
  removeEffect: (effectId: string) => void;
  cardAction: (
    itemId: string,
    actorId: string,
    action: 'attack' | 'damage' | 'critical' | 'save' | 'versatile' | 'heal',
    mode?: RollMode,
    targetTokenId?: string | null,
  ) => void;
  /** Corrects a mistyped initiative, or sets the round and whose turn it is. */
  setInitiative: (
    encounterId: string,
    patch: {
      entries?: { id: string; initiative: number }[];
      round?: number;
      activeIndex?: number;
    },
  ) => void;
  /** DM only, enforced on the server. Takes the battle log with it. */
  clearChat: () => void;

  /**
   * Movement overlays. Reachability depends on walls, which players never
   * receive, so both of these are answers from the server rather than anything
   * the client works out.
   */
  /**
   * The selected creature's reach, and what its turn has left.
   *
   * `leftFeet` is null out of combat, where nothing is counted. It arrives with
   * the squares rather than on the token, because a remaining budget plus what
   * has been spent is a creature's speed - and speed is stat block data. The
   * reply is sent only to the socket that asked, which the server has already
   * checked may ask.
   */
  moveRange: {
    tokenId: string | null;
    squares: [number, number][];
    leftFeet: number | null;
    maxFeet: number | null;
  };
  threatRange: [number, number][];
  showThreat: boolean;
  queryMovement: (tokenId: string | null) => void;
  toggleThreat: () => void;
}

const MAX_MESSAGES = 300;
const MAX_UNDO = 10;

export interface UndoEntry {
  label: string;
  apply: () => void;
  /** Whether to surface a toast; a move is self-evident, a delete is not. */
  toast?: boolean;
  /**
   * The scene it happened in. Undoing into a different scene would recreate a
   * token somewhere it never was, so entries do not survive a scene change.
   */
  sceneId: string | null;
}

type SetState = (partial: Partial<TableState>) => void;
type GetState = () => TableState;

/** Records a reversible action and, unless told otherwise, offers an undo. */
function pushUndo(set: SetState, get: GetState, entry: UndoEntry): void {
  const stack = [...get().undoStack, entry];
  set({ undoStack: stack.length > MAX_UNDO ? stack.slice(-MAX_UNDO) : stack });

  if (entry.toast === false) return;

  set({ toast: { message: entry.label, undo: true } });
  setTimeout(() => {
    // Only clear it if nothing newer replaced it in the meantime.
    if (get().toast?.message === entry.label) set({ toast: null });
  }, 6000);
}

export const useTable = create<TableState>((set, get) => ({
  socket: null,
  campaignId: null,
  connected: false,
  messages: [],
  members: [],
  error: null,
  activeActorId: null,
  scene: null,
  tokens: [],
  selectedTokenId: null,
  targetTokenId: null,
  pings: [],
  vision: null,
  doors: [],
  notes: [],
  drawings: [],
  walls: [],
  wallTool: 'off',
  terrain: { blocked: [], mud: [], water: [], matchesGrid: true },
  encounter: null,
  lastDamage: null,
  journalVersion: 0,
  moveRange: { tokenId: null, squares: [], leftFeet: null, maxFeet: null },
  threatRange: [],
  showThreat: getPref('board-threat', false),
  undoStack: [],
  toast: null,
  reveal: null,
  templates: [],

  setActiveActor(actorId) {
    set({ activeActorId: actorId });
  },

  connect(campaignId) {
    const existing = get().socket;
    if (existing && get().campaignId === campaignId) return;
    existing?.close();

    // Same origin; Vite proxies /socket.io to the API in development.
    const socket: TableSocket = io({ path: '/socket.io', withCredentials: true });

    socket.on('connect', () => {
      set({ connected: true, error: null });
      socket.emit('campaign:join', { campaignId });
    });
    socket.on('disconnect', () => set({ connected: false }));

    socket.on('chat:history', ({ messages }) => set({ messages }));
    socket.on('chat:message', ({ message }) => {
      // Trim the backlog so a long session does not grow without bound.
      const next = [...get().messages, message];
      set({ messages: next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next });
    });
    socket.on('presence', ({ members }) => set({ members }));

    socket.on('scene:state', ({ scene, tokens, vision, doors, notes, drawings, walls }) => {
      // Entries refer to tokens in the scene they happened in; keeping them
      // across a switch would recreate one somewhere it never stood.
      if (scene?.id !== get().scene?.id) set({ undoStack: [], toast: null });

      // `walls` is absent for players, so it collapses to an empty array here.
      set({
        scene,
        tokens,
        vision: vision ?? null,
        doors: doors ?? [],
        notes: notes ?? [],
        drawings: drawings ?? [],
        walls: walls ?? [],
      });

      // A door opening or a token moving changes what is reachable, so any
      // range on screen is now a lie. Drop it and ask again.
      const { moveRange, showThreat } = get();
      set({ moveRange: { ...moveRange, squares: [] }, threatRange: [] });
      if (moveRange.tokenId) get().queryMovement(moveRange.tokenId);
      if (showThreat) socket.emit('movement:query', { tokenId: null, threat: true });
    });
    // Live sight during a drag: polygons and tokens only. Explored cells are
    // carried over from the last full scene:state, since fog exploration is
    // persisted on drop rather than on every frame.
    socket.on('vision:update', ({ polygons, tokens }) => {
      const current = get().vision;
      set({
        tokens,
        vision: current ? { ...current, polygons } : null,
      });
    });
    socket.on('door:updated', ({ door }) =>
      set({ doors: get().doors.map((d) => (d.id === door.id ? door : d)) }),
    );
    socket.on('initiative:state', ({ encounter }) => {
      // A turn change refills whoever is up next, so any range on screen is now
      // wrong in the generous direction. Ask again rather than leave a stale
      // budget where someone can act on it.
      const before = get().encounter;
      const turned =
        before?.activeIndex !== encounter?.activeIndex || before?.round !== encounter?.round;

      set({ encounter });

      const { moveRange, showThreat } = get();
      if (turned && moveRange.tokenId) get().queryMovement(moveRange.tokenId);
      if (turned && showThreat) socket.emit('movement:query', { tokenId: null, threat: true });
    });
    socket.on('template:state', ({ templates }) => set({ templates }));
    socket.on('journal:changed', () => set({ journalVersion: get().journalVersion + 1 }));
    socket.on('chat:cleared', () => set({ messages: [] }));

    socket.on('movement:range', ({ tokenId, threat, squares, leftFeet, maxFeet }) => {
      if (threat) set({ threatRange: squares });
      else set({ moveRange: { tokenId, squares, leftFeet, maxFeet } });
    });
    socket.on('handout:reveal', (reveal) => {
      set({ reveal });
      // Long enough to take in, short enough not to block the table.
      setTimeout(() => {
        if (get().reveal?.imageUrl === reveal.imageUrl) set({ reveal: null });
      }, 8000);
    });
    // Surfaced as a short-lived banner so the DM sees resistances being applied
    // without having to read the chat log mid-combat.
    socket.on('damage:applied', ({ results }) => {
      set({ lastDamage: results });
      setTimeout(() => {
        if (get().lastDamage === results) set({ lastDamage: null });
      }, 6000);
    });
    socket.on('wall:created', ({ wall }) => set({ walls: [...get().walls, wall] }));
    // Only ever arrives on a DM socket; the server sends it to the DM room.
    socket.on('terrain:state', ({ terrain }) => set({ terrain }));
    socket.on('wall:updated', ({ wall }) =>
      set({ walls: get().walls.map((w) => (w.id === wall.id ? wall : w)) }),
    );
    socket.on('wall:deleted', ({ wallId }) =>
      set({ walls: get().walls.filter((w) => w.id !== wallId) }),
    );
    socket.on('token:created', ({ token }) => set({ tokens: [...get().tokens, token] }));
    socket.on('token:updated', ({ token }) => {
      const existing = get().tokens;
      set({
        tokens: existing.some((t) => t.id === token.id)
          ? existing.map((t) => (t.id === token.id ? token : t))
          : [...existing, token],
      });
    });
    socket.on('token:deleted', ({ tokenId }) =>
      set({
        tokens: get().tokens.filter((t) => t.id !== tokenId),
        selectedTokenId: get().selectedTokenId === tokenId ? null : get().selectedTokenId,
        targetTokenId: get().targetTokenId === tokenId ? null : get().targetTokenId,
      }),
    );
    // Drag frames from other clients: position only, no database round trip.
    socket.on('token:moved', ({ tokenId, x, y }) =>
      set({ tokens: get().tokens.map((t) => (t.id === tokenId ? { ...t, x, y } : t)) }),
    );
    socket.on('ping:map', ({ x, y, color, points }) => {
      // A stroke lingers longer than a dot: it is meant to be read, not just
      // noticed, and it vanishes before anyone can treat it as an annotation.
      const ping = { id: Date.now() + Math.random(), x, y, color, points: points ?? [] };
      set({ pings: [...get().pings, ping] });
      const life = ping.points.length > 0 ? 5000 : 2500;
      setTimeout(() => set({ pings: get().pings.filter((p) => p.id !== ping.id) }), life);
    });
    socket.on('error', ({ message }) => set({ error: message }));

    set({ socket, campaignId, messages: [], members: [], tokens: [], scene: null, encounter: null, templates: [], notes: [], drawings: [], undoStack: [], toast: null });
  },

  disconnect() {
    const { socket, campaignId } = get();
    if (socket && campaignId) socket.emit('campaign:leave', { campaignId });
    socket?.close();
    set({ socket: null, campaignId: null, connected: false, messages: [], members: [] });
  },

  send(body, whisperToUserId = null) {
    const { socket, activeActorId } = get();
    socket?.emit('chat:send', { body, whisperToUserId, actorId: activeActorId });
  },

  roll(expression, label = '', secret = false) {
    const { socket, activeActorId } = get();
    // Only the expression travels; the server produces the numbers.
    socket?.emit('chat:roll', { expression, label, actorId: activeActorId, secret });
  },

  postCard(itemId, actorId, targetTokenId = null) {
    get().socket?.emit('chat:card', { itemId, actorId, targetTokenId });
  },

  select(tokenId) {
    set({ selectedTokenId: tokenId });
  },

  target(tokenId) {
    set({ targetTokenId: tokenId });
  },

  activateScene(sceneId) {
    get().socket?.emit('scene:activate', { sceneId });
  },

  revealFog(sceneId) {
    get().socket?.emit('fog:reveal', { sceneId });
  },

  resetFog(sceneId) {
    get().socket?.emit('fog:reset', { sceneId });
  },

  paintTerrain(sceneId, brush, cells) {
    if (cells.length === 0) return;
    get().socket?.emit('terrain:paint', { sceneId, brush, cells });
  },

  createToken(payload) {
    get().socket?.emit('token:create', payload as never);
  },

  moveToken(tokenId, x, y) {
    // Optimistic locally so the dragged token tracks the cursor without waiting.
    set({ tokens: get().tokens.map((t) => (t.id === tokenId ? { ...t, x, y } : t)) });
    get().socket?.emit('token:move', { tokenId, x, y });
  },

  commitToken(tokenId, x, y) {
    const before = get().tokens.find((t) => t.id === tokenId);
    if (before && (before.x !== x || before.y !== y)) {
      pushUndo(set, get, {
        label: `Moved ${before.name || 'token'}`,
        toast: false,
        sceneId: get().scene?.id ?? null,
        apply: () => get().socket?.emit('token:commit', { tokenId, x: before.x, y: before.y }),
      });
    }

    get().socket?.emit('token:commit', { tokenId, x, y });
  },

  updateToken(tokenId, fields) {
    get().socket?.emit('token:update', { tokenId, ...fields } as never);
  },

  deleteToken(tokenId) {
    const token = get().tokens.find((t) => t.id === tokenId);
    get().socket?.emit('token:delete', { tokenId });

    if (!token) return;

    // Deleting a Gargantuan dragon by a stray Del keypress should be a
    // recoverable mistake, not a re-entry job.
    pushUndo(set, get, {
      label: `Deleted ${token.name || 'token'}`,
      sceneId: get().scene?.id ?? null,
      apply: () => {
        const { socket, scene } = get();
        if (!socket || !scene) return;
        socket.emit('token:create', {
          sceneId: scene.id,
          name: token.name,
          imageUrl: token.imageUrl,
          actorId: token.actorId,
          actorLinked: token.actorLinked,
          ownerUserId: token.ownerUserId,
          x: token.x,
          y: token.y,
          w: token.w,
          h: token.h,
          rotation: token.rotation,
          layer: token.layer,
          disposition: token.disposition,
          visionRange: token.visionRange,
          darkvisionRange: token.darkvisionRange,
          lightBright: token.lightBright,
          lightDim: token.lightDim,
          hp: token.hp,
          maxHp: token.maxHp,
          ac: token.ac,
          conditions: token.conditions,
          hidden: token.hidden,
          locked: token.locked,
        } as never);
      },
    });
  },

  groupRoll(kind, key, dc, secret) {
    get().socket?.emit('chat:groupRoll', { kind, key, dc, secret });
  },

  rollDeathSave(tokenId) {
    get().socket?.emit('death:save', { tokenId });
  },

  showHandout(pageId) {
    get().socket?.emit('handout:show', { pageId });
  },

  dismissReveal() {
    set({ reveal: null });
  },

  undo() {
    const stack = get().undoStack;
    const entry = stack[stack.length - 1];
    if (!entry) {
      set({ toast: { message: 'Nothing to undo', undo: false } });
      setTimeout(() => set({ toast: null }), 2500);
      return;
    }

    set({ undoStack: stack.slice(0, -1), toast: null });
    entry.apply();
  },

  dismissToast() {
    set({ toast: null });
  },

  pingMap(x, y, points = []) {
    const { scene, activeActorId, socket } = get();
    // The actor is a claim, not a colour: the server checks it before deciding
    // what this is drawn in.
    if (scene) socket?.emit('ping:map', { sceneId: scene.id, x, y, points, actorId: activeActorId });
  },

  setWallTool(tool) {
    set({ wallTool: tool, selectedTokenId: null });
  },

  createWall(x1, y1, x2, y2, kind) {
    const sceneId = get().scene?.id;
    if (!sceneId) return;
    get().socket?.emit('wall:create', {
      sceneId, x1, y1, x2, y2,
      blocksMovement: 1, blocksSight: 1,
      door: kind === 'door' ? 1 : kind === 'secret' ? 2 : 0,
      doorState: 0,
    });
  },

  deleteWall(wallId) {
    get().socket?.emit('wall:delete', { wallId });
  },

  /**
   * The DM's own edits to a placed wall.
   *
   * `wall:update` has existed since walls did and had no caller at all, so a
   * door could never be locked and a secret door could never be revealed - both
   * were reachable only from a test.
   */
  updateWall(wallId, fields) {
    get().socket?.emit('wall:update', { wallId, ...fields });
  },

  toggleDoor(wallId) {
    get().socket?.emit('door:toggle', { wallId });
  },

  startEncounter() {
    get().socket?.emit('encounter:start', { sceneId: get().scene?.id ?? null });
  },

  endEncounter() {
    get().socket?.emit('encounter:end', {});
  },

  addToInitiative(tokenIds) {
    // Rolled on the server, like every other die.
    get().socket?.emit('initiative:add', { tokenIds, roll: true });
  },

  removeFromInitiative(entryId) {
    get().socket?.emit('initiative:remove', { entryId });
  },

  nextTurn() {
    get().socket?.emit('turn:next', {});
  },

  previousTurn() {
    get().socket?.emit('turn:previous', {});
  },

  placeTemplate(payload) {
    const sceneId = get().scene?.id;
    if (sceneId) get().socket?.emit('template:create', { sceneId, ...payload } as never);
  },

  clearTemplate(templateId) {
    get().socket?.emit('template:delete', { templateId });
  },

  // Pins go over REST but the server pushes a scene refresh, so every client
  // sees one appear without reloading.
  addDrawing(kind, points, color, text = '') {
    const sceneId = get().scene?.id;
    if (sceneId) get().socket?.emit('drawing:create', { sceneId, kind, points, color, text, width: 3 });
  },

  eraseDrawing(id) {
    get().socket?.emit('drawing:delete', { drawingId: id });
  },

  async placeNote(x, y) {
    const sceneId = get().scene?.id;
    if (!sceneId) return;
    await api.post(`/api/scenes/${sceneId}/notes`, { label: 'Note', x, y, hidden: true });
  },

  async toggleNote(noteId, hidden) {
    await api.patch(`/api/notes/${noteId}`, { hidden });
  },

  async removeNote(noteId) {
    await api.delete(`/api/notes/${noteId}`);
  },

  applyDamage(tokenIds, amount, damageType, healing = false, halved = false) {
    get().socket?.emit('damage:apply', { tokenIds, amount, damageType, healing, halved });
  },

  applyEffect(tokenIds, condition, rounds = null) {
    get().socket?.emit('effect:apply', { tokenIds, condition, rounds, itemId: null });
  },

  updateEffect(effectId, patch) {
    get().socket?.emit('effect:update', { effectId, ...patch });
  },

  removeEffect(effectId) {
    get().socket?.emit('effect:remove', { effectId });
  },

  setInitiative(encounterId, patch) {
    get().socket?.emit('initiative:update', { encounterId, ...patch });
  },

  clearChat() {
    get().socket?.emit('chat:clear', {});
  },

  queryMovement(tokenId) {
    get().socket?.emit('movement:query', { tokenId, threat: false });
  },

  toggleThreat() {
    const showThreat = !get().showThreat;
    setPref('board-threat', showThreat);
    set({ showThreat, threatRange: showThreat ? get().threatRange : [] });
    if (showThreat) get().socket?.emit('movement:query', { tokenId: null, threat: true });
  },

  cardAction(itemId, actorId, action, mode = 'normal', targetTokenId = null) {
    get().socket?.emit('chat:cardAction', { itemId, actorId, action, mode, targetTokenId });
  },
}));
