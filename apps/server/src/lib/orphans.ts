import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  actors,
  ambientSounds,
  campaigns,
  journalPages,
  playlistTracks,
  scenes,
  tokens,
  users,
} from '../db/schema.js';
import { deleteUpload } from './uploads.js';

/**
 * Removes uploaded files that nothing points at any more.
 *
 * Deleting rows cascades; the files on disk do not, so a deleted campaign used
 * to orphan its banner, every map, every token image, every audio track and
 * every handout permanently.
 *
 * Each URL is re-checked against every table that can hold one before it is
 * removed, because several are shared on purpose: placing an ambient sound
 * copies a track's URL, and a token stamped from an actor reuses its portrait.
 * Deleting a file that something still references would turn a disk-space bug
 * into a broken-image bug, which is worse.
 */
const FILE_COLUMNS = [
  { table: campaigns, column: campaigns.bannerUrl },
  { table: users, column: users.avatarUrl },
  { table: actors, column: actors.portraitUrl },
  { table: tokens, column: tokens.imageUrl },
  { table: scenes, column: scenes.mapImageUrl },
  { table: playlistTracks, column: playlistTracks.fileUrl },
  { table: ambientSounds, column: ambientSounds.fileUrl },
  { table: journalPages, column: journalPages.fileUrl },
] as const;

async function stillReferenced(url: string): Promise<boolean> {
  for (const { table, column } of FILE_COLUMNS) {
    const rows = await db
      .select({ hit: column })
      .from(table as never)
      .where(eq(column as never, url))
      .limit(1);
    if (rows.length > 0) return true;
  }
  return false;
}

/** Call after the owning rows are gone, so the check sees the final state. */
export async function deleteOrphanedUploads(urls: (string | null | undefined)[]): Promise<number> {
  const unique = [...new Set(urls.filter((url): url is string => Boolean(url)))];

  let removed = 0;
  for (const url of unique) {
    if (await stillReferenced(url)) continue;
    await deleteUpload(url);
    removed++;
  }

  return removed;
}

/** Every file a scene owns: its map, and the art on its tokens. */
export async function sceneFileUrls(sceneId: string): Promise<string[]> {
  const [scene, sceneTokens] = await Promise.all([
    db.select({ url: scenes.mapImageUrl }).from(scenes).where(eq(scenes.id, sceneId)),
    db.select({ url: tokens.imageUrl }).from(tokens).where(eq(tokens.sceneId, sceneId)),
  ]);

  return [...scene, ...sceneTokens]
    .map((row) => row.url)
    .filter((url): url is string => Boolean(url));
}

/** Every file a campaign owns, across all of its scenes and collections. */
export async function campaignFileUrls(campaignId: string): Promise<string[]> {
  const urls: string[] = [];

  const campaign = await db
    .select({ url: campaigns.bannerUrl })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  urls.push(...campaign.map((row) => row.url).filter((url): url is string => Boolean(url)));

  const owned = await db.select({ id: scenes.id }).from(scenes).where(eq(scenes.campaignId, campaignId));
  for (const scene of owned) urls.push(...(await sceneFileUrls(scene.id)));

  const { playlists, journalEntries } = await import('../db/schema.js');

  const lists = await db
    .select({ id: playlists.id })
    .from(playlists)
    .where(eq(playlists.campaignId, campaignId));
  for (const list of lists) {
    const tracks = await db
      .select({ url: playlistTracks.fileUrl })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, list.id));
    urls.push(...tracks.map((row) => row.url));
  }

  const entries = await db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(eq(journalEntries.campaignId, campaignId));
  for (const entry of entries) {
    const pages = await db
      .select({ url: journalPages.fileUrl })
      .from(journalPages)
      .where(eq(journalPages.entryId, entry.id));
    urls.push(...pages.map((row) => row.url).filter((url): url is string => Boolean(url)));
  }

  // Actors authored inside this campaign; portable player characters are not
  // owned by it and keep their portraits.
  const npcs = await db
    .select({ url: actors.portraitUrl })
    .from(actors)
    .where(eq(actors.campaignId, campaignId));
  urls.push(...npcs.map((row) => row.url).filter((url): url is string => Boolean(url)));

  return urls;
}
