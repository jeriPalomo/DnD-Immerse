/**
 * Full runthrough, part B: the board. Scenes, walls, terrain, fog, tokens,
 * pins, drawings and templates - forty-odd socket events, driven the way the
 * server's own tests drive them.
 */
import { io } from 'socket.io-client';

const BASE = process.env.RUNTHROUGH_BASE ?? 'http://127.0.0.1:3987';

const results = [];
const events = new Set();
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo-password' }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

function api(cookie) {
  return async (method, route, body) => {
    const res = await fetch(`${BASE}${route}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

function connect(cookie) {
  return new Promise((resolve) => {
    const socket = io(BASE, { extraHeaders: { cookie }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
  });
}

/** The next event of this name, or null if it never comes. */
function next(socket, event, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, timeoutMs);
    const handler = (payload) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

function emit(socket, event, payload) {
  events.add(event);
  socket.emit(event, payload);
}

const dmCookie = await login('dm@example.com');
const playerCookie = await login('thorin@example.com');
const dmApi = api(dmCookie);
const playerApi = api(playerCookie);

const campaigns = await dmApi('GET', '/api/campaigns');
const campaignId = campaigns.body.campaigns[0].id;

const dm = await connect(dmCookie);
const player = await connect(playerCookie);
emit(dm, 'campaign:join', { campaignId });
emit(player, 'campaign:join', { campaignId });
await new Promise((r) => setTimeout(r, 1200));

console.log('\n=== 8. scenes ===');

const made = await dmApi('POST', `/api/campaigns/${campaignId}/scenes`, {
  name: 'Runthrough Hall', gridSize: 70, width: 24, height: 18,
});
const sceneId = made.body.scene.id;
check('a scene is created', made.status === 200, made.body.scene.name);

const renamed = await dmApi('PATCH', `/api/scenes/${sceneId}`, { name: 'Renamed Hall' });
check('renamed', renamed.body.scene.name === 'Renamed Hall');

const configured = await dmApi('PATCH', `/api/scenes/${sceneId}`, {
  visionEnabled: true, globalIllumination: false, darkness: 0.4,
  weather: 'fog', weatherIntensity: 0.6, gridVisible: true, feetPerSquare: 5,
  playerDrawing: true, hidden: false,
});
check('vision, darkness, weather and grid all set', configured.status === 200,
  `weather=${configured.body.scene.weather} darkness=${configured.body.scene.darkness}`);

const activated = next(player, 'scene:state', 3000);
emit(dm, 'scene:activate', { sceneId });
const playerScene = await activated;
check('activating pushes the scene to players', playerScene?.scene?.id === sceneId, playerScene?.scene?.name);
check('and players receive no walls', (playerScene?.walls?.length ?? 0) === 0, `walls=${playerScene?.walls?.length ?? 0}`);

const playerActivate = next(player, 'error');
emit(player, 'scene:activate', { sceneId });
check('a player cannot change the scene', Boolean(await playerActivate));

console.log('\n=== 9. walls and doors ===');

const wallIds = [];
for (const [x1, y1, x2, y2] of [[2, 2, 12, 2], [2, 2, 2, 10], [2, 10, 12, 10], [12, 2, 12, 5], [12, 7, 12, 10]]) {
  const created = next(dm, 'wall:created');
  emit(dm, 'wall:create', { sceneId, x1, y1, x2, y2 });
  const w = await created;
  if (w?.wall?.id) wallIds.push(w.wall.id);
}
check('walls are created', wallIds.length === 5, `${wallIds.length} segments`);

const doorMade = next(dm, 'wall:created');
emit(dm, 'wall:create', { sceneId, x1: 12, y1: 5, x2: 12, y2: 7, door: 1, doorState: 0 });
const doorId = (await doorMade)?.wall?.id;
check('a door is created', Boolean(doorId));

const secretMade = next(dm, 'wall:created');
emit(dm, 'wall:create', { sceneId, x1: 2, y1: 5, x2: 2, y2: 7, door: 2, doorState: 0 });
const secretId = (await secretMade)?.wall?.id;
check('a secret door is created', Boolean(secretId));

const sceneForPlayer = await new Promise((resolve) => {
  const w = next(player, 'scene:state', 3000);
  emit(dm, 'scene:activate', { sceneId });
  resolve(w);
});
const playerDoors = (await sceneForPlayer)?.doors ?? [];
check('a player is sent ordinary doors', playerDoors.some((d) => d.id === doorId), `${playerDoors.length} doors`);
check('but never the secret one', !playerDoors.some((d) => d.id === secretId));

const toggled = next(dm, 'door:updated');
emit(player, 'door:toggle', { wallId: doorId });
check('a player can open a door', (await toggled)?.door?.doorState === 1);

emit(dm, 'wall:update', { wallId: doorId, doorState: 2 });
await new Promise((r) => setTimeout(r, 400));
const lockedFail = next(player, 'error');
emit(player, 'door:toggle', { wallId: doorId });
check('but not a locked one', /locked/i.test((await lockedFail)?.message ?? ''));
emit(dm, 'wall:update', { wallId: doorId, doorState: 0 });
await new Promise((r) => setTimeout(r, 400));

const revealed = next(dm, 'wall:updated', 3000);
emit(dm, 'wall:update', { wallId: secretId, door: 1 });
check('a secret door can be revealed', (await revealed)?.wall?.door === 1);

const deleted = next(dm, 'wall:deleted');
emit(dm, 'wall:delete', { wallId: wallIds[wallIds.length - 1] });
check('a wall can be deleted', Boolean(await deleted));

console.log('\n=== 10. terrain ===');

for (const kind of ['blocked', 'mud', 'water', 'clear']) {
  // `terrain:state`, and to the DM room alone: painted ground is a map of the
  // dungeon and never leaves it.
  const painted = next(dm, 'terrain:state', 3000);
  emit(dm, 'terrain:paint', { sceneId, cells: [[6, 6], [6, 7]], brush: kind });
  const state = await painted;
  check(`${kind} paints`, Boolean(state), state ? 'terrain pushed to the DM' : 'no push');
}

const playerTerrain = next(player, 'terrain:state', 1500);
emit(dm, 'terrain:paint', { sceneId, cells: [[9, 9]], brush: 'mud' });
check('and never reaches a player', (await playerTerrain) === null);

const playerPaint = next(player, 'error');
emit(player, 'terrain:paint', { sceneId, cells: [[8, 8]], brush: 'blocked' });
check('a player cannot paint ground', Boolean(await playerPaint));

console.log('\n=== 11. tokens ===');

const roster = await dmApi('GET', `/api/campaigns/${campaignId}/actors`);
const goblinActor = roster.body.actors.find((a) => a.name === 'Goblin' && a.type === 'npc');

const placed = [];
for (let i = 0; i < 3; i++) {
  const created = next(dm, 'token:created');
  emit(dm, 'token:create', { sceneId, x: 4 + i, y: 4, actorId: goblinActor.id, name: 'Goblin' });
  const t = await created;
  if (t?.token) placed.push(t.token);
}
check('tokens are placed from an actor', placed.length === 3);
check('repeats are numbered, never renamed', placed.map((t) => t.name).join(', ') === 'Goblin, Goblin 2, Goblin 3',
  placed.map((t) => t.name).join(', '));
check('and sized from the stat block', placed[0].w === 1, `${placed[0].w}x${placed[0].h}`);

const quantity = next(dm, 'token:created');
emit(dm, 'token:create', { sceneId, x: 8, y: 4, actorId: goblinActor.id, name: 'Goblin', quantity: 2 });
await quantity;
await new Promise((r) => setTimeout(r, 600));

const updated = next(dm, 'token:updated', 3000);
emit(dm, 'token:update', { tokenId: placed[0].id, hp: 3, ringColor: '#8b5cf6', hidden: false, locked: true, statsHidden: true });
const changed = await updated;
check('a token takes hp, a ring, a lock and a closed stat block',
  changed?.token?.hp === 3 && changed?.token?.ringColor === '#8b5cf6' && changed?.token?.locked === true,
  JSON.stringify({ hp: changed?.token?.hp, ring: changed?.token?.ringColor, locked: changed?.token?.locked }));

// statsHidden is sent to players as false whatever it really is: telling them
// the DM closed *this* creature marks it as the interesting one.
const playerView = await new Promise((resolve) => {
  const w = next(player, 'scene:state', 3000);
  emit(dm, 'scene:activate', { sceneId });
  resolve(w);
});
const seenByPlayer = ((await playerView)?.tokens ?? []).find((t) => t.id === placed[0].id);
check('a closed stat block is not advertised to players',
  !seenByPlayer || seenByPlayer.statsHidden === false, JSON.stringify(seenByPlayer?.statsHidden));

// With vision on, a monster being dragged behind a wall must not stream its
// coordinates to every player at 30Hz. The fast path is the DM room; players
// are re-emitted to only if they can actually see it.
const unseen = next(player, 'token:moved', 1800);
emit(dm, 'token:move', { tokenId: placed[0].id, x: 5.4, y: 4.2 });
check('a drag frame for an unsighted creature never reaches a player', (await unseen) === null);

await dmApi('PATCH', `/api/scenes/${sceneId}`, { visionEnabled: false });
await new Promise((r) => setTimeout(r, 600));
const seen = next(player, 'token:moved', 2500);
emit(dm, 'token:move', { tokenId: placed[0].id, x: 5.6, y: 4.4 });
check('and does reach them once nothing is hidden', Boolean(await seen));
await dmApi('PATCH', `/api/scenes/${sceneId}`, { visionEnabled: true });
await new Promise((r) => setTimeout(r, 600));

const committed = next(dm, 'token:updated');
emit(dm, 'token:commit', { tokenId: placed[0].id, x: 5.4, y: 4.2 });
const snapped = await committed;
check('a commit snaps the position', snapped?.token?.x === 5.5 || Number.isInteger(snapped?.token?.x),
  `landed at ${snapped?.token?.x},${snapped?.token?.y}`);

const playerMove = next(player, 'error');
emit(player, 'token:commit', { tokenId: placed[1].id, x: 9, y: 9 });
check('a player cannot move a creature that is not theirs', Boolean(await playerMove));

const tokenGone = next(dm, 'token:deleted');
emit(dm, 'token:delete', { tokenId: placed[2].id });
check('a token can be deleted', Boolean(await tokenGone));

console.log('\n=== 12. pins, drawings, templates ===');

const note = await dmApi('POST', `/api/scenes/${sceneId}/notes`, { x: 5, y: 5, label: 'A loose flagstone', hidden: true });
check('a pin is dropped', note.status === 200, note.body?.note?.label);
const shownNote = await dmApi('PATCH', `/api/notes/${note.body.note.id}`, { hidden: false });
check('and revealed', shownNote.status === 200);
const goneNote = await dmApi('DELETE', `/api/notes/${note.body.note.id}`);
check('and deleted', goneNote.status === 200);

const drawn = next(dm, 'scene:state', 3000);
emit(dm, 'drawing:create', { sceneId, kind: 'freehand', points: [1, 1, 3, 3, 5, 1], color: '#e8853f', width: 3 });
const withStroke = await drawn;
const strokes = withStroke?.drawings ?? [];
check('a freehand stroke is drawn', strokes.length > 0, `${strokes.length} on the board`);

const arrowed = next(dm, 'scene:state', 3000);
emit(dm, 'drawing:create', { sceneId, kind: 'arrow', points: [2, 2, 6, 6], color: '#e8853f', width: 3 });
check('an arrow is drawn', ((await arrowed)?.drawings ?? []).length > strokes.length);

const erased = next(dm, 'scene:state', 3000);
emit(dm, 'drawing:delete', { drawingId: 'all' });
check('and they can all be wiped', ((await erased)?.drawings ?? []).length === 0);

for (const shape of ['circle', 'cone', 'ray', 'rect']) {
  const tpl = next(dm, 'template:state', 3000);
  emit(dm, 'template:create', { sceneId, shape, x: 8, y: 8, direction: 45, distance: 20, width: 5 });
  const state = await tpl;
  check(`a ${shape} template is placed`, (state?.templates?.length ?? 0) > 0, `${state?.templates?.length} on the board`);
}
const lastTemplates = await new Promise((resolve) => {
  const w = next(dm, 'template:state', 3000);
  emit(dm, 'template:create', { sceneId, shape: 'circle', x: 2, y: 2, distance: 10 });
  resolve(w);
});
const toClear = (await lastTemplates)?.templates ?? [];
if (toClear.length) {
  const cleared = next(dm, 'template:state', 3000);
  emit(dm, 'template:delete', { templateId: toClear[toClear.length - 1].id });
  check('a template is cleared', Boolean(await cleared));
}

console.log('\n=== 13. fog and pings ===');

const revealFog = next(player, 'scene:state', 3000);
emit(dm, 'fog:reveal', { sceneId });
const revealedState = await revealFog;
check('reveal opens the map', (revealedState?.vision?.explored?.length ?? 0) > 0,
  `${revealedState?.vision?.explored?.length} squares`);

const resetFog = next(player, 'scene:state', 3000);
emit(dm, 'fog:reset', { sceneId });
const resetState = await resetFog;
check('reset puts it back', (resetState?.vision?.explored?.length ?? 0) < (revealedState?.vision?.explored?.length ?? 0),
  `${resetState?.vision?.explored?.length} squares`);

const pinged = next(player, 'ping:map', 2500);
emit(dm, 'ping:map', { sceneId, x: 5, y: 5 });
check('a ping reaches the players', Boolean(await pinged));

console.log('\n================ PART B ================');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
console.log(`\nsocket events exercised: ${[...events].sort().join(', ')}`);

dm.close();
player.close();

export const summary = {
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok),
};
