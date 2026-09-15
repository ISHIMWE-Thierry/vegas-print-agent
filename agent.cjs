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
 * The slip layout lives in slipLayout.cjs, shared with the website: the app
 * renders the bytes for every slip it sends, so the paper changes with a
 * deploy, not with a new exe.
 *
 *   node agent.cjs
 */
const { execFile, spawn } = require("child_process");
const https = require("https");
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
/** Shown on the till's Setup page; bump with every release. */
const VERSION = "1.5.1";
/** How often the agent tells the house it is alive (agents/<host>). */
const HEARTBEAT_EVERY = 30 * 1000;

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

/**
 * The words of a slip with every ESC/POS command taken out — including the
 * ones that carry data, a raster (GS v 0) or a settings block (GS ( x), which
 * a plain regex would leave behind as thousands of stray characters.
 */
function stripEscPos(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x1b) {
      const c = buf[i + 1];
      if (c === 0x40) i += 1;                 // ESC @
      else if (c === 0x37) i += 4;            // ESC 7 n1 n2 n3
      else if (c === 0x2a) {                  // ESC * m nL nH data
        const m = buf[i + 2], n = buf[i + 3] | (buf[i + 4] << 8);
        i += 4 + n * (m >= 32 ? 3 : 1);
      } else i += 2;                          // ESC x n
      continue;
    }
    if (b === 0x1d) {
      const c = buf[i + 1];
      if (c === 0x76 && buf[i + 2] === 0x30) { // GS v 0 m xL xH yL yH data
        const w = buf[i + 4] | (buf[i + 5] << 8), h = buf[i + 6] | (buf[i + 7] << 8);
        i += 7 + w * h;
      } else if (c === 0x28) {                // GS ( x pL pH payload
        i += 4 + (buf[i + 3] | (buf[i + 4] << 8));
      } else if (c === 0x56) i += buf[i + 2] >= 65 ? 3 : 2; // GS V m [n]
      else i += 2;                            // GS x n
      continue;
    }
    if (b === 0x1c) { i += buf[i + 1] === 0x70 ? 3 : 2; continue; } // FS p n m · FS x n
    if (b === 0x0a || (b >= 0x20 && b < 0x7f)) out.push(b);
  }
  return Buffer.from(out).toString("latin1");
}

/** Push bytes to the spooler untouched, so ESC/POS sizing and the cutter work. */
let inFlight = 0;
function printRaw(printer, bytes, done) {
  inFlight += 1;
  const cb = (err, how) => { inFlight = Math.max(0, inFlight - 1); done(err, how); };
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

  ps(script, (err, _out, stderr) => {
    fs.unlink(file, () => {});
    if (!err) return cb(null, "raw");
    cb(new Error(String(stderr || err).trim().slice(0, 300)));
  });
}

/**
 * The last resort: the same slip as plain text through the driver's own
 * text printing — no big type, no artwork, no cut, the driver's font and
 * wrapping. Paper comes out, and nothing a plain head could mistake for text.
 */
function printText(printer, bytes, done) {
  inFlight += 1;
  const cb = (err, how) => { inFlight = Math.max(0, inFlight - 1); done(err, how); };
  const txtFile = path.join(os.tmpdir(), `vegas-${Date.now()}.txt`);
  fs.writeFileSync(txtFile, stripEscPos(bytes), "latin1");
  if (!isWindows) {
    execFile("lp", ["-d", printer, txtFile], (err) => { fs.unlink(txtFile, () => {}); cb(err, "text"); });
    return;
  }
  ps(
    `Get-Content -LiteralPath '${txtFile.replace(/'/g, "''")}' | Out-Printer -Name '${printer.replace(/'/g, "''")}'`,
    (err, _out, stderr) => {
      fs.unlink(txtFile, () => {});
      cb(err ? new Error(String(stderr || err).trim().slice(0, 300)) : null, err ? undefined : "text");
    },
  );
}

/**
 * One slip, whichever way this printer takes it. Printer codes first (or the
 * page first when the house asked for pages), then the page through the
 * driver, then plain text. A way a printer refused is remembered so the next
 * slip does not wait on it again, and the reason travels with the job and in
 * the heartbeat, so the office can see why a till prints the way it does.
 */
