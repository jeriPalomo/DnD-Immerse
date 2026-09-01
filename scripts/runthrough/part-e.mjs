/**
 * Part E: the canvas, driven with a real mouse.
 *
 * Everything else in this runthrough speaks to the server directly, which is
 * the precise way to ask whether a rule holds. It cannot ask whether a *click*
 * ever reaches that rule - and the board is a single `<canvas>`, so there is no
 * element to target and nothing a selector can find. That gap is not
 * theoretical: the placeholder drawn when no map is uploaded was missing one
 * name, and it swallowed every click on the board. Walls, pins, pings and
 * click-to-deselect all silently did nothing, and no test noticed.
 *
 * The transform is computed rather than guessed. `fitToMap` centres the map at
 * `min(containerW/mapW, containerH/mapH, 1)`, so pressing Fit makes the view
 * deterministic and a grid square converts to a screen pixel exactly.
 *
 * Playwright drives the mouse; a socket connected from here reads back what the
 * server actually did, because "the canvas looks right" is not the claim.
 */
import { chromium } from 'playwright';
import { io } from 'socket.io-client';

const BASE = process.env.RUNTHROUGH_BASE ?? 'http://127.0.0.1:3987';

const results = [];
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

const call = (cookie) => async (method, route, body) => {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

function next(socket, event, timeoutMs = 4000) {
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

const dmCookie = await login('dm@example.com');
const dm = call(dmCookie);
const campaignId = (await dm('GET', '/api/campaigns')).body.campaigns[0].id;
const scenes = await dm('GET', `/api/campaigns/${campaignId}/scenes`);
const scene = scenes.body.scenes.find((s) => s.name === 'The Sunken Crypt');

// A listener, so every claim below is checked against what the server stored
// rather than against what the canvas appears to show.
const watcher = await new Promise((resolve) => {
  const s = io(BASE, { extraHeaders: { cookie: dmCookie }, transports: ['websocket'] });
  s.on('connect', () => resolve(s));
});
watcher.emit('campaign:join', { campaignId });
await new Promise((r) => setTimeout(r, 1000));

/**
 * A browser that will not start is not a failing product.
 *
 * The other four parts need no browser at all, so a missing Edge must not take
 * the whole runthrough down with a stack trace. Reported as skipped, with the
 * reason, and the suite carries on.
 */
let browser = null;
try {
  browser = await chromium.launch({ channel: 'msedge' });
} catch (error) {
  const why = error instanceof Error ? error.message.split(String.fromCharCode(10))[0] : String(error);
  console.log(`  SKIPPED — no browser to drive: ${why}`);
  watcher.close();
}

if (browser) {
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 130)));

await page.goto(BASE);
await page.fill('input[type=email]', 'dm@example.com');
await page.fill('input[type=password]', 'demo-password');
await page.click('button[type=submit]');
await page.waitForTimeout(2200);
await page.goto(`${BASE}/campaigns/${campaignId}/table`);
await page.waitForTimeout(3500);

// Fit first: it is the one view state that can be computed from the outside.
await page.locator('button', { hasText: /^Fit$/ }).first().click();
await page.waitForTimeout(900);

const canvas = await page.locator('canvas').first().boundingBox();
const scale = Math.min(canvas.width / scene.mapWidth, canvas.height / scene.mapHeight, 1);
const originX = canvas.x + (canvas.width - scene.mapWidth * scale) / 2;
const originY = canvas.y + (canvas.height - scene.mapHeight * scale) / 2;

/** A grid coordinate, as a point on the screen. */
const at = (gx, gy) => ({
  x: originX + (gx * scene.gridSize + scene.gridOffsetX) * scale,
  y: originY + (gy * scene.gridSize + scene.gridOffsetY) * scale,
});
/** The middle of a square, for anything that wants the square rather than its corner. */
const middleOf = (gx, gy) => at(gx + 0.5, gy + 0.5);

check('the board is on screen and measured', canvas.width > 200 && scale > 0,
  `canvas ${Math.round(canvas.width)}x${Math.round(canvas.height)}, scale ${scale.toFixed(3)}`);

