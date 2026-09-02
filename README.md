# Vegas print agent

Slips print by themselves, on the right printer, from any device — a waiter's
phone, the bar tablet, the office.

## Why it exists

A phone cannot reach a printer plugged into the POS terminal, and a browser
cannot choose a printer anyway: `window.print()` always opens a dialog. So the
website drops each slip into a queue, and this agent — running on the terminal
that owns the printers — picks it up and prints it.

## Install, once, on the POS terminal

1. Install **Node.js LTS** from <https://nodejs.org> (next, next, finish).
2. Copy this whole `print-agent` folder onto the terminal, e.g. `C:\vegas-print`.
3. Put **`service-account.json`** into that folder — it is the key to the print
   queue and is deliberately not in the repository. Ask for it.
4. Open PowerShell **in that folder** and run:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\install.ps1
   ```

The installer lists the printer names Windows knows, installs what it needs, and
registers the agent to **start on its own with Windows** — hidden, and restarting
itself if it ever stops. You never open it.

5. Put those exact printer names into **`config.json`**:

   ```json
   { "printers": { "bar": "POS80", "kitchen": "KITCHEN", "bill": "POS80" } }
   ```

   Then `Stop-ScheduledTask -TaskName 'Vegas print agent'` and
   `Start-ScheduledTask -TaskName 'Vegas print agent'`.

## Checking it

- Running? `Get-ScheduledTask -TaskName 'Vegas print agent'`
- Watch it work: run `start-agent.bat` by hand — the window logs every job.
- Send a real order from the app; a slip should come out within a second or two.

## When something is wrong

Each job carries its own outcome in the queue, so nothing fails silently:

| status | meaning |
| --- | --- |
| `queued` | waiting for the agent — if it stays here, the agent is not running |
| `printing` | claimed; a job stuck here is put back on the queue after 2 minutes |
| `printed` | done (`how: raw` ideal, `how: text` means the driver refused raw) |
| `no-printer` | nothing in `config.json` maps to that destination |
| `failed` | the spooler refused it three times; `error` says why |

Common causes: the printer name in `config.json` not matching Windows exactly, or
the printer being offline.

## Calling it yourself

The agent runs a small HTTP API on the terminal, so anything on that machine can
print — this app, Vegas Ops, a script, anything.

```
GET  /                       is it alive, and which printers are mapped
GET  /printers               every printer Windows knows about
GET  /selftest?printer=NAME  prints a test slip
POST /print                  print something
```

`POST /print` takes a slip and lays it out for you:

```bash
curl -X POST http://127.0.0.1:9110/print -H "Content-Type: application/json" -d "{\"to\":\"bar\",\"title\":\"TABLE 9\",\"venue\":\"bar\",\"who\":\"Aline\",\"at\":\"21:40\",\"total\":4000,\"lines\":[{\"name\":\"PRIMUS\",\"qty\":2,\"total\":4000}]}"
```

`to` picks the printer from `config.json`; pass `printer` instead to name one
directly. To send your own ESC/POS bytes, post `{ "printer": "POS80", "base64": "..." }`.

It answers `{"ok":true,"how":"raw"}` when the printer took the bytes properly, or
`how: "text"` when the driver refused raw and it fell back to plain text.

It listens on `127.0.0.1` only. To let other machines call it, set
`"host": "0.0.0.0"` in `config.json` — only do that on a network you trust, since
there is no password on it.

## How it is wired

The website never talks to the database from the browser — the site is public and
has no real login yet, so anyone could otherwise queue jobs or read bills. The
site posts to its own `/api/print`, which writes the job with a scoped service
account; this agent reads the queue with its own key. Firestore's rules stay
closed to browsers.

Two terminals can watch the same queue safely: each job is claimed in a
transaction, so only one of them prints it.