const refused = {};
let lastHow = "";
function printSlip(printer, { bytes, ops, mode }, done) {
  const tries = [];
  const canPage = isWindows && Array.isArray(ops) && ops.length > 0;
  const rawOk = !(refused[printer] && refused[printer].raw);
  const raw = ["raw", (cb) => printRaw(printer, bytes, cb)];
  const page = ["page", (cb) => printPage(printer, ops, cb)];
  if (mode === "page") { if (canPage) tries.push(page); if (rawOk) tries.push(raw); }
  else { if (rawOk) tries.push(raw); if (canPage) tries.push(page); }
  tries.push(["text", (cb) => printText(printer, bytes, cb)]);
  const why = [];
  const next = (i) => {
    if (i >= tries.length) return done(new Error(why.join(" | ") || "nothing could print"));
    const [how, fn] = tries[i];
    fn((err) => {
      if (!err) { lastHow = how; return done(null, how, why.join(" | ")); }
      const reason = String(err).slice(0, 200);
      why.push(`${how}: ${reason}`);
      if (how === "raw") { refused[printer] = { ...(refused[printer] || {}), raw: reason }; log(`printer codes refused on ${printer}: ${reason}`); }
      next(i + 1);
    });
  };
  next(0);
}

/**
 * Prints a slip as a page through the Windows printer driver — the way the
 * old till's program did — instead of raw printer codes. The driver draws
 * the fonts and cuts after the page, so what comes out is what the layout
 * says, on any head the driver knows. A custom paper height means no metre of
 * blank feed. If anything in this path fails, the same slip goes out raw, so
 * the bar is never without paper.
 */