/** The DM's own view of the board, which is where walls and pins live. */
async function boardNow() {
  const state = await new Promise((resolve) => {
    const w = next(watcher, 'scene:state', 4000);
    watcher.emit('scene:activate', { sceneId: scene.id });
    resolve(w);
  });
  const payload = await state;
  return { walls: payload?.walls ?? [], notes: payload?.notes ?? [], tokens: payload?.tokens ?? [] };
}
const wallsNow = async () => (await boardNow()).walls;

console.log('\n=== 27. clicking walls onto the board ===');

await page.getByRole('tab', { name: 'Map', exact: true }).click();
await page.waitForTimeout(600);
await page.locator('button', { hasText: /^vision$/i }).first().click();
await page.waitForTimeout(600);

const before = await wallsNow();
await page.getByRole('button', { name: 'Wall', exact: true }).click();
await page.waitForTimeout(300);

// Two corners of the empty south-east of the crypt, well away from the walls
// the seed already drew.
const a = at(16, 10);
const b = at(18, 10);
await page.mouse.click(a.x, a.y);
await page.waitForTimeout(400);
await page.mouse.click(b.x, b.y);
await page.waitForTimeout(1200);

const afterWall = await wallsNow();
const drawn = afterWall.find((w) => !before.some((old) => old.id === w.id));
check('a click lands a wall on the board', Boolean(drawn), `${afterWall.length - before.length} added`);
check('and it lands on the squares that were clicked',
  drawn && drawn.x1 === 16 && drawn.y1 === 10 && drawn.x2 === 18 && drawn.y2 === 10,
  drawn ? `(${drawn.x1},${drawn.y1}) → (${drawn.x2},${drawn.y2})` : 'nothing drawn');

console.log('\n=== 28. the erase tool ===');

await page.locator('button', { hasText: /^Erase$/ }).first().click();
await page.waitForTimeout(300);
const middle = at(17, 10);
await page.mouse.click(middle.x, middle.y);
await page.waitForTimeout(1200);

const afterErase = await wallsNow();
check('clicking a wall with Erase removes it',
  drawn && !afterErase.some((w) => w.id === drawn.id),
  `${afterErase.length} walls left`);

console.log('\n=== 29. dropping a pin ===');

// Clear the square first. A pin left by a previous run sits under the click,
// and the pin layer handles it before the board does - so the second run
// toggles the old pin instead of dropping a new one and reports that nothing
// happened. Every part of this file has to be runnable twice.
for (const old of (await boardNow()).notes) {
  await dm('DELETE', `/api/notes/${old.id}`);
}
await new Promise((r) => setTimeout(r, 600));

const notesBefore = (await boardNow()).notes;
await page.getByRole('button', { name: 'Pin', exact: true }).click();
await page.waitForTimeout(300);
const pinAt = middleOf(16, 11);
await page.mouse.click(pinAt.x, pinAt.y);
await page.waitForTimeout(1600);

const notesAfter = (await boardNow()).notes;
const pin = notesAfter.find((n) => !notesBefore.some((old) => old.id === n.id));
check('a click drops a pin', Boolean(pin), `${notesAfter.length - notesBefore.length} added`);
check('where it was clicked', pin && Math.abs(pin.x - 16.5) <= 0.5 && Math.abs(pin.y - 11.5) <= 0.5,
  pin ? `(${pin.x}, ${pin.y})` : 'none');
if (pin) await dm('DELETE', `/api/notes/${pin.id}`);

console.log('\n=== 30. painting ground with the mouse ===');

await page.getByRole('button', { name: 'Block', exact: true }).click();
await page.waitForTimeout(300);

const painted = next(watcher, 'terrain:state', 4000);
const from = middleOf(15, 12);
const to = middleOf(17, 12);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 6 });
await page.mouse.move(to.x, to.y, { steps: 6 });
await page.mouse.up();
const terrain = await painted;
check('dragging the brush paints ground', Boolean(terrain), terrain ? 'terrain pushed' : 'nothing painted');
const blocked = terrain?.terrain?.blocked ?? [];
check('and the squares dragged over are the blocked ones',
  blocked.some(([x, y]) => y === 12 && x >= 15 && x <= 17),
  JSON.stringify(blocked.filter(([, y]) => y === 12)));

console.log('\n=== 31. panning while a tool is selected ===');

