/**
 * Full runthrough, part C: combat, chat, dice, cards, conditions, movement and
 * the journal - the rest of the socket surface.
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

const connect = (cookie) =>
  new Promise((resolve) => {
    const socket = io(BASE, { extraHeaders: { cookie }, transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
  });

function next(socket, event, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, timeoutMs);
    const handler = (p) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(p);
    };
    socket.on(event, handler);
  });
}

/** The next event that is actually the one being waited for. */
function nextWhere(socket, event, matches, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, timeoutMs);
    const handler = (p) => {
      if (!matches(p)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(p);
    };
    socket.on(event, handler);
  });
}

const emit = (socket, event, payload) => {
  events.add(event);
  socket.emit(event, payload);
};

const dmCookie = await login('dm@example.com');
const playerCookie = await login('thorin@example.com');
const dmApi = api(dmCookie);

const campaignId = (await dmApi('GET', '/api/campaigns')).body.campaigns[0].id;
const dm = await connect(dmCookie);
const player = await connect(playerCookie);
emit(dm, 'campaign:join', { campaignId });
emit(player, 'campaign:join', { campaignId });
await new Promise((r) => setTimeout(r, 1500));

// Back to the seeded crypt, which has the party and the goblins on it.
const scenes = await dmApi('GET', `/api/campaigns/${campaignId}/scenes`);
const crypt = scenes.body.scenes.find((s) => s.name === 'The Sunken Crypt');
emit(dm, 'scene:activate', { sceneId: crypt.id });
const sceneState = await next(dm, 'scene:state', 3000);
const tokens = sceneState?.tokens ?? [];
const goblins = tokens.filter((t) => t.name.startsWith('Goblin'));
const thorinToken = tokens.find((t) => t.name.startsWith('Thorin'));
check('the seeded crypt has creatures on it', goblins.length >= 3 && Boolean(thorinToken),
  `${goblins.length} goblins, party present: ${Boolean(thorinToken)}`);

console.log('\n=== 14. chat and dice ===');

const heard = next(player, 'chat:message', 3000);
emit(dm, 'chat:send', { body: 'The crypt is cold.', whisperToUserId: null, actorId: null });
check('a public message reaches a player', /crypt is cold/.test((await heard)?.message?.body ?? ''));

const rolled = next(player, 'chat:message', 3000);
emit(player, 'chat:roll', { expression: '2d6+3', label: 'Damage', secret: false });
const rollMsg = await rolled;
check('a dice roll is rolled on the server', rollMsg?.message?.rollData?.total >= 5,
  `${rollMsg?.message?.rollData?.expression} = ${rollMsg?.message?.rollData?.total}`);
check('and the individual faces come back', (rollMsg?.message?.rollData?.rolls?.length ?? 0) === 2);

const huge = next(player, 'error', 2500);
emit(player, 'chat:roll', { expression: '99999d99999', label: '', secret: false });
check('an absurd expression is refused', Boolean(await huge));

const secretToDm = next(dm, 'chat:message', 3000);
const secretToPlayer = next(player, 'chat:message', 1800);
emit(dm, 'chat:roll', { expression: '1d20', label: 'Secret', secret: true });
check('a secret roll reaches the DM', Boolean(await secretToDm));
check('and not the players', (await secretToPlayer) === null);

const members = await dmApi('GET', `/api/campaigns/${campaignId}/members`);
const thorinUserId = members.body.members.find((m) => m.displayName?.startsWith('Thorin'))?.userId
  ?? members.body.members.find((m) => m.role === 'player')?.userId;
const whispered = next(player, 'chat:message', 3000);
emit(dm, 'chat:send', { body: 'psst', whisperToUserId: thorinUserId, actorId: null });
check('the DM can whisper a player', /psst/.test((await whispered)?.message?.body ?? ''));

console.log('\n=== 15. item cards ===');

const thorinActorId = thorinToken?.actorId;
const sheet = await dmApi('GET', `/api/actors/${thorinActorId}`);
const weapon = sheet.body.items.find((i) => i.type === 'weapon');
check('the party has a weapon to swing', Boolean(weapon), weapon?.name);

