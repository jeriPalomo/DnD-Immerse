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

/**
 * Addresses somebody else could reach this on.
 *
 * The server binds 0.0.0.0, so a friend on the tailnet can join the throwaway
 * table from their own machine - which is the whole point of showing it to
 * somebody. Printing only `localhost` sends them nowhere. Tailscale hands out
 * 100.64.0.0/10, so those are listed first and named.
 */
function shareable() {
  return reachableUrls()
    .map((entry) => `  ${entry.url}${entry.tailnet ? '   <- give your friend this one' : ''}`)
    .join(String.fromCharCode(10));
}

function reachableUrls() {
  const found = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const tailnet = address.address.startsWith('100.');
      found.push({ url: `http://${address.address}:${PORT}`, tailnet });
    }
  }
  return found.sort((a, b) => Number(b.tailnet) - Number(a.tailnet));
}

/**
 * Runs one of this project's npm scripts.
 *
 * Through npm's own JavaScript entry point, under the node already running,
 * rather than by spawning `npm`. On Windows npm is a `.cmd` shim, and since the
 * 2024 argument-injection fix node refuses to spawn one without a shell: it
 * fails with EINVAL, sets no exit status and writes nothing to either stream.
 * That is how this arrived as `building... failed` and not one word more.
 *
 * Spawning it with `shell: true` would work and hand the arguments to cmd to
 * re-parse, which is the thing that fix exists to prevent. `npm_execpath` is
 * set by npm itself, which is how this script is always started; the shell is
 * the fallback for someone running the file directly.
 */
function runScript(label, script, env = {}) {
  const cli = process.env.npm_execpath;
  const [command, args] = cli
    ? [process.execPath, [cli, 'run', script]]
    : [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script]];

  process.stdout.write(`  ${label}... `);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: 'pipe',
    // Only ever reached without `npm_execpath`, where there is no other way to
    // start a `.cmd`. The arguments here are fixed literals from this file.
    shell: !cli && process.platform === 'win32',
  });

  if (result.status === 0) {
    console.log('ok');
    return;
  }

  // Say something, whatever went wrong. A spawn that never starts leaves both
  // streams empty and `status` null, so printing only the streams prints
  // nothing at all - which is worse than an ugly error, because it looks like
  // the build failed silently rather than like npm was never run.
  console.log('failed');
  if (result.error) console.log(`  ${result.error.message}`);
  else console.log(`  \`npm run ${script}\` exited with ${result.status}`);
  process.stdout.write(String(result.stdout ?? ''));
  process.stderr.write(String(result.stderr ?? ''));
  process.exit(1);
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

runScript('building', 'build');
runScript('importing the compendium', 'srd:import', { DATA_DIR });
runScript('seeding a campaign', 'seed', { DATA_DIR });

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

  // A smoke test of everything but the windows, for checking that the build,
  // the import, the seed and the server itself still work without two browsers
  // taking over the screen.
  if (process.env.PLAYTEST_NO_BROWSER) {
    console.log(`
  Server up at ${BASE}, no windows opened (PLAYTEST_NO_BROWSER).
${shareable()}
`);
    stop(0);
  }

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
${shareable()}

  Close the windows or press Ctrl-C to stop. Your real campaign in data/ was
  never opened.
`);

  browser.on('disconnected', () => stop(0));
  await new Promise(() => {});
} catch (err) {
  console.error('\n ', err instanceof Error ? err.message : err, '\n');
  stop(1);
}
