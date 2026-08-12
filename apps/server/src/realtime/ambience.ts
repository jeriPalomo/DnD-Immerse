import { and, asc, eq } from 'drizzle-orm';
import {
  ambientCreateSchema,
  audioControlSchema,
  campaignRoom,
  soundOcclusion,
  templateCreateSchema,
  tokenCenter,
} from '@dnd/shared';
import type { Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  WireAmbientSound,
  WireAudioState,
  WirePlaylist,
  WireTemplate,
} from '@dnd/shared';
import { db } from '../db/index.js';
import {
  ambientSounds,
  audioState,
  campaigns,
  playlistTracks,
  playlists,
  scenes,
  templates,
  tokens,
  walls,
} from '../db/schema.js';
import { getMembership } from '../auth/guards.js';
import { newId } from '../lib/id.js';
import type { IOServer, SocketData } from './index.js';

type AmbienceSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/**
 * Ambient audio and area-of-effect templates.
 *
 * Playback is synchronised by timestamp, not streamed: the server records which
 * track started and when, and each client seeks its own copy. That keeps audio
 * entirely out of the server's bandwidth and means one person buffering never
 * stutters anyone else.
 */

/* ----------------------------------------------------------------- audio */

export async function playlistsOf(campaignId: string): Promise<WirePlaylist[]> {
  const lists = await db
    .select()
    .from(playlists)
    .where(eq(playlists.campaignId, campaignId))
    .orderBy(asc(playlists.createdAt));

  if (lists.length === 0) return [];

  const tracks = await db
    .select()
    .from(playlistTracks)
    .orderBy(asc(playlistTracks.sortOrder), asc(playlistTracks.name));

  return lists.map((list) => ({
    id: list.id,
    name: list.name,
    mode: list.mode,
    role: list.role,
    fadeMs: list.fadeMs,
    tracks: tracks
      .filter((track) => track.playlistId === list.id)
      .map((track) => ({
        id: track.id,
        playlistId: track.playlistId,
        name: track.name,
        fileUrl: track.fileUrl,
        volume: track.volume,
        loop: track.loop,
        sortOrder: track.sortOrder,
      })),
  }));
}

async function currentAudio(campaignId: string): Promise<WireAudioState> {
  const rows = await db
    .select()
    .from(audioState)
    .where(eq(audioState.campaignId, campaignId))
    .limit(1);

  const state = rows[0];
  if (!state?.trackId) {
    return {
      playlistId: state?.playlistId ?? null,
      trackId: null,
      trackUrl: null,
      trackName: null,
      playing: false,
      loop: true,
      startedAt: null,
      volume: state?.volume ?? 0.6,
    };
  }

  const found = await db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.id, state.trackId))
    .limit(1);
  const track = found[0];

  return {
    playlistId: state.playlistId,
    trackId: state.trackId,
    trackUrl: track?.fileUrl ?? null,
    trackName: track?.name ?? null,
    playing: state.playing,
    loop: track?.loop ?? true,
    startedAt: state.startedAt,
    volume: state.volume,
  };
}

export async function broadcastAudio(io: IOServer, campaignId: string): Promise<void> {
  const state = await currentAudio(campaignId);
  io.to(campaignRoom(campaignId)).emit('audio:state', state);
}

export async function broadcastPlaylists(io: IOServer, campaignId: string): Promise<void> {
  io.to(campaignRoom(campaignId)).emit('audio:playlists', {
    playlists: await playlistsOf(campaignId),
  });
}

/* ----------------------------------------------------- scene-scoped state */

async function activeSceneId(campaignId: string): Promise<string | null> {
  const rows = await db
    .select({ activeSceneId: campaigns.activeSceneId })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId))
    .limit(1);
  return rows[0]?.activeSceneId ?? null;
}

/**
 * Ambient sounds for the active scene.
 *
 * Hidden emitters are filtered out for players, on the same principle as
 * hidden tokens: a sound the DM has not revealed should not be inferable from
 * the payload.
 */
