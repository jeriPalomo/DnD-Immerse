import { create } from 'zustand';
import { api } from '../lib/api.js';

export interface Campaign {
  id: string;
  name: string;
  description: string;
  dmUserId: string;
  activeSceneId: string | null;
  /** Null for players - the invite code is a credential only the DM holds. */
  inviteCode: string | null;
  bannerUrl: string | null;
  /** What happened last session, in the DM's words. */
  recap?: string;
  createdAt: number;
  role: 'dm' | 'player';
  ruleset?: '2014' | '2024';
  /** Whether players may read stat blocks for creatures they do not control. */
  playersSeeEnemyStats?: boolean;
}

export interface Member {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'dm' | 'player';
  joinedAt: number;
  /** Who they are playing here. Characters only — never the DM's NPCs. */
  characters: { id: string; name: string; portraitUrl: string | null }[];
}

interface CampaignState {
  campaigns: Campaign[];
  loading: boolean;
  load: () => Promise<void>;
  create: (name: string, description: string) => Promise<Campaign>;
  join: (inviteCode: string) => Promise<Campaign>;
}

export const useCampaigns = create<CampaignState>((set, get) => ({
  campaigns: [],
  loading: false,

  async load() {
    set({ loading: true });
    try {
      const { campaigns } = await api.get<{ campaigns: Campaign[] }>('/api/campaigns');
      set({ campaigns, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  async create(name, description) {
    const { campaign } = await api.post<{ campaign: Campaign }>('/api/campaigns', {
      name,
      description,
    });
    set({ campaigns: [campaign, ...get().campaigns] });
    return campaign;
  },

  async join(inviteCode) {
    const { campaign } = await api.post<{ campaign: Campaign }>('/api/campaigns/join', {
      inviteCode,
    });
    const existing = get().campaigns.some((c) => c.id === campaign.id);
    if (!existing) set({ campaigns: [campaign, ...get().campaigns] });
    return campaign;
  },
}));
