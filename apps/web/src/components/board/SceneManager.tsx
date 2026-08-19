import { useCallback, useEffect, useState } from 'react';
import { Button } from '../ui.js';
import { api } from '../../lib/api.js';
import { useTable } from '../../store/table.js';
import type { WireScene } from '@dnd/shared';

interface SceneRow extends WireScene {
  sortOrder: number;
  /**
   * DM-side shelving, carried here rather than on `WireScene` for the same
   * reason `sortOrder` is: the player payload has no business knowing how the
   * DM has filed their scenes.
   */
  hidden: boolean;
}

/**
 * DM-only scene prep: create scenes, upload maps, calibrate the grid, and set
 * up vision and walls.
 *
 * Placing creatures used to live here as a fourth sub-tab, which put a
 * mid-combat action two clicks inside a panel you otherwise only open when
 * nobody is at the table. It is `CreaturePanel` now.
 */
interface GridGuess {
  size: number;
  offsetX: number;
  offsetY: number;
  confidence: number;
}

export function SceneManager({ campaignId }: { campaignId: string }) {
  const { scene, activateScene, wallTool, setWallTool, walls, eraseDrawing } = useTable();
  const [scenes, setScenes] = useState<SceneRow[]>([]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'scenes' | 'grid' | 'vision'>('scenes');
  const [localDarkness, setLocalDarkness] = useState(0);
  const [guess, setGuess] = useState<GridGuess | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    if (scene) setLocalDarkness(scene.darkness);
  }, [scene?.id, scene?.darkness]);

  /**
   * Paste a map straight in.
   *
   * Finding a map online and pressing Ctrl+V is the actual workflow; a file
   * picker means saving it first and then going looking for it.
   */
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (!scene) return;

      const image = [...(event.clipboardData?.items ?? [])].find((item) =>
        item.type.startsWith('image/'),
      );
      if (!image) return;

      const file = image.getAsFile();
      if (file) {
        event.preventDefault();
        void uploadMap(scene.id, file);
      }
    }

    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [scene?.id]);

  const load = useCallback(async () => {
    const sceneRes = await api.get<{ scenes: SceneRow[]; activeSceneId: string | null }>(
      `/api/campaigns/${campaignId}/scenes`,
    );
    setScenes(sceneRes.scenes);
    setActiveSceneId(sceneRes.activeSceneId);
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
      const res = await api.upload<{ grid: GridGuess | null }>(
        `/api/scenes/${sceneId}/map`,
        file,
      );
      await load();
      // Re-activate so every client picks up the new dimensions.
      if (activeSceneId === sceneId) activateScene(sceneId);

      // Offered, never applied silently: a wrong guess you did not ask for is
      // more confusing than three sliders.
      if (res.grid && res.grid.confidence > 0.15) setGuess(res.grid);
    } finally {
      setBusy(false);
    }
  }

  /** Optimistic, like the rename: this list is the DM's own. */
  function renameScene(sceneId: string, name: string) {
    setScenes((current) => current.map((s) => (s.id === sceneId ? { ...s, name } : s)));
    void patchScene(sceneId, { name });
  }

  function showToPlayers(sceneId: string) {
    activateScene(sceneId);
    setActiveSceneId(sceneId);
  }

  /**
   * Shelves a scene out of the DM's way.
   *
   * Deliberately not refused for the live scene: hiding it is a filing
   * decision, and what the party is looking at is `activeSceneId`, which this
   * does not touch. The row keeps its Live badge inside the hidden section so
   * it cannot be lost track of.
   */
  function setSceneHidden(sceneId: string, hidden: boolean) {
    setScenes((current) => current.map((s) => (s.id === sceneId ? { ...s, hidden } : s)));
    void patchScene(sceneId, { hidden });
  }

  /**
   * Deletes a scene and everything on it.
   *
   * Tokens, walls, fog, drawings and pins go with it by cascade, and the
   * server cleans up the map image unless another scene shares it - so the
   * confirm has to say more than "are you sure".
   */
  async function removeScene(sceneId: string, name: string) {
    if (!confirm(`Delete "${name}"? Its map, tokens, walls and fog go with it.`)) return;
    await api.delete(`/api/scenes/${sceneId}`);
    if (activeSceneId === sceneId) setActiveSceneId(null);
    await load();
  }

  async function patchScene(sceneId: string, fields: Record<string, unknown>) {
    await api.patch(`/api/scenes/${sceneId}`, fields);
    await load();
    if (activeSceneId === sceneId) activateScene(sceneId);
  }

  const visibleScenes = scenes.filter((row) => !row.hidden);
  const hiddenScenes = scenes.filter((row) => row.hidden);

  return (
    <div className="p-2">
      <div className="mb-3 flex gap-1">
        {(['scenes', 'grid', 'vision'] as const).map((key) => (
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
          {visibleScenes.map((row) => (
            <SceneRowCard
              key={row.id}
              row={row}
              isActive={row.id === activeSceneId}
              onRename={renameScene}
              onActivate={showToPlayers}
              onSetHidden={setSceneHidden}
              onUpload={uploadMap}
              onDelete={removeScene}
            />
          ))}

          <Button size="sm" variant="secondary" onClick={() => void createScene()} loading={busy}>
            New scene
          </Button>

          {hiddenScenes.length > 0 && (
            <div className="pt-1">
              <button
                onClick={() => setShowHidden((open) => !open)}
                className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-[11px] text-ink-500 hover:text-ink-300"
              >
                <span>{showHidden ? '▾' : '▸'}</span>
                Hidden
                <span className="text-ink-600">{hiddenScenes.length}</span>
              </button>

              {showHidden && (
                <div className="mt-1 space-y-2">
                  {hiddenScenes.map((row) => (
                    <SceneRowCard
                      key={row.id}
                      row={row}
                      isActive={row.id === activeSceneId}
                      onRename={renameScene}
                      onActivate={showToPlayers}
                      onSetHidden={setSceneHidden}
                      onUpload={uploadMap}
                      onDelete={removeScene}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {guess && scene && (
        <div className="mb-2 rounded-lg border border-arcane-500/50 bg-arcane-500/10 p-2">
          <div className="text-xs text-arcane-300">
            Found a {guess.size}px grid
            {guess.confidence < 0.4 && <span className="text-ink-500"> (not very sure)</span>}
          </div>
          <div className="mt-0.5 text-[10px] text-ink-500">
            offset {guess.offsetX}, {guess.offsetY} — check the overlay before accepting
          </div>
          <div className="mt-1.5 flex gap-1">
            <button
              onClick={() => {
                void patchScene(scene.id, {
                  gridSize: guess.size,
                  gridOffsetX: guess.offsetX,
                  gridOffsetY: guess.offsetY,
                });
                setGuess(null);
              }}
              className="flex-1 rounded border border-arcane-500 bg-arcane-500/20 px-2 py-1 text-[11px] text-arcane-300"
            >
              Use it
            </button>
            <button
              onClick={() => setGuess(null)}
              className="rounded border border-ink-700 px-2 py-1 text-[11px] text-ink-400"
            >
              Ignore
            </button>
          </div>
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

          <label className="flex items-center gap-2 text-xs text-ink-300">
            <input
              type="checkbox"
              checked={scene.playerDrawing}
              onChange={(e) => void patchScene(scene.id, { playerDrawing: e.target.checked })}
              className="accent-ember-500"
            />
            Let players draw and ping
          </label>
          <p className="text-[11px] text-ink-500">
            Off, only you can mark the map — useful while you are describing
            something, or during a puzzle. Enforced on the server, so it holds
            whatever the players' clients think.
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
                  // A wall players are never sent. Reveal it from the door's
                  // own controls and it becomes an ordinary door.
                  ['secret', 'Secret'],
                  ['note', 'Pin'],
                  ['draw', 'Pen'],
                  ['arrow', 'Arrow'],
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

          <div className="flex gap-1">
            <button
              onClick={() => eraseDrawing('mine')}
              className="flex-1 rounded border border-ink-700 px-2 py-1 text-[10px] text-ink-400 hover:border-ink-600"
            >
              Erase my drawings
            </button>
            <button
              onClick={() => eraseDrawing('all')}
              className="flex-1 rounded border border-red-900/60 px-2 py-1 text-[10px] text-red-300 hover:bg-red-950/40"
            >
              Erase all
            </button>
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

    </div>
  );
}

/**
 * Map images rarely line up with a clean grid, so the DM nudges size and offset
 * until the overlay matches the map's own squares. Because token positions are
 * stored in grid units, recalibrating here never moves the tokens.
 */
/**
 * One scene in the DM's list.
 *
 * Extracted because the visible list and the hidden section render the same
 * row; copying it would let the two drift.
 *
 * The thumbnail is the point of the redesign: a list of names gives no answer
 * to "which one was the crypt", and the map is already on the row.
 */
function SceneRowCard({
  row,
  isActive,
  onRename,
  onActivate,
  onSetHidden,
  onUpload,
  onDelete,
}: {
  row: SceneRow;
  isActive: boolean;
  onRename: (sceneId: string, name: string) => void;
  onActivate: (sceneId: string) => void;
  onSetHidden: (sceneId: string, hidden: boolean) => void;
  onUpload: (sceneId: string, file: File) => void | Promise<void>;
  onDelete: (sceneId: string, name: string) => void | Promise<void>;
}) {
  return (
    <div
      className={`rounded-lg border p-2 ${
        isActive ? 'border-ember-500/50 bg-ember-500/5' : 'border-ink-700'
      } ${row.hidden ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <div className="size-9 shrink-0 overflow-hidden rounded border border-ink-700 bg-ink-850">
          {row.mapImageUrl ? (
            <img src={row.mapImageUrl} alt="" loading="lazy" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-[9px] text-ink-600">
              No map
            </div>
          )}
        </div>

        <SceneName name={row.name} onRename={(name) => onRename(row.id, name)} />

        {isActive ? (
          <span className="text-[10px] text-ember-400 uppercase">Live</span>
        ) : (
          <button
            onClick={() => onActivate(row.id)}
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
              if (file) void onUpload(row.id, file);
            }}
          />
        </label>
        {row.mapWidth > 0 && (
          <span className="text-[10px] text-ink-600">
            {row.mapWidth}×{row.mapHeight}px
          </span>
        )}

        <button
          onClick={() => onSetHidden(row.id, !row.hidden)}
          className="ml-auto text-[11px] text-ink-600 hover:text-ink-300"
          title={
            row.hidden
              ? `Unhide ${row.name}`
              : `Hide ${row.name} — players are unaffected, they never see this list`
          }
        >
          {row.hidden ? 'Unhide' : 'Hide'}
        </button>
        <button
          onClick={() => void onDelete(row.id, row.name)}
          className="text-[11px] text-ink-600 hover:text-red-400"
          title={`Delete ${row.name}`}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * The scene name, editable in place.
 *
 * Held locally while typing and committed on blur or Enter, so a rename is one
 * write rather than one per keystroke. Escape puts back what was there.
 */
function SceneName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  const [editing, setEditing] = useState(false);

  // Follow a rename made elsewhere, but never yank the field out from under
  // someone mid-edit.
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === name) {
      setDraft(name);
      return;
    }
    onRename(next.slice(0, 80));
  }

  return (
    <input
      value={draft}
      aria-label={`Scene name: ${name}`}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(name);
          setEditing(false);
          e.currentTarget.blur();
        }
      }}
      className="min-w-0 flex-1 truncate rounded border border-transparent bg-transparent px-1 py-0.5 text-sm text-ink-100 hover:border-ink-700 focus:border-arcane-400 focus:bg-ink-850 focus:outline-none"
    />
  );
}

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