/**
 * The gesture that exists because the tools took the other one.
 *
 * With a ground brush out, the Stage's own dragging is off - left-drag paints -
 * so before right-drag there was no way to reach another part of a big map
 * except zooming out and back in. Measured rather than probed: pan right by a
 * known two squares, then paint at the screen point that *was* square (15, 13),
 * and the server should store (13, 13). The board having moved by exactly the
 * distance dragged is the claim, and a stored square is the only place it can
 * be read from outside the browser.
 */
const panBy = 2 * scene.gridSize * scale;
const panStart = middleOf(10, 8);

await page.mouse.move(panStart.x, panStart.y);
await page.mouse.down({ button: 'right' });
await page.mouse.move(panStart.x + panBy / 2, panStart.y, { steps: 6 });
await page.mouse.move(panStart.x + panBy, panStart.y, { steps: 6 });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(400);

const afterPan = next(watcher, 'terrain:state', 4000);
const wasAt = middleOf(15, 13);
await page.mouse.move(wasAt.x, wasAt.y);
await page.mouse.down();
await page.mouse.move(wasAt.x + 2, wasAt.y, { steps: 2 });
await page.mouse.up();
const panned = await afterPan;
const paintedRow = (panned?.terrain?.blocked ?? []).filter(([, y]) => y === 13);

check('the brush still paints after a right-drag', Boolean(panned),
  panned ? 'terrain pushed after the pan' : 'nothing painted');
check('and right-drag panned the board by exactly the distance dragged',
  paintedRow.some(([x]) => x === 13),
  paintedRow.length ? `row 13 holds ${JSON.stringify(paintedRow)}, wanted x=13` : 'nothing on row 13');

// Undo the paint, or every run leaves another square of rubble behind.
for (const [x, y] of paintedRow) {
  watcher.emit('terrain:paint', { sceneId: scene.id, kind: 'clear', squares: [[x, y]] });
}
await new Promise((r) => setTimeout(r, 400));

// Back to the fitted view, which is the transform every later section computes
// its clicks from.
await page.locator('button', { hasText: /^Fit$/ }).first().click();
await page.waitForTimeout(900);

/**
 * A pan may start over a creature, and must not pick it up.
 *
 * Middle-drag rather than right, because middle is the button that could
 * actually have gone wrong: Konva's `dragButtons` defaults to left *and*
 * middle, so before that was narrowed a middle-drag meant to shift the map
 * walked whatever creature it started over across the board. A right-drag was
 * never in that list, so pressing it here would prove nothing.
 */
