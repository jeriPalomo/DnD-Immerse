import { create } from 'zustand';
import { api } from '../lib/api.js';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  /**
   * Whether this user runs any campaign. Decides only whether DM surfaces are
   * offered - every DM-only route still authorises itself against its own
   * campaign, so a client that lies about this gains nothing.
   */
  dmOfAny: boolean;
}

interface AuthState {
  user: AuthUser | null;
  /** Distinguishes "not logged in" from "haven't asked the server yet". */
  loading: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, displayName: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,

  async refresh() {
    try {
      const { user } = await api.get<{ user: AuthUser | null }>('/api/auth/me');
      set({ user, loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },

  async login(email, password) {
    const { user } = await api.post<{ user: AuthUser }>('/api/auth/login', { email, password });
    set({ user, loading: false });
  },

  async register(email, displayName, password) {
    const { user } = await api.post<{ user: AuthUser }>('/api/auth/register', {
      email,
      displayName,
      password,
    });
    set({ user, loading: false });
  },

  async logout() {
    await api.post('/api/auth/logout');
    set({ user: null });
  },
}));
