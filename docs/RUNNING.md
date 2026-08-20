# Running the table

This machine is the server of record. It holds the only copy of the campaign.

## The short version

It is already running. A scheduled task called **DnD Immerse** starts
`scripts/serve.mjs` at logon, which backs up, builds, and keeps the server
alive on port 3001.

| | |
|---|---|
| Players connect to | `http://100.69.0.16:3001` |
| Logs | `data/logs/server-<date>.log` |
| Backups | `data/backups/`, last ten kept |
| Start it now | `Start-ScheduledTask -TaskName 'DnD Immerse'` |
| Stop it | `Stop-ScheduledTask -TaskName 'DnD Immerse'` |
| Is it up? | `curl http://127.0.0.1:3001/api/health` |

## What keeps it running

Two layers, because they fail differently.

**`npm run serve`** is the supervisor. It takes a backup, builds, starts the
server, and restarts it if it exits — backing off 0s, 2s, 5s, 15s, 30s, then a
minute, and never giving up. A run lasting a minute resets the backoff, so one
bad night does not leave it crawling. It never rebuilds on a restart: a crash
loop that recompiled every time would take the machine down with it.

**The scheduled task** is the layer above. Windows reboots itself for updates,
and the supervisor cannot restart itself from a machine that is off. The task
runs at logon and restarts the supervisor if that ever exits.

It is registered at **logon**, not at boot, on purpose. A boot trigger has to
run as SYSTEM or store a password, and SYSTEM has a different profile, a
different PATH and no access to a per-user node install — one clear failure
becomes three obscure ones. After a reboot, sign in and the table is up.

```powershell
# Register or re-register it
powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1

# Remove it
powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1 -Remove
```

A server that crashes drops everyone for a few seconds and no longer. Every
client reconnects on its own, re-joins the campaign and is re-sent the scene,
the encounter and the chat history — that path is tested.

## Backups

Taken automatically on every start, before anything opens the database for
writing — which is exactly the moment you most want yesterday's copy.

`VACUUM INTO`, never a file copy: copying a live SQLite file can capture a torn
write, and the result looks fine until the day you need it. Uploads are copied
alongside. The last ten are kept.

Take one by hand before anything risky:

```bash
npm run backup
```

To restore, stop the task, replace `data/app.db` and `data/uploads/` from a
backup directory, and start it again. Bestiary art under `data/srd/` is
deliberately **not** backed up — it is re-derivable with `npm run srd:import`.

## HTTPS, and the cookie warning

The server logs this at boot:

> SECURE_COOKIES is not set…

That is correct as things stand and you should leave it alone. `Secure` is a
*restriction*: the browser then refuses to send the cookie over plain HTTP, so
turning it on while people connect to `http://100.69.0.16:3001` would break
every login. Tailscale already encrypts the traffic with WireGuard, so nothing
is travelling in the clear.

If you want a real hostname and a real certificate, Tailscale Serve gives both:

1. Enable Serve for the tailnet (one click, in the Tailscale admin console).
2. `tailscale serve --bg --https=443 http://127.0.0.1:3001`
3. Set `SECURE_COOKIES=true` for the service and restart it.

Players then use `https://pc.tail08956b.ts.net` with no port. Worth doing, not
urgent.

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

## When something is wrong

Read `data/logs/server-<date>.log` first — the supervisor's own lines are
timestamped in square brackets, and the server's JSON lines sit between them.

- **Nobody can connect.** Is the task running? Is `curl
  http://127.0.0.1:3001/api/health` answering? Is the other machine on the
  tailnet?
- **It restarts over and over.** The log will show `server exited` with an
  interval that keeps growing. The exception above the first one is the cause.
- **The compendium is empty.** `npm run srd:import`. Empty shelves are not a
  code bug; `data/srd/` being empty is the tell.
- **A migration will not apply.** Stop the task, restore `data/app.db` from
  `data/backups/`, and do not start it again until the migration is fixed.

## Do not

- **Sync `data/` between machines.** Never run two servers against one SQLite
  file. The desktop is the server of record; anything else keeps throwaway data.
- **Run `npm run seed` against `data/`.** It only ever touches `@example.com`
  accounts, so it will not eat the campaign — but it will add a demo one.
