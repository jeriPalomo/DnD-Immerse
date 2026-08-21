/**
 * Full runthrough, part A: accounts, campaigns, sheets, the compendium.
 *
 * Driven at the API rather than through the browser, because the question here
 * is whether every route does what it says - forty-two of them - and clicking
 * is a slow and imprecise way to ask that.
 */
const BASE = process.env.RUNTHROUGH_BASE ?? 'http://127.0.0.1:3987';

const results = [];
const covered = new Set();
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A signed-in caller, remembering its cookie. */
async function login(email, password = 'demo-password') {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return caller(cookie);
}

function caller(cookie) {
  return {
    cookie,
    async call(method, route, body, form) {
      covered.add(route.split('?')[0].replace(/\/[A-Za-z0-9_-]{15,}/g, '/:id'));
      const res = await fetch(`${BASE}${route}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: form ?? (body ? JSON.stringify(body) : undefined),
      });
      let payload = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      return { status: res.status, body: payload, headers: res.headers };
    },
  };
}

console.log('\n=== 1. accounts ===');

const anon = caller('');
const unique = Date.now();

const registered = await anon.call('POST', '/api/auth/register', {
  email: `full${unique}@test.local`,
  displayName: 'Full Runthrough',
  password: 'a-real-password-1',
});
check('register creates an account', registered.status === 200, JSON.stringify(registered.body?.user?.displayName));

const dup = await anon.call('POST', '/api/auth/register', {
  email: `full${unique}@test.local`,
  displayName: 'Again',
  password: 'a-real-password-1',
});
check('a duplicate email is refused', dup.status === 409, dup.body?.error);

const weak = await anon.call('POST', '/api/auth/register', {
  email: `weak${unique}@test.local`,
  displayName: 'Weak',
  password: 'short',
});
check('a short password is refused', weak.status === 400);

const wrong = await anon.call('POST', '/api/auth/login', {
  email: 'dm@example.com',
  password: 'not-the-password',
});
check('a wrong password is refused', wrong.status === 401, wrong.body?.error);

const unknown = await anon.call('POST', '/api/auth/login', {
  email: 'nobody@nowhere.local',
  password: 'whatever12345',
});
check('an unknown email gives the same answer', unknown.status === 401 && unknown.body?.error === wrong.body?.error);

const dm = await login('dm@example.com');
const thorin = await login('thorin@example.com');
const elaria = await login('elaria@example.com');

const me = await dm.call('GET', '/api/auth/me');
check('me returns the signed-in user', me.body?.user?.email === 'dm@example.com', me.body?.user?.displayName);
check('me reports whether they run any campaign', me.body?.user?.dmOfAny === true, String(me.body?.user?.dmOfAny));

const meAnon = await anon.call('GET', '/api/auth/me');
check('me refuses an unauthenticated caller', meAnon.status === 401 || meAnon.body?.user === null, String(meAnon.status));

const newAccount = await login(`full${unique}@test.local`, 'a-real-password-1');
const changed = await newAccount.call('POST', '/api/auth/me/password', {
  currentPassword: 'a-real-password-1',
  newPassword: 'a-different-one-2',
});
check('a password can be changed', changed.status === 200, String(changed.status));
const badChange = await newAccount.call('POST', '/api/auth/me/password', {
  currentPassword: 'a-real-password-1',
  newPassword: 'nope-nope-nope',
});
check('changing it needs the current one', badChange.status === 400, badChange.body?.error);
const reLogin = await anon.call('POST', '/api/auth/login', {
  email: `full${unique}@test.local`,
  password: 'a-different-one-2',
});
check('the new password works', reLogin.status === 200);

const loggedOut = await newAccount.call('POST', '/api/auth/logout');
check('logout succeeds', loggedOut.status === 200);
const afterLogout = await newAccount.call('GET', '/api/auth/me');
check('and the session is dead', afterLogout.status === 401 || afterLogout.body?.user === null);

console.log('\n=== 2. campaigns ===');

const list = await dm.call('GET', '/api/campaigns');
const campaignId = list.body.campaigns[0].id;
check('the DM lists their campaigns', list.body.campaigns.length >= 1, `${list.body.campaigns.length}`);

const detail = await dm.call('GET', `/api/campaigns/${campaignId}`);
check('a campaign reads back with its invite code', Boolean(detail.body?.campaign?.inviteCode), detail.body?.campaign?.name);

const patched = await dm.call('PATCH', `/api/campaigns/${campaignId}`, {
  description: 'Mists close in.',
  playersSeeEnemyStats: true,
});
check('the DM can edit campaign settings', patched.status === 200);

const playerPatch = await thorin.call('PATCH', `/api/campaigns/${campaignId}`, { name: 'Mine now' });
check('a player cannot edit the campaign', playerPatch.status === 403, playerPatch.body?.error);

const members = await dm.call('GET', `/api/campaigns/${campaignId}/members`);
check('members are listed', (members.body?.members?.length ?? 0) >= 4, `${members.body?.members?.length} members`);

const oldCode = detail.body.campaign.inviteCode;
const rotated = await dm.call('POST', `/api/campaigns/${campaignId}/invite/rotate`);
check('the invite code rotates', rotated.status === 200 && rotated.body?.campaign?.inviteCode !== oldCode, rotated.body?.campaign?.inviteCode);

const staleJoin = await anon.call('POST', '/api/campaigns/join', { inviteCode: oldCode });
check('the old code stops working', staleJoin.status !== 200, String(staleJoin.status));

const playerRotate = await thorin.call('POST', `/api/campaigns/${campaignId}/invite/rotate`);
check('a player cannot rotate it', playerRotate.status === 403);

const madeCampaign = await thorin.call('POST', '/api/campaigns', { name: "Thorin's Own Table" });
check('anyone can start their own campaign', madeCampaign.status === 200, madeCampaign.body?.campaign?.name);
const removed = await thorin.call('DELETE', `/api/campaigns/${madeCampaign.body.campaign.id}`);
check('and delete it', removed.status === 200);

console.log('\n=== 3. characters ===');

const mine = await thorin.call('GET', '/api/actors');
const thorinActor = mine.body.actors.find((a) => a.type === 'character');
check('a player lists their own characters', Boolean(thorinActor), thorinActor?.name);

const sheet = await thorin.call('GET', `/api/actors/${thorinActor.id}`);
check('the sheet loads with its items', (sheet.body?.items?.length ?? 0) > 0, `${sheet.body.items.length} items`);

const madeChar = await elaria.call('POST', '/api/actors', { name: 'Test Bard', type: 'character' });
check('a player can create a character', madeChar.status === 200, madeChar.body?.actor?.name);
const charId = madeChar.body.actor.id;

const edited = await elaria.call('PATCH', `/api/actors/${charId}`, {
  className: 'Bard', race: 'Half-Elf', level: 3, str: 10, dex: 16, con: 12, int: 13, wis: 11, cha: 17,
});
check('and edit it', edited.status === 200 && edited.body?.actor?.level === 3);

const otherEdit = await thorin.call('PATCH', `/api/actors/${charId}`, { name: 'Stolen' });
check("a player cannot edit somebody else's character", [403, 404].includes(otherEdit.status), `${otherEdit.status} ${otherEdit.body?.error}`);

const levelHp = await elaria.call('POST', `/api/actors/${charId}/level-hit-points`, { method: 'average' });
check('levelling rolls or averages hit points', levelHp.status === 200, JSON.stringify(levelHp.body?.actor?.hpMax));

const assigned = await elaria.call('POST', `/api/actors/${charId}/campaigns/${campaignId}`);
check('a character can be assigned to a campaign', assigned.status === 200);
const inCampaign = await dm.call('GET', `/api/campaigns/${campaignId}/actors`);
check('and shows in the campaign roster', inCampaign.body.actors.some((a) => a.id === charId));
const shared = await elaria.call('PUT', `/api/actors/${charId}/ownership/${me.body.user.id}`, { level: 2 });
check('a sheet can be shared with somebody in the campaign', shared.status === 200, String(shared.status));

const strangerId = registered.body?.user?.id;
const leaked = await elaria.call('PUT', `/api/actors/${charId}/ownership/${strangerId}`, { level: 2 });
check('but not with somebody outside it', leaked.status !== 200, String(leaked.status));

const unassigned = await elaria.call('DELETE', `/api/actors/${charId}/campaigns/${campaignId}`);
check('and can be taken out again', unassigned.status === 200);

console.log('\n=== 4. items and spells ===');

const madeItem = await elaria.call('POST', `/api/actors/${charId}/items`, {
  name: 'Test Rapier', type: 'weapon',
  system: { damageDice: '1d8', damageType: 'piercing', ability: 'dex', proficient: true },
});
check('an item can be written by hand', madeItem.status === 200, madeItem.body?.item?.name);
const itemId = madeItem.body.item.id;

const equipped = await elaria.call('PATCH', `/api/items/${itemId}`, { system: { equipped: true } });
check('an item can be equipped', equipped.status === 200);

const emptyPatch = await elaria.call('PATCH', `/api/items/${itemId}`, {});
check('an empty patch does not throw', emptyPatch.status < 500, `status ${emptyPatch.status}`);

const srdItem = await elaria.call('GET', '/api/compendium/items?q=Longsword&limit=1');
const fromSrd = await elaria.call('POST', `/api/actors/${charId}/items/from-srd`, {
  srdId: srdItem.body.items[0].id, kind: 'item',
});
check('gear can be taken from the compendium', fromSrd.status === 200, srdItem.body.items[0].name);

const srdSpell = await elaria.call('GET', '/api/compendium/spells?q=Cure%20Wounds&limit=1');
const spellAdded = await elaria.call('POST', `/api/actors/${charId}/items/from-srd`, {
  srdId: srdSpell.body.spells[0].id, kind: 'spell',
});
check('and spells too', spellAdded.status === 200, srdSpell.body.spells[0].name);

const deletedItem = await elaria.call('DELETE', `/api/items/${itemId}`);
check('an item can be deleted', deletedItem.status === 200);

console.log('\n=== 5. rest and death saves ===');

await elaria.call('PATCH', `/api/actors/${charId}`, { hpCurrent: 1 });
const shortRest = await elaria.call('POST', `/api/actors/${charId}/rest`, { type: 'short', hitDice: 1 });
check('a short rest is accepted', shortRest.status === 200, String(shortRest.status));
const longRest = await elaria.call('POST', `/api/actors/${charId}/rest`, { type: 'long' });
const afterRest = await elaria.call('GET', `/api/actors/${charId}`);
check('a long rest fills hit points', afterRest.body.actor.hpCurrent === afterRest.body.actor.hpMax,
  `${afterRest.body.actor.hpCurrent}/${afterRest.body.actor.hpMax}`);
check('the rest route reports what it restored', longRest.status === 200);

console.log('\n=== 6. the compendium ===');

for (const [what, route, key] of [
  ['monsters', '/api/compendium/monsters?limit=3', 'monsters'],
  ['spells', '/api/compendium/spells?limit=3', 'spells'],
  ['items', '/api/compendium/items?limit=3', 'items'],
]) {
  const page = await dm.call('GET', route);
  check(`${what} page`, page.body[key]?.length === 3 && page.body.more === true, `more=${page.body.more}`);
}

const secondPage = await dm.call('GET', '/api/compendium/monsters?limit=3&offset=3');
const firstPage = await dm.call('GET', '/api/compendium/monsters?limit=3');
check('the second page does not repeat the first',
  secondPage.body.monsters[0].id !== firstPage.body.monsters[0].id);

for (const category of ['weapon', 'armor', 'gear', 'tools', 'consumable', 'magic', 'vehicle']) {
  const shelf = await dm.call('GET', `/api/compendium/items?category=${category}&limit=3`);
  check(`the ${category} shelf answers`, shelf.status === 200 && Array.isArray(shelf.body.items),
    `${shelf.body.items?.length ?? 0} shown`);
}

const badShelf = await dm.call('GET', '/api/compendium/items?category=nonsense');
check('an unknown shelf is refused rather than returning everything', badShelf.status === 400, String(badShelf.status));

const byClass = await dm.call('GET', '/api/compendium/spells?className=Wizard&level=3&limit=5');
check('spells filter by class and level', byClass.body.spells?.length > 0, `${byClass.body.spells?.length}`);

const oneMonster = await dm.call('GET', `/api/compendium/monsters/${firstPage.body.monsters[0].id}`);
check('one monster reads back in full', Boolean(oneMonster.body?.monster?.data), oneMonster.body?.monster?.name);

for (const difficulty of ['easy', 'medium', 'hard', 'deadly']) {
  const rec = await dm.call('GET', `/api/campaigns/${campaignId}/encounter-suggestions?difficulty=${difficulty}`);
  check(`${difficulty} encounters are suggested`, (rec.body.suggestions?.length ?? 0) > 0,
    `${rec.body.suggestions?.length} options, party of ${rec.body.party?.length}`);
}

console.log('\n=== 7. NPCs and the bestiary lock ===');

const npc = await dm.call('POST', '/api/actors', { name: 'Hand-written Innkeeper', type: 'npc', campaignId });
check('the DM can write an NPC by hand', npc.status === 200);
const handEdit = await dm.call('PATCH', `/api/actors/${npc.body.actor.id}`, { str: 18 });
check('and edit its scores freely', handEdit.status === 200 && handEdit.body.actor.str === 18);

const goblinRow = await dm.call('GET', '/api/compendium/monsters?q=Goblin&limit=20');
const goblinId = goblinRow.body.monsters.find((m) => m.name === 'Goblin').id;
const stamped = await dm.call('POST', `/api/campaigns/${campaignId}/actors/from-monster`, { monsterId: goblinId });
check('a monster stamps from the bestiary', stamped.status === 200, stamped.body?.actor?.name);
const stampedSheet = await dm.call('GET', `/api/actors/${stamped.body.actor.id}`);
check('with its actions', (stampedSheet.body.items?.length ?? 0) > 0, `${stampedSheet.body.items.length} actions`);
check('and its art', Boolean(stampedSheet.body.actor.portraitUrl), stampedSheet.body.actor.portraitUrl);
const lockTry = await dm.call('PATCH', `/api/actors/${stamped.body.actor.id}`, { str: 30 });
check('its stat block is locked', lockTry.status === 400, lockTry.body?.error?.slice(0, 60));

const playerNpc = await thorin.call('POST', '/api/actors', { name: 'Sneaky', type: 'npc', campaignId });
check('a player cannot create an NPC', playerNpc.status !== 200, String(playerNpc.status));

console.log('\n================ PART A ================');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}
console.log(`\nroutes exercised: ${covered.size}`);

export const summary = {
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok),
};
