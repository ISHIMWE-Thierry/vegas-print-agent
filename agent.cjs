/**
 * Vegas print agent — the bridge between the website and this terminal's printers.
 *
 * A waiter's phone cannot reach a printer plugged into the POS. So the website
 * queues each slip in Firestore, and this service — running on the terminal that
 * owns the printers — watches that queue, prints, and marks the job done.
 *
 * It survives a reboot (see install.ps1), a dropped connection (Firestore
 * reconnects on its own) and a printer that refuses raw bytes (falls back to
 * plain text rather than leaving the counter with nothing).
 *
 *   node agent.cjs
 */
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

/* Packed into an .exe, __dirname points inside the binary — but config.json and
   the key sit next to it on disk, where someone can actually edit them. */
const HERE = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG = readJson(path.join(HERE, "config.json")) || {};
const KEY_FILE = path.join(HERE, "service-account.json");

/** Which Windows printer each destination maps to. Set in config.json. */
let PRINTERS = CONFIG.printers || { bar: "", kitchen: "", bill: "" };

/** Saves the printer choices beside the exe so they survive a restart. */
function saveConfig(printers) {
  PRINTERS = { bar: "", kitchen: "", bill: "", ...printers };
  const next = { ...CONFIG, printers: PRINTERS };
  fs.writeFileSync(path.join(HERE, "config.json"), JSON.stringify(next, null, 2));
  log(`Printers set from the app: ${JSON.stringify(PRINTERS)}`);
}
const PORT = CONFIG.port || 9110;
/** Loopback by default — set "host": "0.0.0.0" in config.json to expose it. */
const HOST = CONFIG.host || "127.0.0.1";
const POLL_NOTE = "Watching Firestore for print jobs…";
const MAX_ATTEMPTS = 3;
const STUCK_AFTER = 2 * 60 * 1000;
const SWEEP_EVERY = 60 * 1000;
const KEEP_PRINTED = 24 * 60 * 60 * 1000;
const RETRY_AFTER = 60 * 1000;
const POLL_EVERY = 3000;

const isWindows = process.platform === "win32";
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ printing */

const ps = (script, cb) =>
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, cb);

/** Push bytes to the spooler untouched, so ESC/POS sizing and the cutter work. */
function printRaw(printer, bytes, cb) {
  const file = path.join(os.tmpdir(), `vegas-${Date.now()}.bin`);
  fs.writeFileSync(file, bytes);

  if (!isWindows) {
    execFile("lp", ["-d", printer, "-o", "raw", file], (err) => {
      fs.unlink(file, () => {});
      cb(err, "raw");
    });
    return;
  }

  const script = `
$ErrorActionPreference='Stop'
Add-Type -Namespace VegasPrint -Name Raw -MemberDefinition @'
[DllImport("winspool.drv", CharSet=CharSet.Auto, SetLastError=true)]
public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
[DllImport("winspool.drv", SetLastError=true)]
public static extern bool ClosePrinter(IntPtr hPrinter);
[DllImport("winspool.drv", CharSet=CharSet.Auto, SetLastError=true)]
public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
[DllImport("winspool.drv", SetLastError=true)]
public static extern bool EndDocPrinter(IntPtr hPrinter);
[DllImport("winspool.drv", SetLastError=true)]
public static extern bool StartPagePrinter(IntPtr hPrinter);
[DllImport("winspool.drv", SetLastError=true)]
public static extern bool EndPagePrinter(IntPtr hPrinter);
[DllImport("winspool.drv", SetLastError=true)]
public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
public class DOCINFO { [MarshalAs(UnmanagedType.LPTStr)] public string pDocName="Vegas slip"; [MarshalAs(UnmanagedType.LPTStr)] public string pOutputFile=null; [MarshalAs(UnmanagedType.LPTStr)] public string pDataType="RAW"; }
'@ -UsingNamespace System.Runtime.InteropServices
$bytes = [System.IO.File]::ReadAllBytes('${file.replace(/\\/g, "\\\\")}')
$h = [IntPtr]::Zero
if (-not [VegasPrint.Raw]::OpenPrinter('${printer.replace(/'/g, "''")}', [ref]$h, [IntPtr]::Zero)) { throw 'cannot open printer' }
$di = New-Object VegasPrint.Raw+DOCINFO
[void][VegasPrint.Raw]::StartDocPrinter($h, 1, $di)
[void][VegasPrint.Raw]::StartPagePrinter($h)
$written = 0
[void][VegasPrint.Raw]::WritePrinter($h, $bytes, $bytes.Length, [ref]$written)
[void][VegasPrint.Raw]::EndPagePrinter($h)
[void][VegasPrint.Raw]::EndDocPrinter($h)
[void][VegasPrint.Raw]::ClosePrinter($h)
`;

  ps(script, (err) => {
    if (!err) {
      fs.unlink(file, () => {});
      return cb(null, "raw");
    }
    // A driver that refuses RAW should not mean no paper. Same slip, plain text:
    // no big type and no auto-cut, but the barman still has something to pour from.
    const text = fs
      .readFileSync(file)
      .toString("latin1")
      .replace(/\x1b./g, "")
      .replace(/\x1d./g, "")
      .replace(/[\x00-\x08\x0b-\x1f]/g, "");
    const txtFile = file + ".txt";
    fs.writeFileSync(txtFile, text, "latin1");
    ps(
      `Get-Content -LiteralPath '${txtFile.replace(/'/g, "''")}' | Out-Printer -Name '${printer.replace(/'/g, "''")}'`,
      (err2) => {
        fs.unlink(file, () => {});
        fs.unlink(txtFile, () => {});
        cb(err2 || null, err2 ? undefined : "text");
      },
    );
  });
}

