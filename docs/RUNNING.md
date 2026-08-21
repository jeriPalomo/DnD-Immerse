# Running the table

This machine is the server of record. It holds the only copy of the campaign.

## The short version

Started by hand when you play, stopped when you are done.

```bash
npm run serve     # back up, build, start, and keep it up
                  # Ctrl-C when you are finished
npm run stop      # if Ctrl-C was not an option
```

| | |
|---|---|
| Players connect to | `http://100.69.0.16:3001` |
| Logs | `data/logs/server-<date>.log` |
| Backups | `data/backups/`, last ten kept |
| Is it up? | `curl http://127.0.0.1:3001/api/health` |

The first run of an evening builds first, which takes a minute or so. Leave the
window open while you play - closing it stops the table.

## What `npm run serve` does

It is a supervisor, not just a start command. It takes a backup, builds, starts
the server, and **restarts it if it crashes** — backing off 0s, 2s, 5s, 15s,
30s, then a minute, and never giving up. A run lasting a minute resets the
backoff, so one bad moment does not leave it crawling for the rest of the night.
It never rebuilds on a restart: a crash loop that recompiled every time would
take the machine down with it.

A crash therefore drops everyone for a few seconds and no longer. Every client
reconnects on its own, re-joins the campaign and is re-sent the scene, the
encounter and the chat history — that path is tested.

### Stopping it

**Ctrl-C** in the window is the ordinary way, and it stops both the supervisor
and the server: Windows sends the console event to every process attached to
that console.

`npm run stop` is for when that was not an option — the window got closed, or
the terminal was killed outright and left a server holding port 3001 with no
supervisor to stop it. It finds the processes by their command line rather than
by a pid file, because a stale pid file points at whatever process later reused
that number, and stopping the table is not a thing to do approximately.

If a start ever fails with *port 3001 already in use*, `npm run stop` is the fix.

### Starting it with Windows instead

If you ever want it up without thinking about it,
`scripts/install-startup.ps1` registers a scheduled task that runs the
supervisor at logon and restarts it if it stops. Not installed at the moment.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1 -Remove
```

## Backups

Taken automatically every time you run `npm run serve`, before anything opens
the database for writing — which is exactly the moment you most want yesterday's
copy, because a pending migration is about to run.

`VACUUM INTO`, never a file copy: copying a live SQLite file can capture a torn
write, and the result looks fine until the day you need it. Uploads are copied
alongside. The last ten are kept.

Take one by hand before anything risky:

```bash
npm run backup
```

To restore: `npm run stop`, replace `data/app.db` and `data/uploads/` from a
backup directory, then `npm run serve` again. Bestiary art under `data/srd/` is
deliberately **not** backed up — it is re-derivable with `npm run srd:import`.

## HTTPS, and the cookie warning

The server logs this at boot:

> SECURE_COOKIES is not set…

That is correct as things stand and you should leave it alone. `Secure` is a
*restriction*: the browser then refuses to send the cookie over plain HTTP, so
turning it on while people connect to `http://100.69.0.16:3001` would break
every login. Tailscale already encrypts the traffic with WireGuard, so nothing
is travelling in the clear.

**You already have the hostname.** MagicDNS is on, so
`http://pc.tail08956b.ts.net:3001` resolves today with nothing to set up - give
players that rather than the IP. Tailscale Serve is not needed for it.

What Serve would add is HTTPS, and with it the `:3001` disappears:

1. Enable Serve for the tailnet (one click, in the Tailscale admin console).
2. `tailscale serve --bg --https=443 http://127.0.0.1:3001`
3. Set `SECURE_COOKIES=true` and restart.

Players then use `https://pc.tail08956b.ts.net`. Optional: the traffic is
already encrypted by WireGuard either way, and the one feature that genuinely
needed a secure context - copying the invite code - now works without one.

## Showing somebody

```bash
npm run playtest
```

Builds, seeds a throwaway campaign in the system temp folder, and opens two
windows side by side — you as the DM, Thorin as a player. It prints the tailnet
address so a friend can join from their own machine as Elaria or Gareth. Every
password is `demo-password`.

The demo campaign has a real scene, *The Sunken Crypt*: two rooms, a shut door,
the party with torches and goblins behind the door. With dynamic vision on the
DM sees the whole crypt and a player sees only their lit room — which is the
thing worth showing.

**It never touches `data/`.** Your real campaign cannot be harmed by a demo.

## Checking it still works

```bash
npm test             # rules, geometry, vision, socket invariants
npm run runthrough   # every route and socket event, end to end
```

The runthrough builds, seeds a throwaway campaign under the system temp folder,
starts a server, drives 250 checks across five parts, and stops. It never opens
`data/`. Worth running after a pull, and before a session you care about.

The last part opens a browser and clicks the board itself, since the map is a
canvas and nothing else can tell you a click still lands where you aimed it.

## When something is wrong

Read `data/logs/server-<date>.log` first — the supervisor's own lines are
timestamped in square brackets, and the server's JSON lines sit between them.

- **Nobody can connect.** Is the window still open? Is `curl
  http://127.0.0.1:3001/api/health` answering? Is the other machine on the
  tailnet?
- **It restarts over and over.** The log will show `server exited` with an
  interval that keeps growing. The exception above the first one is the cause.
- **The compendium is empty.** `npm run srd:import`. Empty shelves are not a
  code bug; `data/srd/` being empty is the tell.
- **A migration will not apply.** `npm run stop`, restore `data/app.db` from
  `data/backups/`, and do not start it again until the migration is fixed.
- **Port 3001 already in use.** `npm run stop`, then start again.

## Do not

- **Sync `data/` between machines.** Never run two servers against one SQLite
  file. The desktop is the server of record; anything else keeps throwaway data.
- **Run `npm run seed` against `data/`.** It only ever touches `@example.com`
  accounts, so it will not eat the campaign — but it will add a demo one.
