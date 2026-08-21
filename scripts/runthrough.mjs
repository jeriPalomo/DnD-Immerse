/**
 * Every feature, driven end to end against a real server.
 *
 * `npm test` covers the rules, the geometry, the vision sweep and the socket
 * invariants - the things that are wrong in ways you cannot see. This covers
 * the other question: does each of the forty-odd routes and forty-odd socket
 * events actually do what it says, together, on a database with a campaign in
 * it. Four parts:
 *
 *   A  accounts, campaigns, sheets, items, rests, the compendium
 *   B  scenes, walls, doors, terrain, tokens, pins, drawings, templates, fog
 *   C  chat, dice, item cards, damage, conditions, combat, movement, journal
 *   D  uploads, stat blocks, effect durations, membership
 *
 * Like `playtest`, it never touches `data/`: the database lives in a throwaway
 * directory under the system temp folder and is rebuilt every run, so a check
 * that damages a scene damages nothing anybody cares about. That is not
 * hypothetical - part D uploads a one-pixel map, and it does so to a scene of
 * its own precisely because doing it to the seeded one collapsed the grid and
 * broke part C.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(os.tmpdir(), 'dnd-immerse-runthrough');
const PORT = Number(process.env.RUNTHROUGH_PORT ?? 3986);
const BASE = `http://127.0.0.1:${PORT}`;

/** Runs one of this project's npm scripts. See `playtest.mjs` for the why. */
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
    shell: !cli && process.platform === 'win32',
  });

  if (result.status === 0) {
    console.log('ok');
    return;
  }
  console.log('failed');
  if (result.error) console.log(`  ${result.error.message}`);
  process.stdout.write(String(result.stdout ?? ''));
  process.stderr.write(String(result.stderr ?? ''));
  process.exit(1);
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the server never answered on ${BASE}`);
}

console.log('\nRunthrough: every route and every socket event.\n');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.rmSync(path.join(DATA_DIR, 'app.db'), { force: true });

// Keep the SRD cache between runs - re-downloading 337 monster portraits to
// check that paging works would be silly.
const srdSource = path.join(ROOT, 'data', 'srd');
const srdTarget = path.join(DATA_DIR, 'srd');
if (!fs.existsSync(srdTarget) && fs.existsSync(srdSource)) {
  process.stdout.write('  copying the SRD cache... ');
  fs.cpSync(srdSource, srdTarget, { recursive: true });
  console.log('ok');
}

runScript('building', 'build');
runScript('importing the compendium', 'srd:import', { DATA_DIR });
runScript('seeding a campaign', 'seed', { DATA_DIR });

const server = spawn('node', ['apps/server/dist/index.js'], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR, PORT: String(PORT), NODE_ENV: 'production' },
  stdio: 'ignore',
});

let stopped = false;
function stop(code) {
  if (stopped) return;
  stopped = true;
  server.kill();
  process.exit(code);
}
process.on('SIGINT', () => stop(1));
process.on('SIGTERM', () => stop(1));

try {
  process.stdout.write('  starting the server... ');
  await waitForServer();
  console.log('ok');

  process.env.RUNTHROUGH_BASE = BASE;

  const parts = [
    ['A  accounts, campaigns, sheets, compendium', './runthrough/part-a.mjs'],
    ['B  scenes, walls, terrain, tokens, fog', './runthrough/part-b.mjs'],
    ['C  chat, cards, combat, movement, journal', './runthrough/part-c.mjs'],
    ['D  uploads, stat blocks, effects, members', './runthrough/part-d.mjs'],
  ];

  let passed = 0;
  const failed = [];

  for (const [label, file] of parts) {
    console.log(`\n──────── ${label} ────────`);
    const { summary } = await import(file);
    passed += summary.passed;
    failed.push(...summary.failed.map((f) => `${label.slice(0, 1)}: ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
  }

  console.log('\n════════════════════════════════════════');
  console.log(`${passed} checks passed, ${failed.length} failed`);
  if (failed.length) {
    console.log('');
    for (const line of failed) console.log(`  FAILED  ${line}`);
  }
  console.log(`\nThe throwaway data stays in ${DATA_DIR}`);
  console.log('Your real campaign in data/ was never opened.\n');

  stop(failed.length ? 1 : 0);
} catch (err) {
  console.error('\n', err instanceof Error ? err.message : err, '\n');
  stop(1);
}