if (weapon) {
  const carded = next(dm, 'chat:message', 3000);
  emit(player, 'chat:card', { itemId: weapon.id, actorId: thorinActorId, targetTokenId: goblins[0].id });
  const card = await carded;
  check('posting an item makes a card', Boolean(card?.message?.cardData), card?.message?.cardData?.name);
  check('the card offers attack and damage',
    (card?.message?.cardData?.actions ?? []).includes('attack'), JSON.stringify(card?.message?.cardData?.actions));

  for (const action of ['attack', 'damage', 'critical']) {
    const acted = nextWhere(dm, 'chat:message', (p) => Boolean(p?.message?.rollData), 3000);
    emit(player, 'chat:cardAction', {
      itemId: weapon.id, actorId: thorinActorId, action, targetTokenId: goblins[0].id,
    });
    const result = await acted;
    check(`the ${action} button rolls`, Boolean(result?.message?.rollData),
      `${result?.message?.rollData?.expression} = ${result?.message?.rollData?.total}`);
  }
}

console.log('\n=== 16. damage, healing and death saves ===');

const damaged = next(dm, 'damage:applied', 3000);
emit(dm, 'damage:apply', { tokenIds: [goblins[0].id], amount: 3, damageType: 'slashing', healing: false, halved: false });
const dmg = await damaged;
check('damage applies and reports what happened', (dmg?.results?.length ?? 0) === 1,
  `${dmg?.results?.[0]?.name}: ${dmg?.results?.[0]?.before} -> ${dmg?.results?.[0]?.after}`);

// Topped up first: a goblin already on 1 hit point cannot show you a halving,
// it just dies, and this database is reused between runs.
emit(dm, 'damage:apply', { tokenIds: [goblins[1].id], amount: 20, damageType: '', healing: true, halved: false });
await new Promise((r) => setTimeout(r, 700));
const halved = next(dm, 'damage:applied', 3000);
emit(dm, 'damage:apply', { tokenIds: [goblins[1].id], amount: 4, damageType: 'fire', healing: false, halved: true });
const half = await halved;
check('half damage halves', half?.results?.[0]?.before - half?.results?.[0]?.after === 2,
  `${half?.results?.[0]?.before} -> ${half?.results?.[0]?.after}`);

const healed = next(dm, 'damage:applied', 3000);
emit(dm, 'damage:apply', { tokenIds: [goblins[0].id], amount: 2, damageType: '', healing: true, halved: false });
check('healing heals', Boolean(await healed));

const playerHeal = next(player, 'error', 2000);
emit(player, 'damage:apply', { tokenIds: [thorinToken.id], amount: 5, damageType: '', healing: true, halved: false });
check('a player cannot heal', Boolean(await playerHeal));

const playerHitsCharacter = next(player, 'error', 2000);
emit(player, 'damage:apply', { tokenIds: [thorinToken.id], amount: 5, damageType: 'fire', healing: false, halved: false });
check('a player cannot damage a character', Boolean(await playerHitsCharacter));

const downed = next(dm, 'damage:applied', 3000);
emit(dm, 'damage:apply', { tokenIds: [goblins[2].id], amount: 99, damageType: 'fire', healing: false, halved: false });
await downed;
const deathSave = next(dm, 'chat:message', 3000);
emit(dm, 'death:save', { tokenId: goblins[2].id });
check('a death save can be rolled', Boolean(await deathSave));

console.log('\n=== 17. conditions and effects ===');

const applied = next(dm, 'chat:message', 3000);
emit(dm, 'effect:apply', { tokenIds: [goblins[0].id], condition: 'prone', rounds: 3, itemId: null });
check('a condition applies and says so', Boolean(await applied));

const badCondition = next(dm, 'error', 2500);
emit(dm, 'effect:apply', { tokenIds: [goblins[0].id], condition: 'bewildered', rounds: 1, itemId: null });
check('a condition the engine cannot model is refused', Boolean(await badCondition));

const afterEffect = await new Promise((resolve) => {
  const w = next(dm, 'scene:state', 3000);
  emit(dm, 'scene:activate', { sceneId: crypt.id });
  resolve(w);
});
const proneGoblin = ((await afterEffect)?.tokens ?? []).find((t) => t.id === goblins[0].id);
check('the token carries the condition', (proneGoblin?.conditions ?? []).includes('prone'),
  JSON.stringify(proneGoblin?.conditions));

const runningEffect = (proneGoblin?.effects ?? [])[0];
check('the effect row is on the wire with an id to remove it by', Boolean(runningEffect?.id),
  JSON.stringify(runningEffect?.id ?? null));