function printPage(printer, ops, done) {
  if (!isWindows) return done(new Error("pages print through the Windows driver only"));
  inFlight += 1;
  const cb = (err, how) => { inFlight = Math.max(0, inFlight - 1); done(err, how); };
  const file = path.join(os.tmpdir(), `vegas-${Date.now()}.slip`);
  fs.writeFileSync(file, pageText(ops), "utf8");
  const q = (x) => String(x).replace(/'/g, "''");
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$ops = [System.IO.File]::ReadAllLines('${q(file)}')
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = '${q(printer)}'
if (-not $doc.PrinterSettings.IsValid) { throw 'printer not valid: ${q(printer)}' }
$doc.DocumentName = 'Vegas slip'
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
$W = 283
$fMono = New-Object System.Drawing.Font('Consolas', 8.5, [System.Drawing.FontStyle]::Bold)
$fMid = New-Object System.Drawing.Font('Arial', 11, [System.Drawing.FontStyle]::Bold)
$fBig = New-Object System.Drawing.Font('Arial', 16, [System.Drawing.FontStyle]::Bold)
$H = @{ '0' = 14; '1' = 19; '2' = 27 }
$height = 30
foreach ($op in $ops) {
  if ($op.Length -eq 0) { continue }
  $k = $op.Substring(0, 1)
  if ($k -eq 'R') { $height += 12 } elseif ($k -eq 'X') { $height += 14 } elseif ($k -eq 'G') { $height += 52 } else { $height += $H[$op.Substring(2, 1)] }
}
$height += 40
$doc.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('Vegas slip', 315, $height)
$script:y = 12
$doc.add_PrintPage({
  param($sender, $e)
  $g = $e.Graphics
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
  $black = [System.Drawing.Brushes]::Black
  $fmtL = New-Object System.Drawing.StringFormat
  $fmtL.Alignment = [System.Drawing.StringAlignment]::Near
  $fmtL.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
  $fmtC = New-Object System.Drawing.StringFormat
  $fmtC.Alignment = [System.Drawing.StringAlignment]::Center
  $fmtC.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
  foreach ($op in $ops) {
    if ($op.Length -eq 0) { continue }
    $k = $op.Substring(0, 1)
    if ($k -eq 'R') { $g.FillRectangle($black, 0, $script:y + 5, $W, 2); $script:y += 12; continue }
    if ($k -eq 'X') { $g.FillRectangle($black, 0, $script:y + 2, $W, 10); $script:y += 14; continue }
    if ($k -eq 'G') {
      $g.DrawString('VEGAS MOTEL', $fBig, $black, (New-Object System.Drawing.RectangleF(0, $script:y, $W, 27)), $fmtC)
      $g.DrawString('BAR & RESTAURANT', $fMid, $black, (New-Object System.Drawing.RectangleF(0, ($script:y + 29), $W, 19)), $fmtC)
      $script:y += 52
      continue
    }
    $size = $op.Substring(2, 1)
    $text = ''
    if ($op.Length -gt 4) { $text = $op.Substring(4) }
    $font = $fMono
    if ($size -eq '1') { $font = $fMid } elseif ($size -eq '2') { $font = $fBig }
    $fmt = $fmtL
    if ($k -eq 'C') { $fmt = $fmtC }
    $g.DrawString($text, $font, $black, (New-Object System.Drawing.RectangleF(0, $script:y, $W, $H[$size])), $fmt)
    $script:y += $H[$size]
  }
  $e.HasMorePages = $false
})
$doc.Print()
`;
  ps(script, (err, _out, stderr) => {
    fs.unlink(file, () => {});
    if (!err) return cb(null, "page");
    cb(new Error(String(stderr || err).trim().slice(0, 300)));
  });
}

/* ------------------------------------------------------------------- the slip */

const { escposBytes, slipPage, pageText, sample } = require("./slipLayout.cjs");

/**
 * Lays a job out as ESC/POS. The layout is slipLayout.cjs, the same file the
 * website uses: the app renders the bytes for every slip it sends (queued jobs
 * carry them as `base64`), so this only serves /selftest, jobs queued by an
 * older app, and anything else that POSTs a slip here.
 */
function render(job) {
  return Buffer.from(escposBytes(job));
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
        return reply(res, 200, { ok: true, service: "vegas-print-agent", version: VERSION, platform: process.platform, printers: PRINTERS });
      }

      if (url.pathname === "/printers") {
        return listPrinters((printers) => reply(res, 200, { ok: true, printers }));
      }

      if (url.pathname === "/selftest") {
        const printer = url.searchParams.get("printer") || PRINTERS.bill;
        if (!printer) return reply(res, 400, { ok: false, error: "use /selftest?printer=NAME" });
        // The owner's sample bill, so what comes out is what a real bill looks like.
        // ?art=1 adds the artwork header and the darker burn; ?test=1 prints the test slip.
        const art = url.searchParams.get("art") === "1";
        const testing = url.searchParams.get("test") === "1";
        const slipObj = testing ? { to: "test", lines: [], total: 0 } : sample();
        const slip = Buffer.from(escposBytes(slipObj, { art }));
        const answer = (err, how, why) =>
          err ? reply(res, 500, { ok: false, error: String(err).slice(0, 300) }) : reply(res, 200, { ok: true, how, why: why || "" });
        // ?page=1 asks for the page through the Windows driver first.
        return printSlip(printer, { bytes: slip, ops: slipPage(slipObj).ops, mode: url.searchParams.get("page") === "1" ? "page" : "raw" }, answer);
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
          const answer = (err, how, why) =>
            err
              ? reply(res, 500, { ok: false, printer, error: String(err).slice(0, 300) })
              : reply(res, 200, { ok: true, printer, how, why: why || "" });
          // The slip's own fields let the page be laid out here when the driver has to draw it.
          printSlip(printer, { bytes, ops: Array.isArray(job.lines) ? slipPage(job).ops : null, mode: job.mode === "page" ? "page" : "raw" }, answer);
        });
        return;
      }

      reply(res, 404, { ok: false, error: "not found" });
    })
    .listen(PORT, HOST, () => {
      log(`API on http://${HOST}:${PORT}`);
      // Tells an update in progress that this version came up fine.
      try { fs.writeFileSync(MARKER, `${VERSION} ${new Date().toISOString()}`); } catch { /* not fatal */ }
    });
}

/* ------------------------------------------------------------- self-update */
/**
 * The till keeps itself current. Every few hours the agent asks GitHub for
 * the latest release; a newer VegasPrint.exe is downloaded next to this one,
 * checked, and swapped in by a small script once no slip is printing. The
 * script starts the new exe and, if it has not come up within half a minute,
 * puts the old one back — so an update can never leave the bar without a printer.
 */
const RELEASE_API = "https://api.github.com/repos/ISHIMWE-Thierry/vegas-print-agent/releases/latest";
const RELEASE_EXE = "https://github.com/ISHIMWE-Thierry/vegas-print-agent/releases/latest/download/VegasPrint.exe";
const UPDATE_EVERY = 6 * 60 * 60 * 1000;
const IS_EXE = isWindows && /\.exe$/i.test(process.execPath) && !/node\.exe$/i.test(process.execPath);
const MARKER = path.join(HERE, "started.txt");

const fetchUrl = (url, hops = 0) =>
  new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error("too many redirects"));
    https.get(url, { headers: { "User-Agent": `VegasPrint/${VERSION}`, Accept: "*/*" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, url).href, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });

