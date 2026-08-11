import { tokenDistance, type TokenRect } from './grid.js';

/**
 * Audio synchronisation and positional falloff.
 *
 * Playback is synced by timestamp rather than streamed: the server says which
 * track started and when, and each client works out its own seek position and
 * plays the file over HTTP. That keeps the server out of the audio path
 * entirely and means one person's buffering never stutters anyone else.
 */

export type PlaylistMode = 'sequential' | 'shuffle' | 'simultaneous';

export interface PlaybackState {
  trackId: string | null;
  playing: boolean;
  /** Server epoch ms when playback started. */
  startedAt: number | null;
  volume: number;
}

/**
 * Where in the track a client should be right now, in seconds.
 *
 * Returns null when nothing should be playing. When the track length is known
 * and it loops, the offset wraps — so a player joining twenty minutes into a
 * three-minute loop lands in the right place rather than past the end.
 */
export function playbackOffsetSeconds(
  state: PlaybackState,
  now: number,
  durationSeconds?: number,
): number | null {
  if (!state.playing || state.startedAt === null) return null;

  const elapsed = Math.max(0, (now - state.startedAt) / 1000);
  if (!durationSeconds || durationSeconds <= 0) return elapsed;

  return elapsed % durationSeconds;
}

/**
 * How far out of sync a client is, in seconds.
 *
 * Small drift is inaudible and correcting it causes a click, so callers should
 * only re-seek past a threshold.
 */
export function playbackDrift(currentTime: number, expected: number): number {
  return Math.abs(currentTime - expected);
}

/** Re-seeking below this is more disruptive than the drift it fixes. */
export const RESEEK_THRESHOLD_SECONDS = 1.5;

/* ------------------------------------------------------- positional audio */

export interface AmbientSource {
  x: number;
  y: number;
  /** Audible radius in grid units. */
  radius: number;
  /** The source's own volume, 0..1. */
  volume: number;
  /** Smooth falloff rather than a hard edge at the radius. */
  easing: boolean;
}

/**
 * Volume for an ambient source, given how far the listener is from it.
 *
 * Falls to silence at the radius so walking away from a fountain fades it out
 * rather than cutting it. Computed on the client from its own tokens, which is
 * why the server never needs to send per-listener volumes.
 */
export function ambientVolume(source: AmbientSource, distanceInSquares: number): number {
  if (source.radius <= 0) return 0;
  if (distanceInSquares >= source.radius) return 0;
  if (!source.easing) return source.volume;

  // Inverse-square-ish rolloff, which sounds more natural than linear.
  const proximity = 1 - distanceInSquares / source.radius;
  return source.volume * proximity * proximity;
}

/**
 * The loudest this source is for any token the listener controls.
 *
 * A party spread across a map hears each sound at the volume of whoever is
 * closest to it, which is what makes moving around the map feel audible.
 */
export function ambientVolumeForListener(
  source: AmbientSource,
  listenerTokens: TokenRect[],
): number {
  if (listenerTokens.length === 0) return 0;

  let loudest = 0;
  for (const token of listenerTokens) {
    const distance = tokenDistance(token, {
      x: source.x,
      y: source.y,
      w: 1,
      h: 1,
    });
    loudest = Math.max(loudest, ambientVolume(source, distance));
  }

  return loudest;
}

/** Picks the next track, honouring the playlist's mode. */
export function nextTrackIndex(
  currentIndex: number,
  count: number,
  mode: PlaylistMode,
): number | null {
  if (count <= 0) return null;
  if (mode === 'shuffle') {
    if (count === 1) return 0;
    // Never repeat immediately; hearing the same track twice reads as a bug.
    let next = currentIndex;
    while (next === currentIndex) next = Math.floor(Math.random() * count);
    return next;
  }

  const next = currentIndex + 1;
  return next >= count ? 0 : next;
}

/** Applies the listener's own master volume on top of a source's. */
export function effectiveVolume(sourceVolume: number, masterVolume: number): number {
  return Math.max(0, Math.min(1, sourceVolume * masterVolume));
}