emit(dm, 'effect:remove', { effectId: runningEffect?.id });
await new Promise((r) => setTimeout(r, 800));
const cleared = await new Promise((resolve) => {
  const w = next(dm, 'scene:state', 3000);
  emit(dm, 'scene:activate', { sceneId: crypt.id });
  resolve(w);
});
const clean = ((await cleared)?.tokens ?? []).find((t) => t.id === goblins[0].id);
check('and removed', !(clean?.conditions ?? []).includes('prone'), JSON.stringify(clean?.conditions));

console.log('\n=== 18. combat ===');

emit(dm, 'encounter:end', {});
await new Promise((r) => setTimeout(r, 500));
const startedFight = next(dm, 'initiative:state', 3000);
emit(dm, 'encounter:start', { sceneId: crypt.id });
check('an encounter starts', Boolean((await startedFight)?.encounter));

const withEveryone = nextWhere(dm, 'initiative:state', (p) => (p?.encounter?.entries?.length ?? 0) >= 4, 4000);
emit(dm, 'initiative:add', {
  tokenIds: [...goblins.map((g) => g.id), thorinToken.id], roll: true, askPlayers: true,
});
const order = (await withEveryone)?.encounter;
check('everyone joins the order', (order?.entries?.length ?? 0) >= 4, `${order?.entries?.length} combatants`);
const waiting = order.entries.filter((e) => e.pending);
check('the monsters rolled and the character waits', waiting.length === 1 && waiting[0].name.startsWith('Thorin'),
  `${waiting.length} waiting`);
check('a waiting entry shows what it will add', typeof waiting[0].initiativeBonus === 'number',
  String(waiting[0].initiativeBonus));

const alreadyRolled = order.entries.find((e) => !e.pending);
const wasAt = alreadyRolled.initiative;
emit(player, 'initiative:roll', { entryId: alreadyRolled.id });
await new Promise((r) => setTimeout(r, 1200));
const stillThere = await new Promise((resolve) => {
  const w = next(dm, 'initiative:state', 3000);
  emit(dm, 'initiative:update', { encounterId: order.id, entries: [] });
  resolve(w);
});
const same = (await stillThere)?.encounter?.entries?.find((e) => e.id === alreadyRolled.id);
// Silence rather than a refusal, deliberately: two tabs racing one button is
// one person pressing it once, and a second roll would change the number.
check('rolling an entry that is already rolled changes nothing', same?.initiative === wasAt,
  `${wasAt} -> ${same?.initiative}`);

const answered = nextWhere(dm, 'initiative:state',
  (p) => p?.encounter?.entries?.some((e) => e.name.startsWith('Thorin') && !e.pending), 4000);
emit(player, 'initiative:roll', { entryId: waiting[0].id });
check('a player rolls their own', Boolean(await answered));

const edited = next(dm, 'initiative:state', 3000);
emit(dm, 'initiative:update', { encounterId: order.id, entries: [{ id: order.entries[0].id, initiative: 25 }] });
check('a mistyped initiative can be corrected', Boolean(await edited));

const advanced = next(dm, 'initiative:state', 3000);
emit(dm, 'turn:next', {});
const turn1 = await advanced;
check('turns advance', Boolean(turn1?.encounter), `round ${turn1?.encounter?.round}, index ${turn1?.encounter?.activeIndex}`);

const back = next(dm, 'initiative:state', 3000);
emit(dm, 'turn:previous', {});
check('and go back', Boolean(await back));

const playerTurn = next(player, 'error', 2500);
emit(player, 'turn:next', {});
check('a player cannot drive the order', Boolean(await playerTurn));

const removedEntry = next(dm, 'initiative:state', 3000);
const aGoblinEntry = order.entries.find((e) => e.name.startsWith('Goblin'));
emit(dm, 'initiative:remove', { entryId: aGoblinEntry.id });
check('a combatant can be removed', Boolean(await removedEntry));

console.log('\n=== 19. movement ===');

// A player's range is clipped to ground they have explored, so give them some:
// part B ends by resetting the fog, and nothing explored means nothing to draw
// however much movement they have left.
emit(dm, 'fog:reveal', { sceneId: crypt.id });
await new Promise((r) => setTimeout(r, 1500));

const range = next(player, 'movement:range', 3000);
emit(player, 'movement:query', { tokenId: thorinToken.id });
const reach = await range;
check('a player is told their reach', (reach?.squares?.length ?? 0) > 0,
  `${reach?.squares?.length} squares, ${reach?.leftFeet ?? '?'} ft left`);

