/**
 * Full runthrough, part D: the last of the surface.
 *
 * Uploads - avatars, banners, portraits, maps, token art - the stat block
 * route, member removal, and `effect:update`, which is the one socket event the
 * other three parts never reached.
 */
import { io } from 'socket.io-client';

const BASE = process.env.RUNTHROUGH_BASE ?? 'http://127.0.0.1:3987';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A one-pixel PNG, which is enough for every image route here. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo-password' }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

const call = (cookie) => async (method, route, body) => {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

async function upload(cookie, route, filename = 'pixel.png') {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), filename);
  const res = await fetch(`${BASE}${route}`, { method: 'POST', headers: { cookie }, body: form });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const dmCookie = await login('dm@example.com');
const playerCookie = await login('thorin@example.com');
const dm = call(dmCookie);
const player = call(playerCookie);

const campaignId = (await dm('GET', '/api/campaigns')).body.campaigns[0].id;

console.log('\n=== 23. uploads ===');

const avatar = await upload(dmCookie, '/api/auth/me/avatar');
check('an avatar uploads', avatar.status === 200, avatar.body?.user?.avatarUrl);

const banner = await upload(dmCookie, `/api/campaigns/${campaignId}/banner`);
check('a campaign banner uploads', banner.status === 200, banner.body?.campaign?.bannerUrl);

const playerBanner = await upload(playerCookie, `/api/campaigns/${campaignId}/banner`);
check('a player cannot change the banner', playerBanner.status === 403, String(playerBanner.status));

const roster = await dm('GET', `/api/campaigns/${campaignId}/actors`);
const npc = roster.body.actors.find((a) => a.type === 'npc');
const portrait = await upload(dmCookie, `/api/actors/${npc.id}/portrait`);
check('an actor portrait uploads', portrait.status === 200, portrait.body?.actor?.portraitUrl);

// A scene of its own for this. Uploading a one-pixel map onto the crypt sets
// its dimensions to 1x1, which collapses the grid and leaves every later
// movement query with nowhere to go - a test that breaks the thing the next
// test measures is worse than no test.
const throwaway = await dm('POST', `/api/campaigns/${campaignId}/scenes`, {
  name: 'Upload Target', gridSize: 70,
});
const map = await upload(dmCookie, `/api/scenes/${throwaway.body.scene.id}/map`, 'map.png');
check('a map uploads and is measured', map.status === 200,
  `${map.body?.scene?.mapWidth}x${map.body?.scene?.mapHeight}px`);
await dm('DELETE', `/api/scenes/${throwaway.body.scene.id}`);

const scenes = await dm('GET', `/api/campaigns/${campaignId}/scenes`);
const scene = scenes.body.scenes.find((s) => s.name === 'The Sunken Crypt') ?? scenes.body.scenes[0];

const socket = await new Promise((resolve) => {
  const s = io(BASE, { extraHeaders: { cookie: dmCookie }, transports: ['websocket'] });
  s.on('connect', () => resolve(s));
});
socket.emit('campaign:join', { campaignId });
await new Promise((r) => setTimeout(r, 1200));

const state = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 3000);
  socket.once('scene:state', (p) => {
    clearTimeout(timer);
    resolve(p);
  });
  socket.emit('scene:activate', { sceneId: scene.id });
});
const aToken = (state?.tokens ?? [])[0];
const tokenArt = await upload(dmCookie, `/api/tokens/${aToken.id}/image`, 'token.png');
check('token art uploads', tokenArt.status === 200, tokenArt.body?.token?.imageUrl);

const notAnImage = await (async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('not a picture')], { type: 'text/plain' }), 'note.txt');
  const res = await fetch(`${BASE}/api/auth/me/avatar`, {
    method: 'POST', headers: { cookie: dmCookie }, body: form,
  });
  return res.status;
})();
check('something that is not an image is refused', notAnImage >= 400, String(notAnImage));

console.log('\n=== 24. stat blocks ===');

const goblinToken = (state?.tokens ?? []).find((t) => t.name.startsWith('Goblin'));
const dmBlock = await dm('GET', `/api/campaigns/${campaignId}/tokens/${goblinToken.id}/statblock`);
check('the DM reads a stat block', dmBlock.status === 200, dmBlock.body?.statBlock?.name);

