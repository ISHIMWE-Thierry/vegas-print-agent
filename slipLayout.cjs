/**
 * The slip layout — the one place that decides what a printed slip looks like.
 *
 * Both print routes use it. The browser (lib/slip.ts) renders the bytes and
 * either hands them to the agent on the till or drops them, as `base64`, into
 * the print queue for the agent to spool. The agent (agent.cjs) loads this same
 * file for /selftest, for jobs queued by an older app, and for anything else
 * that POSTs a slip to it. Because the browser renders, a layout change ships
 * with `git push` — the tills do not need a new exe for it.
 *
 * Plain CommonJS on purpose: `node agent.cjs` loads it as-is, esbuild bundles
 * it into VegasPrint.exe, and Next.js imports it into the browser. Keep it
 * pure — no DOM, no Node APIs, strings and bytes only.
 */

/** What the customer sees at the top of the bill. Edit here; nothing else knows these. */
const BUSINESS = {
  name: "VEGAS MOTEL",
  tagline: "BAR & RESTAURANT",
  phone: "0785601615",
  tin: "146163522",
  /* The number customers pay to. The house can change it from Setup (after a
     Telegram code); the app then passes it on each bill as `momo`. */
  momoNumber: "0676708",
  momoName: "VEGAS INVESTMENT",
  thanks: "*** Thanks ***",
  bye: "Welcome again",
};

/**
 * @typedef {{ name: string; qty: number; total: number }} SlipLine
 * @typedef {{
 *   to?: string; // "bill" · "bar" · "kitchen" · "test"
 *   title?: string;
 *   venue?: string;
 *   who?: string;
 *   at?: string;
 *   date?: string;
 *   table?: string;
 *   lines: SlipLine[];
 *   total: number;
 *   note?: string;
 *   momo?: string;
 * }} Slip
 */

const { HEADER_RASTER } = require("./headerBits.cjs");

const ESC = 0x1b;
const GS = 0x1d;

/** Columns on an 80 mm roll in font A, as the old till used them. Double width halves it. */
const WIDTH = 42;
const WIDE = WIDTH / 2;
/* The old bill's columns: the name on its own line, then the quantity ending
   under "Qty" and the amount flush right under "Total". */
const ITEM_W = 22;
const QTY_W = 5;
const TOTAL_W = WIDTH - ITEM_W - QTY_W;
/** Where the time sits on the date line — not flush right, as on the old bill. */
const TIME_AT = 24;

/** 4200 → "4200", the way the old till wrote money. No locale, so the exe and the browser agree. */
const money = (n) => String(Math.round(Number(n) || 0));
const padR = (s, w) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));
const padL = (s, w) => (s.length >= w ? s : " ".repeat(w - s.length) + s);

/** Thermal heads print plain ASCII: accents come off, the odd symbol is swapped. */
const ascii = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[×✕]/g, "x")
    .replace(/[·•]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e]/g, "?");