// Make sure it is somebody else's turn first, rather than assuming it: the
// order was rebuilt above and may well have landed on the character.
let someoneElse = false;
for (let i = 0; i < 8 && !someoneElse; i++) {
  const state = next(dm, 'initiative:state', 3000);
  emit(dm, 'turn:next', {});
  const enc = (await state)?.encounter;
  someoneElse = !(enc?.entries?.[enc.activeIndex]?.name?.startsWith('Thorin') ?? true);
}
const offTurn = next(player, 'error', 2500);
emit(player, 'movement:dash', { tokenId: thorinToken.id, on: true });
check('a Dash off your own turn is refused', /own turn/i.test((await offTurn)?.message ?? ''),
  'the app cannot know you took the action, so it has to be said');

// Walk the order round until it is the character's turn, then Dash.
let itIsMyTurn = false;
for (let i = 0; i < 8 && !itIsMyTurn; i++) {
  const state = next(dm, 'initiative:state', 3000);
  emit(dm, 'turn:next', {});
  const enc = (await state)?.encounter;
  itIsMyTurn = enc?.entries?.[enc.activeIndex]?.name?.startsWith('Thorin') ?? false;
}
check('the order reaches the character', itIsMyTurn);

if (itIsMyTurn) {
  const onTurn = next(player, 'movement:range', 3000);
  emit(player, 'movement:query', { tokenId: thorinToken.id });
  const base = await onTurn;

  // Dashing answers with a scene push rather than a range: everyone's overlay
  // is now wrong in one direction or the other, so the clients ask again.
  const pushed = next(player, 'scene:state', 3000);
  emit(player, 'movement:dash', { tokenId: thorinToken.id, on: true });
  check('dashing pushes the scene', Boolean(await pushed));

  const wider = next(player, 'movement:range', 3000);
  emit(player, 'movement:query', { tokenId: thorinToken.id });
  const afterDash = await wider;
  // Measured in feet, not squares. A player's range is clipped to ground they
  // have explored, and the party's room is smaller than a dash - so the budget
  // can double while the drawable squares do not move at all.
  check('and the budget is bigger when asked again',
    (afterDash?.leftFeet ?? 0) > (base?.leftFeet ?? 0),
    `${base?.leftFeet} ft -> ${afterDash?.leftFeet} ft, squares ${base?.squares?.length} -> ${afterDash?.squares?.length}`);

  // A mis-click has to be undoable, which is why it is a toggle.
  const off = next(player, 'scene:state', 3000);
  emit(player, 'movement:dash', { tokenId: thorinToken.id, on: false });
  await off;
  const back = next(player, 'movement:range', 3000);
  emit(player, 'movement:query', { tokenId: thorinToken.id });
  check('and it can be turned off again',
    ((await back)?.leftFeet ?? 0) === (base?.leftFeet ?? 0));
}

console.log('\n=== 20. group rolls ===');

const creatureRoll = nextWhere(dm, 'chat:message', (p) => Boolean(p?.message?.groupData), 3000);
emit(dm, 'chat:groupRoll', {
  kind: 'save', key: 'dex', dc: 12, secret: false, who: 'creatures', tokenIds: goblins.map((g) => g.id),
});
const creatureCard = (await creatureRoll)?.message?.groupData;
check('the DM rolls saves for their creatures', (creatureCard?.rows?.length ?? 0) === goblins.length,
  `${creatureCard?.rows?.length} rows`);
check('each row names the creature on the board', creatureCard.rows.every((r) => r.tokenId));

const askParty = nextWhere(player, 'chat:message',
  (p) => p?.message?.groupData?.rows?.some((r) => r.total === null), 3000);
emit(dm, 'chat:groupRoll', { kind: 'skill', key: 'perception', dc: 14, secret: false, who: 'party' });
const request = await askParty;
check('the party is asked rather than rolled for',
  request?.message?.groupData?.rows?.every((r) => r.total === null), 'all waiting');

const myRow = request.message.groupData.rows.find((r) => r.name.startsWith('Thorin'));
const filled = nextWhere(dm, 'chat:message',
  (p) => p?.message?.id === request.message.id && p?.message?.groupData?.rows?.some((r) => r.actorId === myRow.actorId && r.total !== null), 3000);