export async function broadcastSounds(io: IOServer, campaignId: string): Promise<void> {
  const sceneId = await activeSceneId(campaignId);
  if (!sceneId) {
    io.to(campaignRoom(campaignId)).emit('audio:sounds', { sounds: [] });
    return;
  }

  const rows = await db.select().from(ambientSounds).where(eq(ambientSounds.sceneId, sceneId));
  if (rows.length === 0) {
    io.to(campaignRoom(campaignId)).emit('audio:sounds', { sounds: [] });
    return;
  }

  const [sceneWalls, sceneTokens] = await Promise.all([
    db.select().from(walls).where(eq(walls.sceneId, sceneId)),
    db.select().from(tokens).where(eq(tokens.sceneId, sceneId)),
  ]);

  for (const socket of await io.in(campaignRoom(campaignId)).fetchSockets()) {
    const isDM = socket.data.rooms.get(campaignId) === 'dm';
    const userId = socket.data.user.id;

    // The listener's own tokens are the ears. A DM without tokens auditions
    // everything unmuffled so they can hear what they placed.
    const ears = sceneTokens
      .filter((token) => token.ownerUserId === userId)
      .map((token) => tokenCenter(token));

    const visible = isDM ? rows : rows.filter((sound) => !sound.hidden);

    socket.emit('audio:sounds', {
      sounds: visible.map((sound) => ({
        id: sound.id,
        sceneId: sound.sceneId,
        name: sound.name,
        fileUrl: sound.fileUrl,
        x: sound.x,
        y: sound.y,
        radius: sound.radius,
        volume: sound.volume,
        easing: sound.easing,
        occlusion:
          sound.blockedByWalls && ears.length > 0
            ? // Loudest path wins: if any of your tokens has a clear line to
              // the source, you hear it clearly.
              Math.max(
                ...ears.map((ear) => soundOcclusion({ x: sound.x, y: sound.y }, ear, sceneWalls)),
              )
            : 1,
      })),
    });
  }
}

export async function broadcastTemplates(io: IOServer, campaignId: string): Promise<void> {
  const sceneId = await activeSceneId(campaignId);
  if (!sceneId) {
    io.to(campaignRoom(campaignId)).emit('template:state', { templates: [] });
    return;
  }

  const rows = await db.select().from(templates).where(eq(templates.sceneId, sceneId));

  const wire: WireTemplate[] = rows.map((template) => ({
    id: template.id,
    sceneId: template.sceneId,
    ownerUserId: template.ownerUserId,
    shape: template.shape,
    x: template.x,
    y: template.y,
    direction: template.direction,
    distance: template.distance,
    width: template.width,
    color: template.color,
  }));

  io.to(campaignRoom(campaignId)).emit('template:state', { templates: wire });
}

/* -------------------------------------------------------------- handlers */

export function registerAmbienceHandlers(io: IOServer, socket: AmbienceSocket): void {
  const user = socket.data.user;

  async function context(): Promise<{ campaignId: string; isDM: boolean } | null> {
    const [campaignId] = socket.data.rooms.keys();
    if (!campaignId) return null;

    const membership = await getMembership(campaignId, user.id);
    if (!membership) {
      socket.emit('error', { message: 'You are not in that campaign', code: 'NOT_A_MEMBER' });
      return null;
    }
    return { campaignId, isDM: membership.isDM };
  }

  socket.on('audio:control', async (payload) => {
    const ctx = await context();
    if (!ctx) return;
    if (!ctx.isDM) {
      socket.emit('error', { message: 'Only the DM controls the music' });
      return;
    }

    const input = audioControlSchema.parse(payload);

    // startedAt is the sync point every client seeks against, so it is stamped
    // here rather than taken from whichever browser pressed play.
    const startedAt = input.playing ? Date.now() : null;

    await db
      .insert(audioState)
      .values({
        campaignId: ctx.campaignId,
        playlistId: input.playlistId,
        trackId: input.trackId,
        playing: input.playing,
        startedAt,
        volume: input.volume ?? 0.6,
      })
      .onConflictDoUpdate({
        target: audioState.campaignId,
        set: {
          playlistId: input.playlistId,
          trackId: input.trackId,
          playing: input.playing,
          startedAt,
          ...(input.volume !== undefined ? { volume: input.volume } : {}),
        },
      });

    await broadcastAudio(io, ctx.campaignId);
  });

  /** Shows a journal image large on every screen for a moment. */
  socket.on('handout:show', async ({ pageId }) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can show a handout' });
      return;
    }

    const { journalEntries, journalPages } = await import('../db/schema.js');
    const rows = await db
      .select({ page: journalPages, entry: journalEntries })
      .from(journalPages)
      .innerJoin(journalEntries, eq(journalPages.entryId, journalEntries.id))
      .where(eq(journalPages.id, pageId))
      .limit(1);

    const found = rows[0];
    if (!found?.page.fileUrl || found.entry.campaignId !== ctx.campaignId) return;

    io.to(campaignRoom(ctx.campaignId)).emit('handout:reveal', {
      imageUrl: found.page.fileUrl,
      title: found.page.title,
    });
  });

  socket.on('ambient:create', async (payload) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) {
      socket.emit('error', { message: 'Only the DM can place sounds' });
      return;
    }

    const input = ambientCreateSchema.parse(payload);
    const scene = await db.select().from(scenes).where(eq(scenes.id, input.sceneId)).limit(1);
    if (scene[0]?.campaignId !== ctx.campaignId) return;

    await db.insert(ambientSounds).values({
      id: newId(),
      sceneId: input.sceneId,
      name: input.name,
      fileUrl: input.fileUrl,
      x: input.x,
      y: input.y,
      radius: input.radius,
      volume: input.volume,
      blockedByWalls: input.blockedByWalls,
      easing: input.easing,
      hidden: false,
    });

    await broadcastSounds(io, ctx.campaignId);
  });

  socket.on('ambient:delete', async ({ soundId }) => {
    const ctx = await context();
    if (!ctx || !ctx.isDM) return;

    await db.delete(ambientSounds).where(eq(ambientSounds.id, soundId));
    await broadcastSounds(io, ctx.campaignId);
  });

  /** Templates are placed by players too — aiming a fireball is their job. */
  socket.on('template:create', async (payload) => {
    const ctx = await context();
    if (!ctx) return;

    const input = templateCreateSchema.parse(payload);
    const scene = await db.select().from(scenes).where(eq(scenes.id, input.sceneId)).limit(1);
    if (scene[0]?.campaignId !== ctx.campaignId) return;

    await db.insert(templates).values({
      id: newId(),
      sceneId: input.sceneId,
      ownerUserId: user.id,
      shape: input.shape,
      x: input.x,
      y: input.y,
      direction: input.direction,
      distance: input.distance,
      width: input.width,
      color: input.color,
    });

    await broadcastTemplates(io, ctx.campaignId);
  });

  socket.on('template:delete', async ({ templateId }) => {
    const ctx = await context();
    if (!ctx) return;

    const rows = await db.select().from(templates).where(eq(templates.id, templateId)).limit(1);
    const template = rows[0];
    if (!template) return;

    // You may clear your own template; the DM may clear anyone's.
    if (!ctx.isDM && template.ownerUserId !== user.id) {
      socket.emit('error', { message: 'That is not your template' });
      return;
    }

    await db.delete(templates).where(eq(templates.id, templateId));
    await broadcastTemplates(io, ctx.campaignId);
  });
}