const panTokens = (await boardNow()).tokens;
const bystander = panTokens.find((t) => t.name === 'Goblin');
if (bystander) {
  const onCreature = middleOf(bystander.x, bystander.y);
  const moved = next(watcher, 'token:updated', 2000);
  await page.mouse.move(onCreature.x, onCreature.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(onCreature.x + panBy, onCreature.y, { steps: 8 });
  await page.mouse.up({ button: 'middle' });
  const stirred = await moved;
  check('middle-dragging from a creature never walks it', stirred === null,
    stirred ? `the token moved to ${stirred.token?.x},${stirred.token?.y}` : 'the creature stayed put');
  await page.locator('button', { hasText: /^Fit$/ }).first().click();
  await page.waitForTimeout(900);
}

console.log('\n=== 32. selecting and dragging a token ===');

await page.getByRole('button', { name: 'Off', exact: true }).click();
await page.waitForTimeout(300);
await page.getByRole('tab', { name: 'Combat', exact: true }).click();
await page.waitForTimeout(600);

const board = (await boardNow()).tokens;
const goblin = board.find((t) => t.name === 'Goblin');
check('there is a creature to pick up', Boolean(goblin), `${goblin?.name} at ${goblin?.x},${goblin?.y}`);

if (goblin) {
  const onIt = middleOf(goblin.x, goblin.y);
  await page.mouse.click(onIt.x, onIt.y);
  await page.waitForTimeout(1000);
  const panel = await page.locator('body').innerText();
  check('clicking a creature selects it', panel.includes('Conditions') || panel.includes('RING'),
    'the token panel opened');

  // One square left, which is open floor inside the goblins' room.
  const target = { gx: goblin.x - 1, gy: goblin.y };
  const drop = middleOf(target.gx, target.gy);
  const committed = next(watcher, 'token:updated', 5000);

  await page.mouse.move(onIt.x, onIt.y);
  await page.mouse.down();
  await page.mouse.move((onIt.x + drop.x) / 2, onIt.y, { steps: 8 });
  await page.mouse.move(drop.x, drop.y, { steps: 8 });
  await page.mouse.up();

  const landed = await committed;
  check('dragging it commits a move', Boolean(landed?.token), landed ? 'token:updated received' : 'no commit');
  check('and it lands on the square it was dropped on',
    landed?.token?.x === target.gx && landed?.token?.y === target.gy,
    landed ? `dropped at ${target.gx},${target.gy}, landed at ${landed.token.x},${landed.token.y}` : 'none');

  // Put it back. Left where it was dropped, each run walks the goblin one more
  // square west until it reaches the wall and the drag is refused.
  watcher.emit('token:commit', { tokenId: goblin.id, x: goblin.x, y: goblin.y });
  await new Promise((r) => setTimeout(r, 600));
}

console.log('\n=== 33. opening a door by clicking it ===');

const doorBefore = (await wallsNow()).find((w) => w.door === 1);
check('the crypt has a door to click', Boolean(doorBefore),
  doorBefore ? `(${doorBefore.x1},${doorBefore.y1})-(${doorBefore.x2},${doorBefore.y2}) state ${doorBefore.doorState}` : 'none');

if (doorBefore) {
  const onDoor = at((doorBefore.x1 + doorBefore.x2) / 2, (doorBefore.y1 + doorBefore.y2) / 2);
  const toggled = next(watcher, 'door:updated', 4000);
  await page.mouse.click(onDoor.x, onDoor.y);
  const doorEvent = await toggled;
  check('clicking a door opens it', doorEvent?.door?.doorState === 1,
    `state ${doorBefore.doorState} → ${doorEvent?.door?.doorState}`);

  const shut = next(watcher, 'door:updated', 4000);
  await page.mouse.click(onDoor.x, onDoor.y);
  check('and clicking it again shuts it', (await shut)?.door?.doorState === 0);
}

console.log('\n=== 34. a scene with no map, which is the first one anybody makes ===');

/**
 * The bug this whole file exists for.
 *
 * The placeholder rectangle drawn when no map is uploaded was missing
 * `name="map"`, and it covers the entire board - so the stage's click handler,
 * which accepts the stage itself or the map, saw neither and bailed. Walls,
 * pins, pings and click-to-deselect all silently did nothing on a grid-only
 * scene, which is exactly what a DM makes before they have found a map.
 *
 * `fitToMap` returns early with no map, so the view stays at scale 1 with no
 * offset - which makes the arithmetic here simpler, not harder.
 */
const bare = await dm('POST', `/api/campaigns/${campaignId}/scenes`, {
  name: 'Grid Only', gridSize: 70, width: 20, height: 14,
});
const bareId = bare.body.scene.id;
watcher.emit('scene:activate', { sceneId: bareId });
await new Promise((r) => setTimeout(r, 1500));
await page.reload();
await page.waitForTimeout(3500);

await page.getByRole('tab', { name: 'Map', exact: true }).click();
await page.waitForTimeout(600);
await page.locator('button', { hasText: /^vision$/i }).first().click();
await page.waitForTimeout(600);
await page.getByRole('button', { name: 'Wall', exact: true }).click();
await page.waitForTimeout(400);

const bareCanvas = await page.locator('canvas').first().boundingBox();
const bareAt = (gx, gy) => ({
  x: bareCanvas.x + gx * bare.body.scene.gridSize,
  y: bareCanvas.y + gy * bare.body.scene.gridSize,
});

const p1 = bareAt(2, 2);
const p2 = bareAt(4, 2);
await page.mouse.click(p1.x, p1.y);
await page.waitForTimeout(400);
await page.mouse.click(p2.x, p2.y);
await page.waitForTimeout(1400);

const bareState = await new Promise((resolve) => {
  const w = next(watcher, 'scene:state', 4000);
  watcher.emit('scene:activate', { sceneId: bareId });
  resolve(w);
});
const bareWalls = (await bareState)?.walls ?? [];
check('a grid-only scene still takes a wall', bareWalls.length > 0, `${bareWalls.length} walls`);
check('on the squares that were clicked',
  bareWalls.some((w) => w.x1 === 2 && w.y1 === 2 && w.x2 === 4 && w.y2 === 2),
  bareWalls.map((w) => `(${w.x1},${w.y1})-(${w.x2},${w.y2})`).join(' '));

await dm('DELETE', `/api/scenes/${bareId}`);
watcher.emit('scene:activate', { sceneId: scene.id });
await new Promise((r) => setTimeout(r, 800));

/**
 * The DM's two-click swing, and switching which creature is swinging.
 *
 * Only a browser can see this: it is entirely about where a click is routed,
 * and the board is one `<canvas>` that no selector reaches. Clicking a
 * creature the DM runs used to adopt it only the *first* time - every click
 * after that targeted instead, so playing a second goblin silently aimed the
 * first at it and the panel read "Targeting Goblin 2" with Goblin 1's scimitar
 * underneath, one press from a swing nobody asked for.
 */
console.log('\n=== 35. the DM picks who is swinging, then what at ===');
{
  watcher.emit('scene:activate', { sceneId: scene.id });
  await new Promise((r) => setTimeout(r, 800));
  await page.locator('button', { hasText: /^Fit$/ }).first().click();
  await page.waitForTimeout(900);

  const cast = (await boardNow()).tokens;
  const one = cast.find((t) => t.name === 'Goblin');
  const two = cast.find((t) => t.name === 'Goblin 2');
  const hero = cast.find((t) => t.name?.startsWith('Thorin'));

  const clickToken = async (t) => {
    const p = middleOf(t.x, t.y);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(700);
    return page.locator('body').innerText();
  };

  if (one && two && hero) {
    const afterFirst = await clickToken(one);
    check('clicking your own creature plays it rather than aiming at it',
      afterFirst.includes('Playing') && !afterFirst.includes('Targeting'),
      afterFirst.includes('Targeting') ? 'it opened a target panel' : 'Playing, no target');

    // The half that was broken: a second creature must take over as the one
    // swinging, not become the thing swung at.
    const afterSecond = await clickToken(two);
    check('clicking a second creature moves who is playing, not who is targeted',
      afterSecond.includes('Playing') && !afterSecond.includes('Targeting'),
      afterSecond.includes('Targeting') ? 'it aimed the first goblin at the second' : 'Playing moved');

    const afterHero = await clickToken(hero);
    check('clicking a character aims at them', afterHero.includes('Targeting'),
      afterHero.includes('Targeting') ? 'target panel open' : 'nothing targeted');
    check('and names them', /Targeting[\s\S]{0,40}Thorin/.test(afterHero),
      afterHero.includes('Thorin') ? 'Thorin named' : 'no name');

    // Friendly fire is the escape hatch, and it is the same modifier a player
    // already uses to aim at their own party.
    // Held on the keyboard, not passed to `mouse.click` - its options are
    // button/clickCount/delay and it silently ignores `modifiers`, so that
    // spelling sent a plain click and the check blamed the app for not
    // targeting when nothing had ever pressed Shift.
    const p = middleOf(one.x, one.y);
    await page.keyboard.down('Shift');
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(700);
    const afterShift = await page.locator('body').innerText();
    const around = afterShift.slice(Math.max(0, afterShift.indexOf('Targeting')), afterShift.indexOf('Targeting') + 60).replace(/\s+/g, ' ');
    check('shift-click aims at your own creature', /Targeting[\s\S]{0,40}Goblin/.test(afterShift), around);
  } else {
    check('the crypt has two goblins and a character to click (skipped)', true,
      `goblin=${Boolean(one)} goblin2=${Boolean(two)} hero=${Boolean(hero)}`);
  }
}

check('nothing threw while all that was clicked', pageErrors.length === 0,
  pageErrors.length ? pageErrors[0] : 'no page errors');

console.log('\n================ PART E ================');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nFAILED:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
}

await browser.close();
watcher.close();
}

export const summary = {
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok),
};