emit(player, 'chat:groupAnswer', { messageId: request.message.id, actorId: myRow.actorId });
check('a player answers their own row', Boolean(await filled));

console.log('\n=== 21. journal and handouts ===');

const entry = await dmApi('POST', `/api/campaigns/${campaignId}/journal`, {
  title: 'Runthrough Notes', body: 'Kept for later.',
});
check('a journal entry is written', entry.status === 200, entry.body?.entry?.title ?? entry.body?.page?.title);
const entryId = entry.body?.entry?.id ?? entry.body?.page?.id;

const pageId = entry.body.entry.pages[0].id;
const editedPage = await dmApi('PATCH', `/api/journal/pages/${pageId}`, { bodyMarkdown: 'Revised.' });
check('its page can be edited', editedPage.status === 200, String(editedPage.status));

const sharedEntry = await dmApi('POST', `/api/journal/${entryId}/share`, { shared: true });
check('and shared with the party', sharedEntry.status === 200, String(sharedEntry.status));

const playerJournal = await api(playerCookie)('GET', `/api/campaigns/${campaignId}/journal`);
const visible = (playerJournal.body.entries ?? playerJournal.body.pages ?? []).map((e) => e.title);
check('a player can now read it', visible.includes('Runthrough Notes'), JSON.stringify(visible));

const textHandout = next(player, 'handout:reveal', 1800);
emit(dm, 'handout:show', { pageId });
check('a page with no image is not a handout', (await textHandout) === null);

// A one-pixel PNG is enough to prove the upload and the reveal.
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const form = new FormData();
form.append('file', new Blob([pngBytes], { type: 'image/png' }), 'handout.png');
const uploaded = await fetch(`${BASE}/api/journal/${entryId}/pages/image`, {
  method: 'POST',
  headers: { cookie: dmCookie },
  body: form,
});
const uploadedBody = await uploaded.json().catch(() => null);
check('an image page can be uploaded', uploaded.status === 200, String(uploaded.status));

const imagePageId = uploadedBody?.page?.id ?? uploadedBody?.entry?.pages?.slice(-1)[0]?.id;
const shownHandout = next(player, 'handout:reveal', 3000);
emit(dm, 'handout:show', { pageId: imagePageId });
const reveal = await shownHandout;
check('and shown large on every screen', Boolean(reveal?.imageUrl), reveal?.imageUrl);

const playerHandout = next(player, 'error', 2500);
emit(player, 'handout:show', { pageId: imagePageId });
check('a player cannot show one', Boolean(await playerHandout));

const deletedEntry = await dmApi('DELETE', `/api/journal/${entryId}`);
check('and the entry deleted', deletedEntry.status === 200);

console.log('\n=== 22. clearing the log ===');

const clearedForPlayer = next(player, 'chat:cleared', 3000);
emit(dm, 'chat:clear', {});
check('the DM clears the log for everyone', Boolean(await clearedForPlayer));

const playerClear = next(player, 'error', 2500);
emit(player, 'chat:clear', {});
check('a player cannot', Boolean(await playerClear));

console.log('\n=== 23. levelling the party ===');

/**
 * The DM declares a level and the table hears about it once.
 *
 * Read from the *player's* socket: the banner exists so the party knows, and a
 * message only the DM receives would pass on the DM's socket while telling
 * nobody. The detail of what anybody gained is a sheet question, checked
 * against the compendium below rather than against the announcement.
 */
const playerApi = api(playerCookie);
const sheets = await playerApi('GET', '/api/actors');
const thorin = (sheets.body.actors ?? []).find((a) => a.name.startsWith('Thorin'));
check('the player has a sheet to level', Boolean(thorin), `${thorin?.name} level ${thorin?.level} ${thorin?.className}`);

