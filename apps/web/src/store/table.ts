import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { api } from '../lib/api.js';
import type {
  ClientToServerEvents,
  RollMode,
  ServerToClientEvents,
  WireChatMessage,
  WirePresence,
  WireAmbientSound,
  WireAudioState,
  WireDoor,
  WireDrawing,
  WireEncounter,
  WireMapNote,
  WirePlaylist,
  WireTemplate,
  WireScene,
  WireToken,
  WireVision,
  WireWall,
} from '@dnd/shared';

type TableSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

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
  wallTool: 'off' | 'wall' | 'door' | 'note' | 'draw' | 'arrow';
  encounter: WireEncounter | null;
  audio: WireAudioState | null;
  playlists: WirePlaylist[];
  sounds: WireAmbientSound[];
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
  selectedTokenId: string | null;
  /** The token a player has targeted, which drives the action panel. */
  targetTokenId: string | null;
  pings: { id: number; x: number; y: number; color: string }[];

  /** The character the player is speaking and rolling as. */
  activeActorId: string | null;
  setActiveActor: (actorId: string | null) => void;

  connect: (campaignId: string) => void;
  disconnect: () => void;

  send: (body: string, whisperToUserId?: string | null) => void;
  roll: (expression: string, label?: string, secret?: boolean) => void;
  postCard: (itemId: string, actorId: string) => void;
  select: (tokenId: string | null) => void;
  target: (tokenId: string | null) => void;

  activateScene: (sceneId: string) => void;
  createToken: (payload: Record<string, unknown>) => void;
  moveToken: (tokenId: string, x: number, y: number) => void;
  commitToken: (tokenId: string, x: number, y: number) => void;
  updateToken: (tokenId: string, fields: Record<string, unknown>) => void;
  deleteToken: (tokenId: string) => void;
  pingMap: (x: number, y: number) => void;
  setWallTool: (tool: 'off' | 'wall' | 'door' | 'note' | 'draw' | 'arrow') => void;
  addDrawing: (kind: 'freehand' | 'arrow' | 'text', points: number[], color: string, text?: string) => void;
  eraseDrawing: (id: string | 'mine' | 'all') => void;
  placeNote: (x: number, y: number) => Promise<void>;
  toggleNote: (noteId: string, hidden: boolean) => Promise<void>;
  removeNote: (noteId: string) => Promise<void>;
  createWall: (x1: number, y1: number, x2: number, y2: number, isDoor: boolean) => void;
  deleteWall: (wallId: string) => void;
  toggleDoor: (wallId: string) => void;

  startEncounter: () => void;
  endEncounter: () => void;
  addToInitiative: (tokenIds: string[]) => void;
  removeFromInitiative: (entryId: string) => void;
  nextTurn: () => void;
  previousTurn: () => void;
  playTrack: (playlistId: string, trackId: string | null, playing: boolean) => void;
  setMusicVolume: (volume: number) => void;
  placeTemplate: (payload: Record<string, unknown>) => void;
  clearTemplate: (templateId: string) => void;
  placeAmbient: (payload: Record<string, unknown>) => void;
  removeAmbient: (soundId: string) => void;
  groupRoll: (kind: 'skill' | 'save' | 'ability', key: string, dc: number | null, secret: boolean) => void;
  undo: () => void;
  dismissToast: () => void;
  applyDamage: (
    tokenIds: string[],
    amount: number,
    damageType: string,
    healing?: boolean,
    halved?: boolean,
  ) => void;
  cardAction: (
    itemId: string,
    actorId: string,
    action: 'attack' | 'damage' | 'critical' | 'save' | 'versatile',
    mode?: RollMode,
  ) => void;
}

const MAX_MESSAGES = 300;
const MAX_UNDO = 10;

