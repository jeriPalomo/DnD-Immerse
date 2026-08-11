import { create } from 'zustand';
import { api } from '../lib/api.js';
import type { ActorInput, ItemType, OwnershipLevel } from '@dnd/shared';

export type Actor = ActorInput & {
  id: string;
  ownerUserId: string;
  campaignId: string | null;
  portraitUrl: string | null;
  createdAt: number;
  updatedAt: number;
};

export interface Item {
  id: string;
  ownerActorId: string | null;
  type: ItemType;
  name: string;
  imageUrl: string | null;
  system: Record<string, any>;
  sortOrder: number;
}

export interface ActorSummary extends Partial<Actor> {
  id: string;
  name: string;
  access?: OwnershipLevel;
  campaigns?: { id: string; name: string }[];
}

interface SheetState {
  actor: Actor | null;
  items: Item[];
  campaigns: { id: string; name: string }[];
  access: OwnershipLevel;
  loading: boolean;
  saving: boolean;
  error: string | null;

  load: (id: string) => Promise<void>;
  clear: () => void;
  patch: (fields: Partial<ActorInput>) => void;
  flush: () => Promise<void>;

  addItem: (type: ItemType, name: string) => Promise<void>;
  addFromSrd: (kind: 'spell' | 'item', srdId: string) => Promise<void>;
  patchItem: (id: string, fields: { name?: string; system?: Record<string, unknown> }) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
}

/**
 * Sheet edits are optimistic and debounced: the field updates instantly and a
 * single PATCH follows once typing stops. Typing a backstory should not issue a
 * request per keystroke.
 */
const SAVE_DEBOUNCE_MS = 600;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Partial<ActorInput> = {};

export const useSheet = create<SheetState>((set, get) => ({
  actor: null,
  items: [],
  campaigns: [],
  access: 0,
  loading: false,
  saving: false,
  error: null,

  async load(id) {
    set({ loading: true, error: null });
    try {
      const res = await api.get<{
        actor: Actor;
        items: Item[];
        campaigns: { id: string; name: string }[];
        access: OwnershipLevel;
      }>(`/api/actors/${id}`);
      set({ ...res, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Could not load character' });
    }
  },

  clear() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pending = {};
    set({ actor: null, items: [], campaigns: [], access: 0, error: null });
  },

  patch(fields) {
    const actor = get().actor;
    if (!actor) return;

    set({ actor: { ...actor, ...fields } });
    pending = { ...pending, ...fields };

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().flush(), SAVE_DEBOUNCE_MS);
  },

  async flush() {
    const actor = get().actor;
    if (!actor || Object.keys(pending).length === 0) return;

    const body = pending;
    pending = {};
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;

    set({ saving: true });
    try {
      await api.patch(`/api/actors/${actor.id}`, body);
      set({ saving: false });
    } catch (err) {
      set({ saving: false, error: err instanceof Error ? err.message : 'Could not save' });
    }
  },

  async addItem(type, name) {
    const actor = get().actor;
    if (!actor) return;
    const { item } = await api.post<{ item: Item }>(`/api/actors/${actor.id}/items`, { type, name });
    set({ items: [...get().items, item] });
  },

  async addFromSrd(kind, srdId) {
    const actor = get().actor;
    if (!actor) return;
    const { item } = await api.post<{ item: Item }>(`/api/actors/${actor.id}/items/from-srd`, {
      kind,
      srdId,
    });
    set({ items: [...get().items, item] });
  },

  async patchItem(id, fields) {
    const previous = get().items;
    // Optimistic: toggling "prepared" on a spell should feel instant.
    set({
      items: previous.map((i) =>
        i.id === id
          ? { ...i, ...(fields.name ? { name: fields.name } : {}), system: { ...i.system, ...fields.system } }
          : i,
      ),
    });
    try {
      await api.patch(`/api/items/${id}`, fields);
    } catch {
      set({ items: previous });
    }
  },

  async removeItem(id) {
    const previous = get().items;
    set({ items: previous.filter((i) => i.id !== id) });
    try {
      await api.delete(`/api/items/${id}`);
    } catch {
      set({ items: previous });
    }
  },
}));
