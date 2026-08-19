/**
 * Opens the table twice: once as you, once as a player.
 *
 * The player's side of this app is the half that cannot be checked from the
 * DM's chair, and two real bugs proved it - a stat block route that handed one
 * player another's inventory, and monster attacks that were unreachable because
 * the DM was acting as the wrong creature. Both were invisible until somebody
 * logged in as a player. This makes that one command instead of six steps.
 *
 * Nothing here touches `data/`. The database lives in a throwaway directory
 * under the system temp folder, rebuilt on every run; the SRD cache is copied
 * in once and reused, so the import is offline and quick.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(os.tmpdir(), 'dnd-immerse-playtest');
const PORT = Number(process.env.PLAYTEST_PORT ?? 3999);
const BASE = `http://localhost:${PORT}`;
const PASSWORD = 'demo-password';

/** Left of the screen is the DM; the player sits to the right. */
const WINDOW = { width: 960, height: 1040 };

function run(label, command, args, env = {}) {
  process.stdout.write(`  ${label}... `);
  // `npm.cmd` directly rather than `shell: true`: passing args through a shell
  // means they are concatenated rather than escaped, which node now warns
  // about, and there is no reason to hand these to cmd at all.
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    console.log('failed\n');
    process.stdout.write(String(result.stdout ?? ''));
    process.stderr.write(String(result.stderr ?? ''));
    process.exit(1);
  }
  console.log('ok');
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the server never answered on ${BASE}`);
}

/** Signs in and lands at the campaign table, ready to click. */
async function openAs(browser, email, position) {
  // A context each, or both windows share one cookie jar and you are the same
  // person twice - which is the whole thing this script exists to avoid.
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL('**/campaigns', { timeout: 20_000 });

  const campaignId = await page.evaluate(async () => {
    const res = await fetch('/api/campaigns');
    return (await res.json()).campaigns[0]?.id ?? null;
  });
  if (campaignId) {
    await page.goto(`${BASE}/campaigns/${campaignId}/table`, { waitUntil: 'networkidle' });
  }

  await page.evaluate(
    ([x, y, w, h]) => window.moveTo(x, y) ?? window.resizeTo(w, h),
    [position, 0, WINDOW.width, WINDOW.height],
  );
  return page;
}

console.log('\nPlaytest: your table, and a player\'s, side by side.\n');

// A clean database every run, but keep the SRD cache - re-downloading 334
// monster portraits to look at a menu would be silly.
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.rmSync(path.join(DATA_DIR, 'app.db'), { force: true });

const srdSource = path.join(ROOT, 'data', 'srd');
const srdTarget = path.join(DATA_DIR, 'srd');
if (!fs.existsSync(srdTarget) && fs.existsSync(srdSource)) {
  process.stdout.write('  copying the SRD cache... ');
  fs.cpSync(srdSource, srdTarget, { recursive: true });
  console.log('ok');
} else if (!fs.existsSync(srdSource) && !fs.existsSync(srdTarget)) {
  console.log('  no SRD cache found - the import will download it once.');
}

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

run('building', NPM, ['run', 'build']);
run('importing the compendium', NPM, ['run', 'srd:import'], { DATA_DIR });
run('seeding a campaign', NPM, ['run', 'seed'], { DATA_DIR });

const server = spawn('node', ['apps/server/dist/index.js'], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR, PORT: String(PORT), NODE_ENV: 'production' },
  stdio: 'ignore',
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.kill();
  console.log('\nStopped. The throwaway data stays in', DATA_DIR, '\n');
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

try {
  process.stdout.write('  starting the server... ');
  await waitForServer();
  console.log('ok');

  const { chromium } = await import('playwright');
  // Edge, because this machine has Edge and not Chrome.
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: false,
    args: [`--window-size=${WINDOW.width},${WINDOW.height}`],
  });

  process.stdout.write('  opening both windows... ');
  await openAs(browser, 'dm@example.com', 0);
  await openAs(browser, 'thorin@example.com', WINDOW.width);
  console.log('ok');

  console.log(`
  Left window   Jeri (DM)          dm@example.com
  Right window  Thorin (player)    thorin@example.com

  Also seeded, if you want another player:
                elaria@example.com, gareth@example.com
  Every password is "${PASSWORD}".

  ${BASE}

  Close the windows or press Ctrl-C to stop. Your real campaign in data/ was
  never opened.
`);

  browser.on('disconnected', () => stop(0));
  await new Promise(() => {});
} catch (err) {
  console.error('\n ', err instanceof Error ? err.message : err, '\n');
  stop(1);
}