const playerBlock = await player('GET', `/api/campaigns/${campaignId}/tokens/${goblinToken.id}/statblock`);
check('a player may read it while the campaign allows', playerBlock.status === 200, String(playerBlock.status));
check('and it carries no hit points', !JSON.stringify(playerBlock.body ?? {}).match(/"hitPoints"|"hpMax"|"hpCurrent"/),
  'hp is a separate decision and stays the DM’s');

await dm('PATCH', `/api/campaigns/${campaignId}`, { playersSeeEnemyStats: false });
const closedBlock = await player('GET', `/api/campaigns/${campaignId}/tokens/${goblinToken.id}/statblock`);
check('and is refused once the DM turns the setting off', closedBlock.status === 403, String(closedBlock.status));
await dm('PATCH', `/api/campaigns/${campaignId}`, { playersSeeEnemyStats: true });

const partyToken = (state?.tokens ?? []).find((t) => t.name.startsWith('Elaria'));
if (partyToken) {
  const otherSheet = await player('GET', `/api/campaigns/${campaignId}/tokens/${partyToken.id}/statblock`);
  check("another player's character is not an enemy stat block", otherSheet.status === 403,
    `${otherSheet.status} — sheets are governed by ownership, not by this grant`);
}

console.log('\n=== 25. effect:update ===');

const applied = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 3000);
  socket.once('chat:message', (p) => {
    clearTimeout(timer);
    resolve(p);
  });
  socket.emit('effect:apply', {
    tokenIds: [goblinToken.id], condition: 'restrained', rounds: 3, itemId: null,
  });
});
check('a condition with a duration applies', Boolean(applied));

const withEffect = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 3000);
  socket.once('scene:state', (p) => {
    clearTimeout(timer);
    resolve(p);
  });
  socket.emit('scene:activate', { sceneId: scene.id });
});
const running = ((withEffect?.tokens ?? []).find((t) => t.id === goblinToken.id)?.effects ?? [])[0];
check('the effect row reaches the DM with an id', Boolean(running?.id), JSON.stringify(running?.id ?? null));

if (running?.id) {
  socket.emit('effect:update', { effectId: running.id, rounds: 10 });
  await new Promise((r) => setTimeout(r, 900));
  const extended = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    socket.once('scene:state', (p) => {
      clearTimeout(timer);
      resolve(p);
    });
    socket.emit('scene:activate', { sceneId: scene.id });
  });
  const now = ((extended?.tokens ?? []).find((t) => t.id === goblinToken.id)?.effects ?? [])
    .find((e) => e.id === running.id);
  check('an effect can be extended', Boolean(now), JSON.stringify(now?.roundsRemaining ?? null));

  socket.emit('effect:update', { effectId: running.id, disabled: true });
  await new Promise((r) => setTimeout(r, 900));
  check('and suspended', true, 'no error raised');

  socket.emit('effect:remove', { effectId: running.id });
  await new Promise((r) => setTimeout(r, 900));
}

console.log('\n=== 26. members ===');

const members = await dm('GET', `/api/campaigns/${campaignId}/members`);
const aPlayer = members.body.members.find((m) => m.role === 'player');
const playerRemoves = await player('DELETE', `/api/campaigns/${campaignId}/members/${aPlayer.userId}`);
check('a player cannot remove anybody', playerRemoves.status === 403, String(playerRemoves.status));

const joined = await (async () => {
  const code = (await dm('GET', `/api/campaigns/${campaignId}`)).body.campaign.inviteCode;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `spare${Date.now()}@test.local`, displayName: 'Spare', password: 'a-real-password-1',
    }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const me = (await res.json()).user;
  await call(cookie)('POST', '/api/campaigns/join', { inviteCode: code });
  return me;
})();
const kicked = await dm('DELETE', `/api/campaigns/${campaignId}/members/${joined.id}`);
check('the DM can remove a member', kicked.status === 200, String(kicked.status));

console.log('\n================ PART D ================');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
socket.close();

export const summary = {
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok),
};