/* ------------------------------------------------------------------- the slip */

const ESC = 0x1b;
const GS = 0x1d;
const money = (n) => Number(n || 0).toLocaleString("en-US");

/** Lays a job out as ESC/POS for an 80mm roll. */
function render(job) {
  const out = [];
  const raw = (...b) => out.push(Buffer.from(b));
  const line = (s = "") => out.push(Buffer.from(s + "\n", "latin1"));

  raw(ESC, 0x40); // reset
  raw(ESC, 0x61, 1); // centre
  raw(GS, 0x21, 0x11); // double width + height
  line(job.title || "VEGAS");
  raw(GS, 0x21, 0x00); // normal
  line(`${(job.venue || "").toUpperCase()}  ${job.at || ""}`);
  if (job.who) line(job.who);
  raw(ESC, 0x61, 0); // left
  line("-".repeat(42));

  (job.lines || []).forEach((l) => {
    const left = `${l.qty} x ${l.name}`.slice(0, 28);
    const right = money(l.total);
    line(left + " ".repeat(Math.max(1, 42 - left.length - right.length)) + right);
  });

  line("-".repeat(42));
  raw(GS, 0x21, 0x01); // double height
  const total = `TOTAL ${money(job.total)} RWF`;
  line(total);
  raw(GS, 0x21, 0x00);
  if (job.note) line(job.note);
  line();
  line();
  raw(GS, 0x56, 0x00); // cut
  return Buffer.concat(out);
}


/* ---------------------------------------------------------------------- api */

