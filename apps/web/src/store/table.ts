import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import type {
  ClientToServerEvents,
  RollMode,
  ServerToClientEvents,
  WireChatMessage,
  WirePresence,
  WireScene,
  WireToken,
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
  cardAction: (
    itemId: string,
    actorId: string,
    action: 'attack' | 'damage' | 'critical' | 'save' | 'versatile',
    mode?: RollMode,
  ) => void;
}

const MAX_MESSAGES = 300;

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

    socket.on('scene:state', ({ scene, tokens }) => set({ scene, tokens }));
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

    set({ socket, campaignId, messages: [], members: [], tokens: [], scene: null });
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
    get().socket?.emit('token:commit', { tokenId, x, y });
  },

  updateToken(tokenId, fields) {
    get().socket?.emit('token:update', { tokenId, ...fields } as never);
  },

  deleteToken(tokenId) {
    get().socket?.emit('token:delete', { tokenId });
  },

  pingMap(x, y) {
    const sceneId = get().scene?.id;
    if (sceneId) get().socket?.emit('ping:map', { sceneId, x, y });
  },

  cardAction(itemId, actorId, action, mode = 'normal') {
    get().socket?.emit('chat:cardAction', { itemId, actorId, action, mode });
  },
}));