const semver = (v) => String(v || "").replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; } return false; };

async function checkUpdate() {
  if (!IS_EXE) return;
  let latest;
  try {
    latest = JSON.parse((await fetchUrl(RELEASE_API)).toString("utf8")).tag_name;
  } catch (e) {
    log("update check failed:", String(e).slice(0, 120));
    return;
  }
  if (!newer(latest, VERSION)) return;
  if (inFlight > 0) { log(`update ${latest} waits — a slip is printing`); setTimeout(() => void checkUpdate(), 60 * 1000); return; }
  log(`update: ${VERSION} -> ${latest}, downloading`);
  const exe = process.execPath;
  const fresh = path.join(HERE, "VegasPrint.new.exe");
  const old = path.join(HERE, "VegasPrint.old.exe");
  try {
    const body = await fetchUrl(RELEASE_EXE);
    if (body.length < 20 * 1024 * 1024 || body[0] !== 0x4d || body[1] !== 0x5a) throw new Error(`download does not look like the exe (${body.length} bytes)`);
    fs.writeFileSync(fresh, body);
  } catch (e) {
    log("update download failed:", String(e).slice(0, 160));
    return;
  }
  /* Plain ASCII, one line per step: the till's PowerShell policy blocks .ps1, cmd is always there. */
  const script = [
    "@echo off",
    "setlocal",
    "ping -n 4 127.0.0.1 >nul",
    `if exist "${old}" del /f /q "${old}"`,
    `move /y "${exe}" "${old}" >nul || exit /b 1`,
    `move /y "${fresh}" "${exe}" >nul || (move /y "${old}" "${exe}" >nul & exit /b 1)`,
    `if exist "${MARKER}" del /f /q "${MARKER}"`,
    `schtasks /Run /TN "${TASK}" >nul 2>&1 || start "" "${exe}"`,
    "ping -n 31 127.0.0.1 >nul",
    `if not exist "${MARKER}" (`,
    `  taskkill /f /im "${path.basename(exe)}" >nul 2>&1`,
    `  move /y "${old}" "${exe}" >nul`,
    `  schtasks /Run /TN "${TASK}" >nul 2>&1 || start "" "${exe}"`,
    ")",
    'del "%~f0"',
    "",
  ].join("\r\n");
  const cmdFile = path.join(HERE, "update.cmd");
  fs.writeFileSync(cmdFile, script, "ascii");
  log(`update: swapping in ${latest} and restarting`);
  const child = spawn("cmd.exe", ["/c", cmdFile], { detached: true, stdio: "ignore", windowsHide: true, cwd: HERE });
  child.unref();
  setTimeout(() => process.exit(0), 1500);
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

  /* A heartbeat every half minute, so the office can see from anywhere that
     this till's printer service is up — without printing a thing. */
  const host = os.hostname();
  const beat = () =>
    listPrinters((names) => {
      fs2
        .patch(key, "agents", host, {
          host, version: VERSION, platform: process.platform,
          lastSeen: new Date().toISOString(),
          printers: names.slice(0, 20),
          mapped: PRINTERS,
          pid: process.pid,
          howLast: lastHow,
          rawError: Object.keys(refused).map((p) => `${p}: ${refused[p].raw}`).join(" · "),
        })
        .catch((e) => log("heartbeat failed:", String(e).slice(0, 120)));
    });
  beat();
  setInterval(beat, HEARTBEAT_EVERY);

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

  /* Keep the till current: a minute after start, then every few hours. */
  setTimeout(() => void checkUpdate(), 60 * 1000);
  setInterval(() => void checkUpdate(), UPDATE_EVERY);
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

  /* The app lays the slip out and sends the bytes along; a job from an older app
     carries none and is laid out here instead. */
  const bytes = typeof job.data.base64 === "string" && job.data.base64
    ? Buffer.from(job.data.base64, "base64")
    : render(job.data);
  const ops = Array.isArray(job.data.lines) ? slipPage(job.data).ops : null;
  printSlip(printer, { bytes, ops, mode: job.data.mode === "page" ? "page" : "raw" }, async (err, how, why) => {
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
      log(`printed ${job.data.title || job.data.to} on ${printer} (${how})${why ? ` after ${why}` : ""}`);
      await fs2.patch(key, "printJobs", job.id, { status: "printed", how, why: why || "", printedAt: Date.now() });
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

module.exports = { render, printRaw, stripEscPos };