/** Every printer Windows knows about, so a caller can pick a real one. */
function listPrinters(cb) {
  if (!isWindows) {
    execFile("lpstat", ["-a"], (err, out) => {
      if (err) return cb([]);
      cb(String(out).split("\n").map((l) => l.split(" ")[0]).filter(Boolean));
    });
    return;
  }
  ps("Get-Printer | Select-Object -ExpandProperty Name", (err, out) => {
    if (err) return cb([]);
    cb(String(out).split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
  });
}

const reply = (res, code, body) => {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
};

/**
 * A small HTTP API so anything on this machine — this app, Vegas Ops, a script —
 * can print without going near the queue.
 *
 *   GET  /                      is it alive
 *   GET  /printers              what it can print to
 *   GET  /selftest?printer=NAME prints a test slip
 *   POST /print                 { printer?, to?, title, lines[], total, ... }
 *                               or { printer, base64 } for raw bytes
 */
function serve() {
  http
    .createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      if (req.method === "OPTIONS") return reply(res, 204, {});

      if (url.pathname === "/") {
        return reply(res, 200, { ok: true, service: "vegas-print-agent", platform: process.platform, printers: PRINTERS });
      }

      if (url.pathname === "/printers") {
        return listPrinters((printers) => reply(res, 200, { ok: true, printers }));
      }

      if (url.pathname === "/selftest") {
        const printer = url.searchParams.get("printer") || PRINTERS.bill;
        if (!printer) return reply(res, 400, { ok: false, error: "use /selftest?printer=NAME" });
        const slip = render({
          title: "TEST SLIP", venue: "vegas", who: "print agent", at: new Date().toTimeString().slice(0, 5),
          lines: [{ name: "If you can read this", qty: 1, total: 0 }], total: 0, note: "IT WORKS",
        });
        return printRaw(printer, slip, (err, how) =>
          err ? reply(res, 500, { ok: false, error: String(err).slice(0, 300) }) : reply(res, 200, { ok: true, how }),
        );
      }

      /* The office picks printers in the app; this is where that lands, so there
         is one place to set them rather than a file to edit by hand. */
      if (url.pathname === "/config" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
        req.on("end", () => {
          try {
            const { printers } = JSON.parse(body);
            if (!printers || typeof printers !== "object") throw new Error("printers required");
            saveConfig(printers);
            reply(res, 200, { ok: true, printers: PRINTERS });
          } catch (e) {
            reply(res, 400, { ok: false, error: String(e).slice(0, 200) });
          }
        });
        return;
      }

      if (url.pathname === "/print" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
        req.on("end", () => {
          let job;
          try { job = JSON.parse(body); } catch { return reply(res, 400, { ok: false, error: "bad json" }); }

          const printer = job.printer || PRINTERS[job.to] || PRINTERS.bill;
          if (!printer) return reply(res, 400, { ok: false, error: "no printer given and none mapped to " + job.to });

          // Either raw bytes, or a slip we lay out here.
          const bytes = job.base64
            ? Buffer.from(job.base64, "base64")
            : render(job);

          printRaw(printer, bytes, (err, how) =>
            err
              ? reply(res, 500, { ok: false, printer, error: String(err).slice(0, 300) })
              : reply(res, 200, { ok: true, printer, how }),
          );
        });
        return;
      }

      reply(res, 404, { ok: false, error: "not found" });
    })
    .listen(PORT, HOST, () => log(`API on http://${HOST}:${PORT}`));
}

/* ------------------------------------------------------------------ the queue */

const fs2 = require("./firestore.cjs");

const TASK = "Vegas print agent";

/**
 * Registers the agent to start with Windows, using schtasks rather than
 * PowerShell — the script policy that blocks .ps1 files does not apply to it,
 * which is the whole reason this is an .exe.
 */
