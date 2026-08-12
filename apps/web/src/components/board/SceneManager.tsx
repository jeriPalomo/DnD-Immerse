import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui.js';
import { api } from '../../lib/api.js';
import { MonsterBrowser } from './MonsterBrowser.js';
import { useTable } from '../../store/table.js';
import type { WireScene } from '@dnd/shared';

interface SceneRow extends WireScene {
  sortOrder: number;
}

interface PartyActor {
  id: string;
  name: string;
  type: string;
  portraitUrl: string | null;
}

/**
 * DM-only scene controls: create scenes, upload maps, calibrate the grid, and
 * drop tokens from the campaign's actors.
 */
export function SceneManager({ campaignId }: { campaignId: string }) {
  const { scene, activateScene, createToken, wallTool, setWallTool, walls } = useTable();
  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [actors, setActors] = useState<PartyActor[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'scenes' | 'tokens' | 'grid' | 'vision'>('scenes');
  const [localDarkness, setLocalDarkness] = useState(0);
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    if (scene) setLocalDarkness(scene.darkness);
  }, [scene?.id, scene?.darkness]);

  const load = useCallback(async () => {
    const [sceneRes, actorRes] = await Promise.all([
      api.get<{ scenes: SceneRow[]; activeSceneId: string | null }>(
        `/api/campaigns/${campaignId}/scenes`,
      ),
      api.get<{ actors: PartyActor[] }>(`/api/campaigns/${campaignId}/actors`),
    ]);
    setScenes(sceneRes.scenes);
    setActiveSceneId(sceneRes.activeSceneId);
    setActors(actorRes.actors);
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createScene() {
    setBusy(true);
    try {
      await api.post(`/api/campaigns/${campaignId}/scenes`, { name: `Scene ${scenes.length + 1}` });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function uploadMap(sceneId: string, file: File) {
    setBusy(true);
    try {
      await api.upload(`/api/scenes/${sceneId}/map`, file);
      await load();
      // Re-activate so every client picks up the new dimensions.
      if (activeSceneId === sceneId) activateScene(sceneId);
    } finally {
      setBusy(false);
    }
  }

  async function patchScene(sceneId: string, fields: Record<string, unknown>) {
    await api.patch(`/api/scenes/${sceneId}`, fields);
    await load();
    if (activeSceneId === sceneId) activateScene(sceneId);
  }

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
      <div className="mb-3 flex gap-1">
        {(['scenes', 'tokens', 'grid', 'vision'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded px-2.5 py-1 text-xs capitalize transition-colors ${
              tab === key ? 'bg-ink-700 text-ink-100' : 'text-ink-500 hover:text-ink-300'
            }`}
          >
            {key}
          </button>
        ))}
      </div>

      {tab === 'scenes' && (
        <div className="space-y-2">
          {scenes.map((row) => (
            <div
              key={row.id}
              className={`rounded-lg border p-2 ${
                row.id === activeSceneId ? 'border-ember-500/50 bg-ember-500/5' : 'border-ink-700'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-ink-100">{row.name}</span>
                {row.id === activeSceneId ? (
                  <span className="text-[10px] text-ember-400 uppercase">Live</span>
                ) : (
                  <button
                    onClick={() => {
                      activateScene(row.id);
                      setActiveSceneId(row.id);
                    }}
                    className="rounded border border-ink-600 px-2 py-0.5 text-[11px] text-ink-300 hover:border-ember-500"
                  >
                    Show players
                  </button>
                )}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <label className="cursor-pointer text-[11px] text-arcane-400 hover:underline">
                  {row.mapImageUrl ? 'Replace map' : 'Upload map'}
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void uploadMap(row.id, file);
                    }}
                  />
                </label>
                {row.mapWidth > 0 && (
                  <span className="text-[10px] text-ink-600">
                    {row.mapWidth}×{row.mapHeight}px
                  </span>
                )}
              </div>
            </div>
          ))}
          <Button size="sm" variant="secondary" onClick={() => void createScene()} loading={busy}>
            New scene
          </Button>
        </div>
      )}

      {tab === 'grid' && scene && (
        <GridCalibration scene={scene} onChange={(fields) => void patchScene(scene.id, fields)} />
      )}

      {tab === 'vision' && scene && (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-xs text-ink-300">
            <input
              type="checkbox"
              checked={scene.visionEnabled}
              onChange={(e) => void patchScene(scene.id, { visionEnabled: e.target.checked })}
              className="accent-ember-500"
            />
            Dynamic vision
          </label>
          <p className="text-[11px] text-ink-500">
            With vision on, each player sees only what their tokens can see. Walls
            are computed on the server, so players never receive the geometry.
          </p>

          <div>
            <div className="mb-1.5 flex items-center justify-between text-[11px] text-ink-400">
              <span>Wall tool</span>
              <span className="text-ink-600">{walls.length} walls</span>
            </div>
            <div className="flex gap-1.5">
              {(
                [
                  ['off', 'Off'],
                  ['wall', 'Wall'],
                  ['door', 'Door'],
                  ['note', 'Pin'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setWallTool(value)}
                  className={`flex-1 rounded border px-2 py-1 text-xs transition-colors ${
                    wallTool === value
                      ? 'border-arcane-400 bg-arcane-500/20 text-arcane-400'
                      : 'border-ink-700 text-ink-400 hover:text-ink-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-ink-600">
              Click to place points; each click continues the run. Double-click to
              finish a run, alt-click a wall to delete it.
            </p>
          </div>

          <label className="flex items-center gap-2 text-xs text-ink-300">
            <input
              type="checkbox"
              checked={scene.globalIllumination}
              onChange={(e) => void patchScene(scene.id, { globalIllumination: e.target.checked })}
              className="accent-ember-500"
            />
            Daylight (ignore token light radius)
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-ink-400">Weather</span>
              <select
                value={scene.weather}
                aria-label="Scene weather"
                onChange={(e) => void patchScene(scene.id, { weather: e.target.value })}
                className="w-full rounded border border-ink-600 bg-ink-850 px-2 py-1 text-xs text-ink-100 focus:border-arcane-400 focus:outline-none"
              >
                {['none', 'rain', 'storm', 'snow', 'fog', 'ash'].map((w) => (
                  <option key={w} value={w}>
                    {w === 'none' ? 'Clear' : w[0].toUpperCase() + w.slice(1)}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 flex justify-between text-[11px] text-ink-400">
                <span>Intensity</span>
                <span className="font-mono text-ink-200">{Math.round(scene.weatherIntensity * 100)}%</span>
              </span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={scene.weatherIntensity}
                aria-label="Weather intensity"
                disabled={scene.weather === 'none'}
                onChange={(e) => void patchScene(scene.id, { weatherIntensity: Number(e.target.value) })}
                className="mt-1.5 w-full accent-arcane-500 disabled:opacity-30"
              />
            </label>
          </div>

          {scene.globalIllumination && (
            <label className="block">
              <div className="mb-1 flex justify-between text-[11px] text-ink-400">
                <span>Gloom</span>
                <span className="font-mono text-ink-200">{Math.round(scene.darkness * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={localDarkness}
                aria-label="Scene gloom"
                onChange={(e) => setLocalDarkness(Number(e.target.value))}
                // Committed on release so dragging does not spam the server.
                onMouseUp={() => void patchScene(scene.id, { darkness: localDarkness })}
                onTouchEnd={() => void patchScene(scene.id, { darkness: localDarkness })}
                className="w-full accent-arcane-500"
              />
              <p className="mt-1 text-[10px] text-ink-600">
                Dims sight toward what each token can supply for itself — dusk and fog,
                without going fully dark.
              </p>
            </label>
          )}
        </div>
      )}

      {tab === 'tokens' && (
        <div>
          <p className="mb-2 text-[11px] text-ink-500">
            Drops a token at the top-left of the map, sized from the actor's stat block.
          </p>

          <Button size="sm" variant="secondary" onClick={() => setBrowsing(true)} className="mb-2">
            Add from bestiary
          </Button>
          <div className="flex flex-wrap gap-1.5">
            {actors.map((actor) => (
              <button
                key={actor.id}
                disabled={!scene}
                onClick={() =>
                  createToken({ sceneId: scene!.id, actorId: actor.id, x: 1, y: 1, name: actor.name })
                }
                className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-ink-200 transition-colors hover:border-ember-500 disabled:opacity-40"
              >
                {actor.name}
                {actor.type === 'npc' && <span className="ml-1 text-ink-600">NPC</span>}
              </button>
            ))}
          </div>
          {!scene && <p className="mt-2 text-xs text-ink-600">Activate a scene first.</p>}
        </div>
      )}
      {browsing && (
        <MonsterBrowser
          campaignId={campaignId}
          onAdded={() => void load()}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}

/**
 * Map images rarely line up with a clean grid, so the DM nudges size and offset
 * until the overlay matches the map's own squares. Because token positions are
 * stored in grid units, recalibrating here never moves the tokens.
 */
function GridCalibration({
  scene,
  onChange,
}: {
  scene: WireScene;
  onChange: (fields: Record<string, unknown>) => void;
}) {
  const [local, setLocal] = useState({
    gridSize: scene.gridSize,
    gridOffsetX: scene.gridOffsetX,
    gridOffsetY: scene.gridOffsetY,
    feetPerSquare: scene.feetPerSquare,
  });

  useEffect(() => {
    setLocal({
      gridSize: scene.gridSize,
      gridOffsetX: scene.gridOffsetX,
      gridOffsetY: scene.gridOffsetY,
      feetPerSquare: scene.feetPerSquare,
    });
  }, [scene.id, scene.gridSize, scene.gridOffsetX, scene.gridOffsetY, scene.feetPerSquare]);

  const fields = [
    { key: 'gridSize' as const, label: 'Square size (px)', min: 4, max: 512, step: 1 },
    { key: 'gridOffsetX' as const, label: 'Offset X', min: -256, max: 256, step: 1 },
    { key: 'gridOffsetY' as const, label: 'Offset Y', min: -256, max: 256, step: 1 },
    { key: 'feetPerSquare' as const, label: 'Feet per square', min: 1, max: 100, step: 1 },
  ];

  return (
    <div className="space-y-3">
      {fields.map(({ key, label, min, max, step }) => (
        <label key={key} className="block">
          <div className="mb-1 flex justify-between text-[11px] text-ink-400">
            <span>{label}</span>
            <span className="font-mono text-ink-200">{local[key]}</span>
          </div>
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={local[key]}
            aria-label={label}
            onChange={(e) => setLocal({ ...local, [key]: Number(e.target.value) })}
            // Commit on release so dragging the slider does not spam the server.
            onMouseUp={() => onChange({ [key]: local[key] })}
            onTouchEnd={() => onChange({ [key]: local[key] })}
            className="w-full accent-ember-500"
          />
        </label>
      ))}

      <label className="flex items-center gap-2 text-xs text-ink-300">
        <input
          type="checkbox"
          checked={scene.gridVisible}
          onChange={(e) => onChange({ gridVisible: e.target.checked })}
          className="accent-ember-500"
        />
        Show grid
      </label>
    </div>
  );
}
