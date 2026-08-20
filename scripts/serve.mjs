/**
 * Runs the table, and keeps running it.
 *
 * `npm start` builds and starts the server once. If it dies - a bug, an out of
 * memory, Windows deciding to reboot for updates - it stays dead, and the first
 * anybody knows is four people staring at a disconnected dot mid-encounter.
 * This is the thing that should be running on the machine of record.
 *
 * It takes a backup first, because the moment a server is restarting is the
 * moment you most want yesterday's copy, and starts each attempt with the
 * migrations already applied by the server itself.
 *
 * Restarts are backed off: a server that crashes on boot would otherwise spin
 * as fast as node can start, filling the log and the disk. It never gives up
 * entirely, because the alternative to a slow retry is a table that is down
 * until somebody notices.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const PORT = process.env.PORT ?? '3001';

/** Backoff between restarts, in seconds, holding at the last value. */
const BACKOFF = [0, 2, 5, 15, 30, 60];
/** A run this long is treated as healthy, so the next crash starts over at 0. */
const HEALTHY_MS = 60_000;
/** Log files kept, one per day. */
const KEEP_LOGS = 14;

function stamp() {
  return new Date().toISOString().replace(/\..+$/, '').replace('T', ' ');
}

function say(message) {
  const line = `[${stamp()}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile(), line + os.EOL);
  } catch {
    // A log that cannot be written must not take the server down with it.
  }
}

function logFile() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `server-${day}.log`);
}

/** Keeps the last fortnight; a server left running for a year should not fill a disk. */
function pruneLogs() {
  if (!fs.existsSync(LOG_DIR)) return;
  const files = fs
    .readdirSync(LOG_DIR)
    .filter((name) => name.startsWith('server-') && name.endsWith('.log'))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_LOGS))) {
    fs.rmSync(path.join(LOG_DIR, old), { force: true });
  }
}

/**
 * Runs one of this project's npm scripts to completion.
 *
 * Through npm's own JS entry under the node already running, for the reason
 * `playtest.mjs` documents at length: on Windows npm is a `.cmd` shim, and node
 * has refused to spawn one without a shell since the 2024 argument-injection
 * fix - failing with EINVAL, no exit status, and nothing on either stream.
 */
function runScript(script) {
  const cli = process.env.npm_execpath;
  const [command, args] = cli
    ? [process.execPath, [cli, 'run', script]]
    : [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script]];

  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    shell: !cli && process.platform === 'win32',
  });
  return result.status === 0;
}

fs.mkdirSync(LOG_DIR, { recursive: true });
pruneLogs();

say('--- starting up ---');

if (process.env.SERVE_SKIP_BUILD !== '1') {
  say('building');
  if (!runScript('build')) {
    say('build failed - not starting. Fix the build and run this again.');
    process.exit(1);
  }
}

// Before anything opens the database for writing. A backup that fails is not a
// reason to refuse to run a session, but it is a reason to say so loudly.
say('backing up');
if (!runScript('backup')) {
  say('BACKUP FAILED - starting anyway, but fix this before you rely on it.');
}

let child = null;
let stopping = false;
let failures = 0;

function stop(signal) {
  if (stopping) return;
  stopping = true;
  say(`${signal} received, stopping the server`);
  if (child) {
    child.kill('SIGTERM');
    // If it has not gone in ten seconds it is wedged; take it down.
    setTimeout(() => child?.kill('SIGKILL'), 10_000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

function start() {
  const startedAt = Date.now();
  say(`starting the server on port ${PORT}`);

  child = spawn(process.execPath, [path.join('apps', 'server', 'dist', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const record = (stream) => {
    stream.on('data', (chunk) => {
      process.stdout.write(chunk);
      try {
        fs.appendFileSync(logFile(), chunk);
      } catch {
        // See `say`.
      }
    });
  };
  record(child.stdout);
  record(child.stderr);

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) {
      say(`server exited (${signal ?? code}); stopped`);
      process.exit(0);
    }

    // A run that lasted is not a crash loop, whatever came before it.
    if (Date.now() - startedAt > HEALTHY_MS) failures = 0;

    const wait = BACKOFF[Math.min(failures, BACKOFF.length - 1)];
    failures += 1;
    say(`server exited (${signal ?? `code ${code}`}) - restarting in ${wait}s`);
    pruneLogs();
    setTimeout(start, wait * 1000);
  });

  child.on('error', (error) => {
    say(`could not start the server: ${error.message}`);
  });
}

start();