/** 9/8/2026 — the day, the way the old till wrote it. */
const slipDate = (d = new Date()) => `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
/** 17:32 */
const slipTime = (d = new Date()) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** A black bar, 576 x 16 dots: the smallest artwork that shows whether a head takes rasters. */
var TEST_BAR = (() => {
  const rows = 16, perRow = 72;
  const b = [GS, 0x76, 0x30, 0x00, perRow & 0xff, perRow >> 8, rows & 0xff, rows >> 8];
  for (let i = 0; i < rows * perRow; i++) b.push(0xff);
  return b;
})();

function writer() {
  /** @type {number[]} */
  const bytes = [];
  const raw = (...b) => { bytes.push(...b); };
  const text = (s) => { for (const ch of ascii(s)) bytes.push(ch.charCodeAt(0)); };
  const line = (s = "") => { text(s); bytes.push(0x0a); };
  return {
    bytes, raw, line,
    centre: () => raw(ESC, 0x61, 1),
    left: () => raw(ESC, 0x61, 0),
    /** 0 normal · 0x01 double height · 0x11 double width and height */
    size: (n) => raw(GS, 0x21, n),
    bold: (on) => raw(ESC, 0x45, on ? 1 : 0),
    /** Double-strike: every dot burnt twice. On thermal heads this is the darkest text there is. */
    strike: (on) => raw(ESC, 0x47, on ? 1 : 0),
    /** Print density for this job: GS ( K fn 50, +6 steps (about 130 %). A head that
     *  does not know the function skips it — the length bytes see to that. */
    dark: () => raw(GS, 0x28, 0x4b, 0x02, 0x00, 0x32, 0x06),
    /** Artwork (GS v 0 raster) from base64 — atob is in every browser and in node. */
    image: (b64) => { const bin = atob(b64); for (let i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i)); },
    rule: (ch = "-") => line(ch.repeat(WIDTH)),
    /** The black bar of the test slip. */
    bar: () => raw(...TEST_BAR),
  };
}

/**
 * The same slip as a list of drawing steps instead of printer bytes — for a
 * till that prints through its Windows driver, like a document: each step is
 * a line of text with its size and alignment, a rule, the header, or the
 * test bar. The layout functions below do not know which writer they get.
 */
function pageWriter() {
  /** @type {{ k: "line" | "rule" | "logo" | "bar"; s?: string; size?: number; centre?: boolean }[]} */
  const ops = [];
  let centre = false, size = 0;
  return {
    ops,
    raw: () => {},
    line: (s = "") => { ops.push({ k: "line", s: ascii(s), size, centre }); },
    centre: () => { centre = true; },
    left: () => { centre = false; },
    size: (n) => { size = n === 0x11 ? 2 : n === 0x01 ? 1 : 0; },
    bold: () => {}, strike: () => {}, dark: () => {},
    image: () => { ops.push({ k: "logo" }); },
    rule: () => { ops.push({ k: "rule" }); },
    bar: () => { ops.push({ k: "bar" }); },
  };
}

/** The table the old till printed: a name line, then the quantity and amount on the next. */
function itemTable(o, lines) {
  o.size(0);
  o.rule();
  o.line(padR("Item", ITEM_W) + padL("Qty", QTY_W) + padL("Total", TOTAL_W));
  o.rule();
  for (const l of lines || []) {
    o.line(ascii(l.name).slice(0, WIDTH));
    o.line(" ".repeat(ITEM_W) + padL(String(l.qty ?? ""), QTY_W) + padL(money(l.total), TOTAL_W));
  }
  o.rule();
}

function totalLine(o, total) {
  o.line(padL("TOTAL", ITEM_W + QTY_W) + padL(money(total), TOTAL_W));
  o.rule();
}

/** The customer's bill, line for line the slip the old till printed. */
function bill(o, s, art) {
  o.centre();
  if (art) {
    o.image(HEADER_RASTER); // the VG mark, VEGAS MOTEL, BAR & RESTAURANT — as artwork, so it prints heavy
  } else {
    // Until the till has proved it prints artwork, the name in the head's own big type.
    o.size(0x11); o.line(BUSINESS.name);
    o.size(0x01); o.line(BUSINESS.tagline);
    o.size(0);
  }
  o.line();
  o.line(`PHONE:${BUSINESS.phone}`);
  o.line(`TIN:${BUSINESS.tin}`);
  o.line(`MOMO PAY: ${s.momo || `${BUSINESS.momoNumber} /${BUSINESS.momoName}`}`);
  o.line();
  o.line("*****");
  o.line("CUSTOMER BILL");
  o.line("Not Official Receipt");
  o.left();
  o.line();
  itemTable(o, s.lines);
  totalLine(o, s.total);
  o.line(); o.line();
  o.line(`Table: ${s.table ? `Table ${s.table}` : s.title || ""}`);
  if (s.who) o.line(`Served by:${s.who}`);
  o.line(); o.line(); o.line();
  o.centre(); o.line(BUSINESS.thanks);
  o.left();
  o.line();
  o.line(padR(s.date || "", TIME_AT) + (s.at || ""));
  o.rule("*");
  o.centre(); o.line(BUSINESS.bye);
}

/** A bar or kitchen copy — what the floor needs, nothing the customer needs. */
function copy(o, s) {
  o.centre();
  o.size(0x11); o.line(s.title || (s.table ? `TABLE ${s.table}` : BUSINESS.name));
  if (s.note) { o.size(0x01); o.line(s.note); }
  o.size(0);
  const meta = [s.venue ? String(s.venue).toUpperCase() : "", s.date || "", s.at || ""].filter(Boolean).join("  ");
  if (meta) o.line(meta);
  if (s.who) o.line(s.who);
  o.left();
  o.line();
  itemTable(o, s.lines);
  totalLine(o, s.total);
}


/**
 * The test slip the office prints from Setup before switching artwork on. It
 * is short on purpose: if the head cannot take a raster, sixteen rows of a
 * black bar come out as a few lines of stray characters — not a metre of them.
 */
function testSlip(o) {
  o.centre();
  o.size(0x11); o.line("PRINT TEST"); o.size(0);
  o.line(`${BUSINESS.name} - ${slipDate()} ${slipTime()}`);
  o.line();
  o.left();
  o.line("1. A black bar should print here:");
  o.bar();
  o.line();
  o.line("   Bar: artwork works - switch it on.");
  o.line("   Letters or numbers: keep artwork off.");
  o.line();
  o.line("2. Odd characters at the very top mean");
  o.line("   this head ignores the darker burn.");
  o.line();
  o.line("Bold and double-struck: THIS LINE");
  o.strike(false); o.bold(false);
  o.line("Plain, for comparison: THIS LINE");
  o.bold(true); o.strike(true);
}

/**
 * ESC/POS for one slip. Everything is bold and double-struck (ESC E, ESC G) —
 * the owner's bills came out thin. With `art` on (the office switches it on
 * once the till has printed the test slip cleanly) the bill opens with the
 * artwork header and the job asks the head for a darker burn (GS ( K); off,
 * the name prints in the head's own big type and nothing is sent that a
 * plain head could mistake for text. The rest is font A, 42 columns, laid
 * out like the old till's slip. Size and emphasis are reset before the cut.
 * @param {Slip} slip
 * @param {{ art?: boolean }} [opts]
 * @returns {Uint8Array}
 */
function escposBytes(slip, opts = {}) {
  const art = !!opts.art || slip.to === "test";
  const o = writer();
  o.raw(ESC, 0x40); // reset
  if (art) o.dark(); // burn darker for this job
  o.bold(true);
  o.strike(true);
  if (slip.to === "bill") bill(o, slip, art);
  else if (slip.to === "test") testSlip(o);
  else copy(o, slip);
  o.size(0);
  o.strike(false);
  o.bold(false);
  o.line(); o.line(); o.line();
  o.raw(GS, 0x56, 0x00); // full cut
  return Uint8Array.from(o.bytes);
}

/**
 * The same slip as drawing steps, for a till printing through its Windows
 * driver ("as a page"). The bill's header is always the name in big type
 * there — the driver draws fonts itself, no raster needed.
 * @param {Slip} slip
 * @returns {{ ops: { k: "line" | "rule" | "logo" | "bar"; s?: string; size?: number; centre?: boolean }[] }}
 */
function slipPage(slip) {
  const o = pageWriter();
  if (slip.to === "bill") bill(o, slip, false);
  else if (slip.to === "test") testSlip(o);
  else copy(o, slip);
  return { ops: o.ops };
}

/**
 * The drawing steps as one line each, for the till's PowerShell to read:
 * "L|0|text" / "C|2|VEGAS MOTEL" (alignment, size, text), "R" a rule,
 * "X" the test bar, "G" the header artwork.
 * @param {{ k: string; s?: string; size?: number; centre?: boolean }[]} ops
 */
function pageText(ops) {
  return ops.map((op) => (op.k === "line" ? `${op.centre ? "C" : "L"}|${op.size || 0}|${op.s || ""}` : op.k === "rule" ? "R" : op.k === "bar" ? "X" : "G")).join("\r\n") + "\r\n";
}

/** A bill with the numbers from the owner's sample — what /selftest prints. */
const sample = (now = new Date()) => ({
  to: "bill", venue: "bar", who: "Synthia", table: "6", at: slipTime(now), date: slipDate(now),
  lines: [{ name: "G. FANTA", qty: 1, total: 1200 }, { name: "P. MUTZIG", qty: 2, total: 3000 }],
  total: 4200, note: "TO PAY",
});

/** The agent version the app was released with; Setup warns a till running an older one. */
const AGENT_LATEST = "1.6.0";

module.exports = { escposBytes, slipPage, pageText, BUSINESS, WIDTH, ascii, money, slipDate, slipTime, sample, AGENT_LATEST };