if (thorin) {
  const target = thorin.level + 1;

  const announced = nextWhere(player, 'chat:message', (p) => p?.message?.kind === 'levelup', 4000);
  const levelled = await dmApi('POST', `/api/campaigns/${campaignId}/level-party`, { level: target });
  check('the DM levels the whole party at once', levelled.status === 200,
    `${levelled.body.levelled?.length} levelled, ${levelled.body.unchanged} already there`);

  const banner = await announced;
  check('and the table is told, once', Boolean(banner), banner?.message?.body ?? 'nothing posted');
  check('as a banner rather than a line of chat', banner?.message?.kind === 'levelup',
    `kind: ${banner?.message?.kind}`);
  check('reading "Level N Reached"', banner?.message?.body === `Level ${target} Reached`,
    banner?.message?.body);
  check('and filed in the conversation, not the battle log', banner?.message?.combat === false,
    `combat: ${banner?.message?.combat}`);

  // Levelling to the same place again must not re-announce it: the DM pressing
  // twice is a mis-click, not a second level.
  const again = nextWhere(player, 'chat:message', (p) => p?.message?.kind === 'levelup', 1500);
  const repeat = await dmApi('POST', `/api/campaigns/${campaignId}/level-party`, { level: target });
  check('levelling to a level already reached announces nothing', (await again) === null,
    `${repeat.body.levelled?.length} moved`);

  const player2 = await playerApi('GET', `/api/actors/${thorin.id}`);
  check('the sheet is at the new level', player2.body.actor.level === target,
    `level ${player2.body.actor.level}`);
  // Left behind on purpose: this is what makes the sheet greet them with what
  // they gained rather than the level-up passing silently.
  check('and knows it has something unread', player2.body.actor.levelAcknowledged < target,
    `acknowledged ${player2.body.actor.levelAcknowledged} of ${target}`);

  const gains = await playerApi('GET', `/api/actors/${thorin.id}/level-gains`);
  check('the sheet can say what the level granted', gains.status === 200,
    gains.body.gains?.unavailable ?? `${gains.body.gains?.features?.length} features`);
  check('read from a compendium that has the progression in it', gains.body.compendiumEmpty === false);

  const named = (gains.body.gains?.features ?? []).map((f) => f.name);
  const somethingToShow =
    named.length > 0 ||
    (gains.body.gains?.spellSlots ?? []).length > 0 ||
    (gains.body.gains?.counters ?? []).length > 0 ||
    gains.body.gains?.abilityScoreIncreases > 0 ||
    Boolean(gains.body.gains?.proficiencyBonus);
  check('and it has something to say about it', somethingToShow,
    `${named.join(', ') || 'no features'} | ASI ${gains.body.gains?.abilityScoreIncreases}`);

  // The failure mode most likely to reach a table: a feature added twice.
  if (named.length > 0) {
    const first = await playerApi('POST', `/api/actors/${thorin.id}/level-features`, {
      features: [{ name: named[0], description: 'from the runthrough' }],
    });
    const second = await playerApi('POST', `/api/actors/${thorin.id}/level-features`, {
      features: [{ name: named[0], description: 'from the runthrough' }],
    });
    check('a gained feature can be taken onto the sheet', first.body.added === 1, named[0]);
    check('and taking it twice adds nothing', second.body.added === 0 && second.body.skipped === 1,
      `added ${second.body.added}, skipped ${second.body.skipped}`);

    const sheet = await playerApi('GET', `/api/actors/${thorin.id}`);
    const copies = (sheet.body.items ?? []).filter((i) => i.type === 'feature' && i.name === named[0]);
    check('leaving exactly one on the sheet', copies.length === 1, `${copies.length} copies`);
  }

  const ack = await playerApi('POST', `/api/actors/${thorin.id}/acknowledge-level`, {});
  check('the player can mark it read', ack.body.levelAcknowledged === target,
    `acknowledged ${ack.body.levelAcknowledged}`);

  const other = await dmApi('GET', `/api/actors/${thorin.id}/level-gains?from=1&to=5`);
  check('and the gains can be asked for any two levels', other.status === 200,
    `${other.body.gains?.features?.length} features from 1 to 5`);

  /**
   * A subclass the SRD never published.
   *
   * The SRD carries exactly one per class - Champion, for a Fighter - so a
   * Battle Master has nothing to draw on and its text is copyright, which is
   * why it is written by hand rather than imported. The regression underneath
   * all of this is silent: a Battle Master being handed Champion's features
   * looks perfectly fine on screen.
   */
  await playerApi('PATCH', `/api/actors/${thorin.id}`, { subclass: '' });
  const asChampion = await playerApi('GET', `/api/actors/${thorin.id}/level-gains?from=2&to=3`);
  check('the sheet is told which subclass the compendium carries',
    asChampion.body.gains?.publishedSubclassName === 'Champion',
    String(asChampion.body.gains?.publishedSubclassName));
  // The regression the whole change exists for: with no subclass named this
  // used to hand back whatever the SRD published, and since nothing ever set
  // the field, that was everybody.
  check('but a sheet naming no subclass is given no features at all',
    (asChampion.body.gains?.subclassFeatures ?? []).length === 0,
    `${(asChampion.body.gains?.subclassFeatures ?? []).map((f) => f.name).join(', ') || 'nothing'}`);

  await playerApi('PATCH', `/api/actors/${thorin.id}`, { subclass: 'Battle Master' });
  const unwritten = await playerApi('GET', `/api/actors/${thorin.id}/level-gains?from=2&to=3`);
  check('a subclass the SRD never published is never given Champion\'s features',
    (unwritten.body.gains?.subclassFeatures ?? []).length === 0 &&
      unwritten.body.gains?.subclassSource === null,
    `source ${unwritten.body.gains?.subclassSource}`);
  check('and is reported as unknown rather than as granting nothing',
    unwritten.body.gains?.subclassKnown === false,
    `known: ${unwritten.body.gains?.subclassKnown}`);

  const wrote = await playerApi('PUT', `/api/actors/${thorin.id}/subclass-features`, {
    features: [
      { level: 3, name: 'Combat Superiority', description: 'Four superiority dice.' },
      { level: 7, name: 'Know Your Enemy', description: 'Study a creature.' },
    ],
  });
  check('a subclass can be written down', wrote.status === 200 && wrote.body.count === 2,
    `${wrote.body.count} filed under ${wrote.body.subclassName}`);
  check('filed under the subclass the sheet names, not the payload',
    wrote.body.subclassName === 'Battle Master', wrote.body.subclassName);

  const written = await playerApi('GET', `/api/actors/${thorin.id}/level-gains?from=2&to=3`);
  check('and it arrives at the level it was written for',
    (written.body.gains?.subclassFeatures ?? []).some((f) => f.name === 'Combat Superiority'),
    `source ${written.body.gains?.subclassSource}`);
  check('while a later level of it stays where it was put',
    (written.body.gains?.subclassFeatures ?? []).every((f) => f.name !== 'Know Your Enemy'));

  /**
   * The reason the subclass name rides on every row.
   *
   * Renamed to another subclass the SRD does *not* publish, deliberately.
   * Renaming to Champion proves nothing: its published rows win the tie and
   * would hide a definition leaking through underneath them.
   */
  await playerApi('PATCH', `/api/actors/${thorin.id}`, { subclass: 'Eldritch Knight' });
  const toAnother = await playerApi('GET', `/api/actors/${thorin.id}/level-gains?from=2&to=3`);
  check('a definition never follows the sheet to another subclass',
    (toAnother.body.gains?.subclassFeatures ?? []).length === 0,
    `${(toAnother.body.gains?.subclassFeatures ?? []).map((f) => f.name).join(', ') || 'nothing'}`);

  await playerApi('PATCH', `/api/actors/${thorin.id}`, { subclass: 'Champion' });
  const renamed = await playerApi('GET', `/api/actors/${thorin.id}/level-gains?from=2&to=3`);
  check('renaming the subclass stops serving the old definition',
    (renamed.body.gains?.subclassFeatures ?? []).every((f) => f.name !== 'Combat Superiority'),
    (renamed.body.gains?.subclassFeatures ?? []).map((f) => f.name).join(', ') || 'nothing');
  check('and the published one is used instead',
    renamed.body.gains?.subclassSource === 'published',
    String(renamed.body.gains?.subclassSource));

  // A published subclass at a level it grants nothing is known, not unwritten -
  // the panel told a Champion "nothing written down for Champion" otherwise.
  const quiet = await playerApi('GET', `/api/actors/${thorin.id}/level-gains?from=4&to=5`);
  check('a published subclass is known even where it grants nothing',
    quiet.body.gains?.subclassKnown === true &&
      (quiet.body.gains?.subclassFeatures ?? []).length === 0,
    `known: ${quiet.body.gains?.subclassKnown}`);

  const noSubclass = await dmApi('PUT', `/api/actors/${thorin.id}/subclass-features`, {
    features: [{ level: 3, name: 'Ought to be refused', description: '' }],
  });
  check('the DM may write a subclass on a sheet they can edit', noSubclass.status === 200,
    String(noSubclass.status));

  /**
   * A player writing on a sheet that is not theirs is the gate that matters.
   *
   * Aimed at a goblin rather than at another character: the DM's roster does
   * not list somebody else's character at all, so looking one up there found
   * nothing and skipped this check without saying so. A goblin is always on
   * the board, and a player may never edit one.
   */
  const goblinActorId = goblins.find((g) => g.actorId)?.actorId;
  const trespass = await playerApi('PUT', `/api/actors/${goblinActorId}/subclass-features`, {
    features: [{ level: 3, name: 'Not yours', description: '' }],
  });
  // 404 rather than 403, and deliberately: `requireActorWrite` answers "not
  // found" for a sheet you cannot see at all, because a 403 would confirm it
  // exists. 403 is reserved for a sheet you may read but not edit.
  check("a player cannot write one on a sheet that is not theirs", trespass.status === 404,
    `${trespass.status} against ${goblinActorId ? 'a goblin' : 'NO GOBLIN FOUND'}`);

  // A player levelling the whole party would be levelling other people's
  // characters, which is the DM's call by definition.
  const refused = await playerApi('POST', `/api/campaigns/${campaignId}/level-party`, { level: 20 });
  check('a player cannot level the party', refused.status === 403, String(refused.status));
}

