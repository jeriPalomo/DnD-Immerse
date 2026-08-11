import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui.js';
import { api } from '../../lib/api.js';
import { useTable } from '../../store/table.js';

interface Track {
  id: string;
  name: string;
  fileUrl: string;
  volume: number;
  loop: boolean;
}

interface Playlist {
  id: string;
  name: string;
  mode: 'sequential' | 'shuffle' | 'simultaneous';
  tracks: Track[];
}

/**
 * The DM's soundboard: upload tracks, hit play, and drop ambient emitters onto
 * the map. Everyone hears the same track at the same offset, because playback
 * is synced by timestamp rather than streamed.
 */
export function Soundboard({ campaignId }: { campaignId: string }) {
  const { audio, playTrack, setMusicVolume, sounds, removeAmbient, placeAmbient, selectedTokenId, tokens } =
    useTable();

  const [lists, setLists] = useState<Playlist[]>([]);
  const [busy, setBusy] = useState(false);
  const [ambientRadius, setAmbientRadius] = useState(8);

  const load = useCallback(async () => {
    const res = await api.get<{ playlists: Playlist[] }>(`/api/campaigns/${campaignId}/playlists`);
    setLists(res.playlists);
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createPlaylist() {
    setBusy(true);
    try {
      await api.post(`/api/campaigns/${campaignId}/playlists`, { name: `Playlist ${lists.length + 1}` });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function uploadTrack(playlistId: string, file: File) {
    setBusy(true);
    try {
      await api.upload(`/api/playlists/${playlistId}/tracks`, file);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeTrack(trackId: string) {
    await api.delete(`/api/tracks/${trackId}`);
    await load();
  }

  const selected = tokens.find((t) => t.id === selectedTokenId) ?? null;

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-display text-sm text-ink-100">Sound</h2>
        {audio?.playing && (
          <button
            onClick={() => playTrack(audio.playlistId ?? '', null, false)}
            className="rounded border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 hover:border-ember-500"
          >
            Stop
          </button>
        )}
      </div>

      <label className="mb-3 block">
        <div className="mb-1 flex justify-between text-[10px] text-ink-500">
          <span>Music volume</span>
          <span className="font-mono">{Math.round((audio?.volume ?? 0.6) * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={audio?.volume ?? 0.6}
          aria-label="Campaign music volume"
          onChange={(e) => setMusicVolume(Number(e.target.value))}
          className="w-full accent-ember-500"
        />
      </label>

      <div className="space-y-2">
        {lists.map((playlist) => (
          <div key={playlist.id} className="rounded-lg border border-ink-800 p-2">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="truncate text-xs text-ink-200">{playlist.name}</span>
              <label className="shrink-0 cursor-pointer text-[10px] text-arcane-400 hover:underline">
                + track
                <input
                  type="file"
                  accept="audio/*"
                  className="sr-only"
                  aria-label={`Add track to ${playlist.name}`}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadTrack(playlist.id, file);
                  }}
                />
              </label>
            </div>

            {playlist.tracks.length === 0 ? (
              <p className="text-[10px] text-ink-600">No tracks yet. MP3, OGG or WAV.</p>
            ) : (
              <ul className="space-y-0.5">
                {playlist.tracks.map((track) => {
                  const isPlaying = audio?.trackId === track.id && audio.playing;
                  return (
                    <li key={track.id} className="flex items-center gap-1.5">
                      <button
                        onClick={() => playTrack(playlist.id, track.id, !isPlaying)}
                        className={`min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left text-[11px] transition-colors ${
                          isPlaying
                            ? 'bg-ember-500/20 text-ember-300'
                            : 'text-ink-300 hover:bg-ink-800'
                        }`}
                      >
                        {isPlaying ? '▪ ' : '▸ '}
                        {track.name}
                      </button>

                      {/* Drop this track onto the map at the selected token. */}
                      <button
                        disabled={!selected}
                        onClick={() =>
                          selected &&
                          placeAmbient({
                            name: track.name,
                            fileUrl: track.fileUrl,
                            x: selected.x,
                            y: selected.y,
                            radius: ambientRadius,
                            volume: track.volume,
                            easing: true,
                          })
                        }
                        title={
                          selected
                            ? `Place as ambience at ${selected.name || 'the selected token'}`
                            : 'Select a token to place ambience there'
                        }
                        className="shrink-0 rounded border border-ink-700 px-1 text-[10px] text-ink-500 hover:border-arcane-400 hover:text-arcane-400 disabled:opacity-30"
                      >
                        pin
                      </button>

                      <button
                        onClick={() => void removeTrack(track.id)}
                        className="shrink-0 text-ink-700 hover:text-red-400"
                        aria-label={`Delete ${track.name}`}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}

        <Button size="sm" variant="secondary" onClick={() => void createPlaylist()} loading={busy}>
          New playlist
        </Button>
      </div>

      {/* Ambient emitters placed on the map. */}
      <div className="mt-3 border-t border-ink-800 pt-3">
        <label className="mb-2 block">
          <div className="mb-1 flex justify-between text-[10px] text-ink-500">
            <span>Ambience radius</span>
            <span className="font-mono">{ambientRadius} squares</span>
          </div>
          <input
            type="range"
            min={2}
            max={40}
            value={ambientRadius}
            aria-label="Ambience radius"
            onChange={(e) => setAmbientRadius(Number(e.target.value))}
            className="w-full accent-arcane-500"
          />
        </label>

        {sounds.length === 0 ? (
          <p className="text-[10px] text-ink-600">
            No ambience placed. Select a token, then press “pin” on a track to drop a sound there —
            players hear it louder as they approach.
          </p>
        ) : (
          <ul className="space-y-1">
            {sounds.map((sound) => (
              <li key={sound.id} className="flex items-center gap-1.5 text-[11px]">
                <span className="min-w-0 flex-1 truncate text-ink-300">
                  {sound.name || 'ambience'}
                </span>
                <span className="shrink-0 text-[10px] text-ink-600">
                  ({sound.x.toFixed(0)}, {sound.y.toFixed(0)}) r{sound.radius}
                </span>
                <button
                  onClick={() => removeAmbient(sound.id)}
                  className="shrink-0 text-ink-700 hover:text-red-400"
                  aria-label={`Remove ${sound.name || 'ambience'}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
