/**
 * Stops the table.
 *
 * Ctrl-C in the window running `npm run serve` is the ordinary way, and it
 * works: Windows sends the console event to every process attached to that
 * console, so the supervisor and the server both get it. This is for when that
 * is not available - the window was closed, or the terminal was killed outright
 * and left a server holding port 3001 with no supervisor to stop it.
 *
 * It matches on the command line rather than on a pid file. A pid file left
 * behind by a hard kill points at whatever process later reused that number,
 * and "stop the table" is not a thing to do approximately.
 */
import { spawnSync } from 'node:child_process';

const PATTERN = /serve\.mjs|server[\\/]dist[\\/]index\.js/;

function runningOnWindows() {
  // Get-CimInstance rather than tasklist, because only WMI reports the full
  // command line - and every one of these is `node.exe` without it.
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    'Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress';
  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];

  const raw = (result.stdout ?? '').trim();
  if (!raw) return [];

  const parsed = JSON.parse(raw);
  // One process comes back as an object, several as an array.
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter((row) => row?.CommandLine && PATTERN.test(row.CommandLine))
    .map((row) => ({ pid: row.ProcessId, command: row.CommandLine }));
}

function runningOnPosix() {
  const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => PATTERN.test(line) && !line.includes('stop.mjs'))
    .map((line) => {
      const [pid, ...rest] = line.split(/\s+/);
      return { pid: Number(pid), command: rest.join(' ') };
    });
}

const found = process.platform === 'win32' ? runningOnWindows() : runningOnPosix();

if (found.length === 0) {
  console.log('Nothing to stop - no table is running.');
  process.exit(0);
}

// The supervisor first. Stopping a server while its supervisor is still
// watching is how you restart the thing you were trying to stop.
const ordered = [
  ...found.filter((row) => row.command.includes('serve.mjs')),
  ...found.filter((row) => !row.command.includes('serve.mjs')),
];

for (const row of ordered) {
  try {
    process.kill(row.pid, 'SIGTERM');
    console.log(`  stopped ${row.pid}`);
  } catch (error) {
    console.log(`  could not stop ${row.pid}: ${error.message}`);
  }
}

console.log(`\nStopped ${ordered.length} process${ordered.length === 1 ? '' : 'es'}.`);