console.log('\n=== 24. the fight ends with a summary ===');

/**
 * Six seconds a round, said out loud when it is over.
 *
 * The log was cleared two checks ago, so anything arriving now is this and
 * nothing else. Read from the *player's* socket deliberately: the point of the
 * summary is that the table is told, and a message the DM alone receives would
 * pass a check on the DM's socket while telling nobody.
 */
// Every goblin put down first, so the count is the encounter's rather than
// whatever happened to survive the sections above. Whichever entries are still
// in the order, they are all now on 0 hit points.
for (const goblin of goblins) {
  emit(dm, 'damage:apply', {
    tokenIds: [goblin.id], amount: 99, damageType: 'force', healing: false, halved: false,
  });
}
await new Promise((r) => setTimeout(r, 900));

const summarised = nextWhere(
  player,
  'chat:message',
  (p) => /battle summary/i.test(p?.message?.body ?? ''),
  3000,
);
emit(dm, 'encounter:end', {});
const ended = await summarised;
const summaryBody = ended?.message?.body ?? '';
const lineOf = (label) =>
  summaryBody.split('\n').find((line) => line.toLowerCase().startsWith(label)) ?? '';

check('ending the fight posts a battle summary', Boolean(ended), summaryBody || 'nothing posted');
check('filed with the fight rather than the conversation', ended?.message?.combat === true,
  `combat: ${ended?.message?.combat}`);

