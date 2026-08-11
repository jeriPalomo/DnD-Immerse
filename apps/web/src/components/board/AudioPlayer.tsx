import { useEffect, useRef, useState } from 'react';
import {
  RESEEK_THRESHOLD_SECONDS,
  ambientVolumeForListener,
  effectiveVolume,
  nextTrackIndex,
  playbackDrift,
  playbackOffsetSeconds,
} from '@dnd/shared';
import { useTable } from '../../store/table.js';
import { useAuth } from '../../store/auth.js';

/**
 * Plays the campaign's music and any ambient sounds within earshot.
 *
 * Nothing is streamed from the server: it says which track started and when,
 * and this seeks its own copy to match. Positional volume is computed here too,
 * from the listener's own tokens — which is why the server never has to send a
 * different mix to every player.
 *
 * Browsers block autoplay until the user interacts, so the first click on the
 * enable button is what unlocks it.
 */
export function AudioPlayer({ isDM = false }: { isDM?: boolean }) {
  const { audio, sounds, tokens, scene, playlists, playTrack } = useTable();
  const { user } = useAuth();

  const [enabled, setEnabled] = useState(false);
  const [master, setMaster] = useState(0.7);

  const musicRef = useRef<HTMLAudioElement | null>(null);
  const ambientRefs = useRef(new Map<string, HTMLAudioElement>());
  // Extra elements used when a playlist is layered rather than sequential.
  const layerRefs = useRef(new Map<string, HTMLAudioElement>());
  const fadeRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activePlaylist = playlists.find((list) => list.id === audio?.playlistId) ?? null;
  const layered = activePlaylist?.mode === 'simultaneous';

  /* --------------------------------------------------------------- music */

  useEffect(() => {
    const element = musicRef.current;
    if (!element || !enabled) return;

    if (!audio?.playing || !audio.trackUrl) {
      element.pause();
      return;
    }

    if (layered) {
      // A simultaneous playlist layers every track at once - rain over wind
      // over a distant bell - so the single-track element stays silent.
      element.pause();
      return;
    }

    if (!element.src.endsWith(audio.trackUrl)) {
      // Fade the outgoing track rather than cutting it dead.
      const fadeMs = activePlaylist?.fadeMs ?? 0;
      if (fadeMs > 0 && element.src && !element.paused) crossfade(element, audio.trackUrl, fadeMs);
      else element.src = audio.trackUrl;
    }
    element.loop = audio.loop;

    const expected = playbackOffsetSeconds(audio, Date.now(), element.duration || undefined);
    if (expected !== null) {
      // Only re-seek past the threshold: correcting small drift causes an
      // audible click that is worse than the drift itself.
      if (playbackDrift(element.currentTime, expected) > RESEEK_THRESHOLD_SECONDS) {
        element.currentTime = expected;
      }
      void element.play().catch(() => undefined);
    }
  }, [audio, enabled]);

  useEffect(() => {
    const element = musicRef.current;
    if (element) element.volume = effectiveVolume(audio?.volume ?? 0.6, master);
  }, [audio?.volume, master]);

  /**
   * Advances the playlist when a track ends.
   *
   * Only the DM's client does this - every browser firing the same event would
   * skip several tracks at once.
   */
  useEffect(() => {
    const element = musicRef.current;
    if (!element || !isDM || !audio?.playlistId || layered) return;

    const onEnded = () => {
      const playlist = playlists.find((list) => list.id === audio.playlistId);
      if (!playlist || playlist.tracks.length === 0) return;

      const current = playlist.tracks.findIndex((track) => track.id === audio.trackId);
      const next = nextTrackIndex(Math.max(0, current), playlist.tracks.length, playlist.mode);
      if (next !== null) playTrack(playlist.id, playlist.tracks[next].id, true);
    };

    element.addEventListener('ended', onEnded);
    return () => element.removeEventListener('ended', onEnded);
  }, [audio, playlists, isDM, playTrack, layered]);

  /**
   * Fades the current track out, swaps the source, and fades back in.
   *
   * Cheaper and steadier than two overlapping elements, and a hard cut between
   * ambient beds is the most noticeable thing a soundboard can do wrong.
   */
  function crossfade(element: HTMLAudioElement, nextSrc: string, fadeMs: number) {
    if (fadeRef.current) clearInterval(fadeRef.current);

    const target = element.volume;
    const steps = Math.max(4, Math.round(fadeMs / 50));
    let step = 0;
    let swapped = false;

    fadeRef.current = setInterval(() => {
      step++;
      const half = steps / 2;

      if (step <= half) {
        element.volume = target * (1 - step / half);
      } else {
        if (!swapped) {
          element.src = nextSrc;
          void element.play().catch(() => undefined);
          swapped = true;
        }
        element.volume = target * ((step - half) / half);
      }

      if (step >= steps) {
        element.volume = target;
        if (fadeRef.current) clearInterval(fadeRef.current);
        fadeRef.current = null;
      }
    }, 50);
  }

  /** Layered playback: every track in the playlist plays together. */
  useEffect(() => {
    if (!enabled || !layered || !audio?.playing || !activePlaylist) {
      for (const element of layerRefs.current.values()) element.pause();
      return;
    }

    const wanted = new Set(activePlaylist.tracks.map((track) => track.id));
    for (const [id, element] of layerRefs.current) {
      if (!wanted.has(id)) {
        element.pause();
        layerRefs.current.delete(id);
      }
    }

    for (const track of activePlaylist.tracks) {
      let element = layerRefs.current.get(track.id);
      if (!element) {
        element = new Audio(track.fileUrl);
        element.loop = true;
        layerRefs.current.set(track.id, element);
      }
      element.volume = effectiveVolume(track.volume * (audio.volume ?? 0.6), master);
      void element.play().catch(() => undefined);
    }
  }, [layered, activePlaylist, audio, enabled, master]);

  /* ------------------------------------------------------------- ambient */

  // The listener's own tokens are the ears; a DM with none hears everything at
  // full volume so they can audition what they placed.
  const myTokens = tokens.filter((token) => token.ownerUserId === user?.id);

  useEffect(() => {
    if (!enabled) {
      for (const element of ambientRefs.current.values()) element.pause();
      return;
    }

    const live = new Set(sounds.map((sound) => sound.id));

    for (const [id, element] of ambientRefs.current) {
      if (!live.has(id)) {
        element.pause();
        ambientRefs.current.delete(id);
      }
    }

    for (const sound of sounds) {
      let element = ambientRefs.current.get(sound.id);
      if (!element) {
        element = new Audio(sound.fileUrl);
        element.loop = true;
        ambientRefs.current.set(sound.id, element);
      }

      const proximity =
        myTokens.length > 0 ? ambientVolumeForListener(sound, myTokens) : sound.volume;
      const volume = effectiveVolume(proximity, master);

      element.volume = volume;
      if (volume > 0.001) void element.play().catch(() => undefined);
      else element.pause();
    }
  }, [sounds, myTokens, master, enabled]);

  // Stop everything on unmount, or leaving the table keeps playing.
  useEffect(() => {
    const elements = ambientRefs.current;
    const layers = layerRefs.current;
    return () => {
      for (const element of [...elements.values(), ...layers.values()]) element.pause();
      elements.clear();
      layers.clear();
      if (fadeRef.current) clearInterval(fadeRef.current);
    };
  }, []);

  const audible = sounds.filter(
    (sound) => myTokens.length === 0 || ambientVolumeForListener(sound, myTokens) > 0.001,
  );

  // Always rendered at the table. Browsers require a user gesture before any
  // sound plays, so a player must be able to grant it BEFORE the DM starts a
  // track - hiding the control until something is playing means the first
  // track is always missed.
  void scene;

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 p-3">
      <audio ref={musicRef} preload="none" />

      <div className="flex items-center gap-2">
        {!enabled ? (
          <button
            onClick={() => setEnabled(true)}
            className="flex-1 rounded border border-ember-500 bg-ember-500/15 px-2 py-1.5 text-xs text-ember-300 hover:bg-ember-500/25"
            // Browsers refuse to autoplay until the page has been interacted with.
            title="Browsers block sound until you allow it"
          >
            Enable sound
          </button>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-ink-300">
              {audio?.playing && audio.trackName ? (
                <>
                  <span className="text-ember-400">♪</span> {audio.trackName}
                </>
              ) : (
                <span className="text-ink-600">Nothing playing</span>
              )}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={master}
              aria-label="Master volume"
              onChange={(e) => setMaster(Number(e.target.value))}
              className="w-20 accent-ember-500"
            />
          </>
        )}
      </div>

      {enabled && audible.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {audible.map((sound) => (
            <span
              key={sound.id}
              className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-400"
              title={`Audible within ${sound.radius} squares`}
            >
              {sound.name || 'ambience'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