function installTask() {
  if (!isWindows) return console.error("Only needed on Windows.");
  const exe = process.execPath;
  execFile(
    "schtasks",
    ["/Create", "/TN", TASK, "/TR", `"${exe}"`, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"],
    { windowsHide: true },
    (err, out, errOut) => {
      if (err) {
        console.error("Could not register:", String(errOut || err).slice(0, 300));
        return;
      }
      console.log(`Registered. ${TASK} will start when you sign in.`);
      execFile("schtasks", ["/Run", "/TN", TASK], { windowsHide: true }, () =>
        console.log("Started. You can close this window."),
      );
    },
  );
}

function uninstallTask() {
  if (!isWindows) return console.error("Only needed on Windows.");
  execFile("schtasks", ["/Delete", "/TN", TASK, "/F"], { windowsHide: true }, (err, out, errOut) =>
    console.log(err ? `Could not remove: ${String(errOut || err).slice(0, 200)}` : "Removed."),
  );
}

function start() {
  log(`Printers: ${JSON.stringify(PRINTERS)}`);
  serve();

  /* The key is only needed to watch the queue, which is how orders sent from a
     phone reach this printer. Without it the agent still serves its API, so the
     till prints from the moment it is installed. */
  const key = readJson(KEY_FILE);
  if (!key) {
    log("No service-account.json - running as a local printer service only.");
    log("Orders sent from phones will not print here until the key is added.");
    return;
  }

  log(`Queue connected as ${key.client_email}`);
  log(POLL_NOTE);
  let sweepDue = 0;
  const tick = async () => {
    try {
      const jobs = await fs2.where(key, "printJobs", "status", "queued");
      for (const job of jobs) await handle(key, job);
    } catch (e) {
      log("queue check failed:", String(e).slice(0, 160));
    }
    if (Date.now() > sweepDue) {
      sweepDue = Date.now() + SWEEP_EVERY;
      await sweep(key);
    }
  };
  void tick();
  setInterval(() => void tick(), POLL_EVERY);
}

async function handle(key, job) {
  const printer = PRINTERS[job.data.to] || PRINTERS.bill || "";
  if (!printer) {
    log(`No printer mapped to "${job.data.to}" - parking job ${job.id}. Fix config.json.`);
    await fs2.patch(key, "printJobs", job.id, { status: "no-printer", error: `nothing mapped to ${job.data.to}` });
    return;
  }

  const attempts = (job.data.attempts || 0) + 1;
  if (attempts > MAX_ATTEMPTS) {
    await fs2.patch(key, "printJobs", job.id, { status: "failed", error: `gave up after ${MAX_ATTEMPTS} attempts` });
    return;
  }

  /* Claim it first, and only if nobody else has touched it since we read it -
     two terminals watching the same queue must not both print the same slip. */
  const claimed = await fs2.patch(
    key, "printJobs", job.id,
    { status: "printing", claimedAt: Date.now(), attempts },
    job.updateTime,
  );
  if (!claimed) return;

  printRaw(printer, render(job.data), async (err, how) => {
    try {
      if (err) {
        const done = attempts >= MAX_ATTEMPTS;
        log(`${done ? "GAVE UP on" : "failed"} ${job.data.to} -> ${printer}:`, String(err).slice(0, 180));
        await fs2.patch(key, "printJobs", job.id, {
          status: done ? "failed" : "retry",
          error: String(err).slice(0, 300),
          ...(done ? {} : { retryAt: Date.now() + RETRY_AFTER }),
        });
        return;
      }
      log(`printed ${job.data.title || job.data.to} on ${printer} (${how})`);
      await fs2.patch(key, "printJobs", job.id, { status: "printed", how, printedAt: Date.now() });
    } catch (e) {
      log("could not record the outcome:", String(e).slice(0, 160));
    }
  });
}

/**
 * Housekeeping: a job claimed but never finished goes back on the queue, one
 * waiting on a printer that was offline gets another go, and finished jobs are
 * cleared out so the collection stays small.
 */
async function sweep(key) {
  const now = Date.now();

  try {
    for (const job of await fs2.where(key, "printJobs", "status", "printing")) {
      if (now - (job.data.claimedAt || 0) < STUCK_AFTER) continue;
      const over = (job.data.attempts || 0) >= MAX_ATTEMPTS;
      await fs2.patch(key, "printJobs", job.id,
        over ? { status: "failed", error: "claimed but never finished" } : { status: "queued" });
      log(`requeued stuck job ${job.id}`);
    }
  } catch (e) {
    log("stuck-job sweep failed:", String(e).slice(0, 160));
  }

  try {
    for (const job of await fs2.where(key, "printJobs", "status", "retry")) {
      if ((job.data.retryAt || 0) > now) continue;
      await fs2.patch(key, "printJobs", job.id, { status: "queued" });
      log(`retrying job ${job.id}`);
    }
  } catch (e) {
    log("retry sweep failed:", String(e).slice(0, 160));
  }

  try {
    let gone = 0;
    for (const job of await fs2.where(key, "printJobs", "status", "printed", 100)) {
      if (now - (job.data.printedAt || 0) < KEEP_PRINTED) continue;
      await fs2.remove(key, "printJobs", job.id);
      gone += 1;
    }
    if (gone) log(`cleared ${gone} finished job(s)`);
  } catch (e) {
    log("cleanup sweep failed:", String(e).slice(0, 160));
  }
}

/* Only run when launched directly, so the slip layout can be exercised from a
   test without the agent connecting to anything. */
if (require.main === module) {
  const arg = (process.argv[2] || "").toLowerCase();
  if (arg === "--install") installTask();
  else if (arg === "--uninstall") uninstallTask();
  else {
    start();
    if (isWindows) log(`To start with Windows, run once:  "${process.execPath}" --install`);
  }
}

module.exports = { render, printRaw };
