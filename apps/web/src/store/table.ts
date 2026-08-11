import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import type {
  ClientToServerEvents,
  RollMode,
  ServerToClientEvents,
  WireChatMessage,
  WirePresence,
} from '@dnd/shared';

type TableSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface TableState {
  socket: TableSocket | null;
  campaignId: string | null;
  connected: boolean;
  messages: WireChatMessage[];
  members: WirePresence[];
  error: string | null;

  /** The character the player is speaking and rolling as. */
  activeActorId: string | null;
  setActiveActor: (actorId: string | null) => void;

  connect: (campaignId: string) => void;
  disconnect: () => void;

  send: (body: string, whisperToUserId?: string | null) => void;
  roll: (expression: string, label?: string, secret?: boolean) => void;
  postCard: (itemId: string, actorId: string) => void;
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
    socket.on('error', ({ message }) => set({ error: message }));

    set({ socket, campaignId, messages: [], members: [] });
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

  cardAction(itemId, actorId, action, mode = 'normal') {
    get().socket?.emit('chat:cardAction', { itemId, actorId, action, mode });
  },
}));