export interface UndoEntry {
  label: string;
  apply: () => void;
  /** Whether to surface a toast; a move is self-evident, a delete is not. */
  toast?: boolean;
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
  encounter: null,
  lastDamage: null,
  undoStack: [],
  toast: null,
  audio: null,
  playlists: [],
  sounds: [],
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

    socket.on('scene:state', ({ scene, tokens, vision, doors, notes, drawings, walls }) =>
      // `walls` is absent for players, so it collapses to an empty array here.
      set({
        scene,
        tokens,
        vision: vision ?? null,
        doors: doors ?? [],
        notes: notes ?? [],
        drawings: drawings ?? [],
        walls: walls ?? [],
      }),
    );
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
    socket.on('initiative:state', ({ encounter }) => set({ encounter }));
    socket.on('audio:state', (audio) => set({ audio }));
    socket.on('audio:playlists', ({ playlists }) => set({ playlists }));
    socket.on('audio:sounds', ({ sounds }) => set({ sounds }));
    socket.on('template:state', ({ templates }) => set({ templates }));
    // Surfaced as a short-lived banner so the DM sees resistances being applied
    // without having to read the chat log mid-combat.
    socket.on('damage:applied', ({ results }) => {
      set({ lastDamage: results });
      setTimeout(() => {
        if (get().lastDamage === results) set({ lastDamage: null });
      }, 6000);
    });
    socket.on('wall:created', ({ wall }) => set({ walls: [...get().walls, wall] }));
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
    socket.on('ping:map', ({ x, y, color }) => {
      const ping = { id: Date.now() + Math.random(), x, y, color };
      set({ pings: [...get().pings, ping] });
      setTimeout(() => set({ pings: get().pings.filter((p) => p.id !== ping.id) }), 2500);
    });
    socket.on('error', ({ message }) => set({ error: message }));

    set({ socket, campaignId, messages: [], members: [], tokens: [], scene: null, encounter: null, sounds: [], templates: [], audio: null, notes: [], drawings: [] });
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

  postCard(itemId, actorId) {
    get().socket?.emit('chat:card', { itemId, actorId });
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

  pingMap(x, y) {
    const sceneId = get().scene?.id;
    if (sceneId) get().socket?.emit('ping:map', { sceneId, x, y });
  },

  setWallTool(tool) {
    set({ wallTool: tool, selectedTokenId: null });
  },

  createWall(x1, y1, x2, y2, isDoor) {
    const sceneId = get().scene?.id;
    if (!sceneId) return;
    get().socket?.emit('wall:create', {
      sceneId, x1, y1, x2, y2,
      blocksMovement: 1, blocksSight: 1, blocksSound: 0,
      door: isDoor ? 1 : 0, doorState: 0,
    });
  },

  deleteWall(wallId) {
    get().socket?.emit('wall:delete', { wallId });
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

  playTrack(playlistId, trackId, playing) {
    get().socket?.emit('audio:control', {
      playlistId,
      trackId,
      playing,
      loop: true,
      volume: get().audio?.volume ?? 0.6,
    });
  },

  setMusicVolume(volume) {
    const audio = get().audio;
    get().socket?.emit('audio:control', {
      playlistId: audio?.playlistId ?? null,
      trackId: audio?.trackId ?? null,
      playing: audio?.playing ?? false,
      loop: true,
      volume,
    });
  },

  placeTemplate(payload) {
    const sceneId = get().scene?.id;
    if (sceneId) get().socket?.emit('template:create', { sceneId, ...payload } as never);
  },

  clearTemplate(templateId) {
    get().socket?.emit('template:delete', { templateId });
  },

  placeAmbient(payload) {
    const sceneId = get().scene?.id;
    if (sceneId) get().socket?.emit('ambient:create', { sceneId, ...payload } as never);
  },

  removeAmbient(soundId) {
    get().socket?.emit('ambient:delete', { soundId });
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

  cardAction(itemId, actorId, action, mode = 'normal') {
    get().socket?.emit('chat:cardAction', { itemId, actorId, action, mode });
  },
}));