// Four separate facts, so four lines - a paragraph buries all of them.
check('it is written as lines rather than a sentence', summaryBody.split('\n').length === 4,
  JSON.stringify(summaryBody));

const elapsed = lineOf('time elapsed');
check('it gives the time elapsed in game', /second|m \d\ds/.test(elapsed), elapsed);

// Six seconds a round, and the whole of the round that was running counts:
// the fight took as many rounds as it ran.
const rounds = Number(summaryBody.match(/(\d+) rounds?/)?.[1] ?? 0);
const seconds = Number(elapsed.match(/(\d+) seconds?/)?.[1] ?? -1);
check('and the duration is six seconds a round', rounds > 0 && seconds === rounds * 6,
  `${rounds} rounds, ${seconds}s`);

const kills = lineOf('enemies vanquished');
const named = kills.replace(/^[^:]*:\s*/, '').split(', ').filter((n) => n.startsWith('Goblin'));
check('it names the enemies vanquished', named.length > 0, kills);

// A goblin is CR 1/4, which the handbook prices at 50. Checked against the
// names on the line above rather than a fixed total, so removing a combatant
// earlier in this part cannot make it wrong for the wrong reason.
const gain = lineOf('exp gain');
const total = Number(gain.match(/EXP gain: (\d+)/i)?.[1] ?? -1);
check('and prices them from the challenge rating', total === named.length * 50,
  `${gain} — ${named.length} goblins at 50`);
check('and divides the take across the party', /each across \d+ character/.test(gain), gain);

// Twice is a mis-press, not a second fight: there is no encounter left to
// summarise, so nothing should be posted.
const again = nextWhere(player, 'chat:message', (p) => /battle summary/i.test(p?.message?.body ?? ''), 1500);
emit(dm, 'encounter:end', {});
check('ending a fight that is already over says nothing', (await again) === null);

await new Promise((r) => setTimeout(r, 500));
emit(dm, 'campaign:leave', { campaignId });

console.log('\n================ PART C ================');
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