/**
 * Switches to the combat playlist when a fight starts, and back when it ends.
 *
 * The DM is busiest exactly when the music should change, so this happens on
 * its own. What was playing is stored rather than held in memory, so a server
 * restart mid-combat does not lose the way back.
 */
export async function setCombatMusic(
  io: IOServer,
  campaignId: string,
  inCombat: boolean,
): Promise<void> {
  const rows = await db
    .select()
    .from(audioState)
    .where(eq(audioState.campaignId, campaignId))
    .limit(1);
  const current = rows[0];

  if (inCombat) {
    const combat = await db
      .select()
      .from(playlists)
      .where(and(eq(playlists.campaignId, campaignId), eq(playlists.role, 'combat')))
      .limit(1);
    if (!combat[0]) return;

    const tracks = await db
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, combat[0].id))
      .orderBy(asc(playlistTracks.sortOrder));
    if (tracks.length === 0) return;

    // Already playing combat music; leave it be rather than restarting it.
    if (current?.playlistId === combat[0].id && current.playing) return;

    await db
      .insert(audioState)
      .values({
        campaignId,
        playlistId: combat[0].id,
        trackId: tracks[0].id,
        playing: true,
        startedAt: Date.now(),
        volume: current?.volume ?? 0.6,
        resumePlaylistId: current?.playing ? current.playlistId : null,
        resumeTrackId: current?.playing ? current.trackId : null,
      })
      .onConflictDoUpdate({
        target: audioState.campaignId,
        set: {
          playlistId: combat[0].id,
          trackId: tracks[0].id,
          playing: true,
          startedAt: Date.now(),
          resumePlaylistId: current?.playing ? current.playlistId : null,
          resumeTrackId: current?.playing ? current.trackId : null,
        },
      });

    await broadcastAudio(io, campaignId);
    return;
  }

  if (!current) return;

  // Nothing to go back to: stop rather than leaving battle music over a tavern.
  const resuming = Boolean(current.resumeTrackId);
  await db
    .update(audioState)
    .set({
      playlistId: current.resumePlaylistId,
      trackId: current.resumeTrackId,
      playing: resuming,
      startedAt: resuming ? Date.now() : null,
      resumePlaylistId: null,
      resumeTrackId: null,
    })
    .where(eq(audioState.campaignId, campaignId));

  await broadcastAudio(io, campaignId);
}
