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
 *   to?: string;
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

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;

/** Columns on an 80 mm roll in font A. Double width halves it. */
const WIDTH = 42;
const WIDE = WIDTH / 2;
const NAME_W = 26;
const QTY_W = 6;
const TOTAL_W = WIDTH - NAME_W - QTY_W;

/** 4200 → "4,200". No locale involved, so the exe and the browser agree. */
const money = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
    rule: (ch = "-") => line(ch.repeat(WIDTH)),
  };
}

/** One item on a line — name, quantity, total. A long name takes a line of its own. */
function rows(name, qty, total) {
  const nums = padL(qty, QTY_W) + padL(total, TOTAL_W);
  if (name.length <= NAME_W) return [padR(name, NAME_W) + nums];
  return [name.slice(0, WIDTH), " ".repeat(NAME_W) + nums];
}

function itemTable(o, lines) {
  o.size(0);
  o.rule();
  o.line(padR("Item", NAME_W) + padL("Qty", QTY_W) + padL("Total", TOTAL_W));
  o.rule();
  o.size(0x01); // taller rows, still the full 42 columns
  for (const l of lines || []) {
    for (const r of rows(ascii(l.name), String(l.qty ?? ""), money(l.total))) o.line(r);
  }
  o.size(0);
  o.rule();
}

function totalLine(o, total) {
  const amt = `${money(total)} RWF`;
  o.size(0x11);
  o.line(padR("TOTAL", Math.max(6, WIDE - amt.length)) + amt);
  o.size(0);
}

/** The customer's bill, laid out like the slip the old till printed. */
function bill(o, s) {
  o.centre();
  o.raw(FS, 0x70, 1, 0); // the logo, if one is stored in the printer's memory (ignored otherwise)
  o.size(0x11); o.line(BUSINESS.name);
  o.size(0x01); o.line(BUSINESS.tagline);
  o.size(0);
  o.line();
  o.line(`PHONE: ${BUSINESS.phone}`);
  o.line(`TIN: ${BUSINESS.tin}`);
  o.line(`MOMO PAY: ${s.momo || `${BUSINESS.momoNumber} / ${BUSINESS.momoName}`}`);
  o.line();
  o.line("*****");
  o.size(0x01); o.line("CUSTOMER BILL");
  o.size(0); o.line("Not Official Receipt");
  o.left();
  itemTable(o, s.lines);
  totalLine(o, s.total);
  o.rule();
  o.line();
  o.size(0x01); o.line(s.table ? `Table: ${s.table}` : s.title || ""); o.size(0);
  if (s.who) o.line(`Served by: ${s.who}`);
  if (s.note) o.line(`Status: ${s.note}`);
  o.line();
  o.centre(); o.line(BUSINESS.thanks);
  o.left();
  const at = s.at || "";
  o.line(padR(s.date || "", WIDTH - at.length) + at);
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
  itemTable(o, s.lines);
  totalLine(o, s.total);
  o.rule();
}

/**
 * ESC/POS for one slip. Everything is bold (ESC E 1 — the owner wants dark,
 * legible print); item rows are double height, the name and the total double
 * width too. Size and emphasis are reset before the cut so the next job starts clean.
 * @param {Slip} slip
 * @returns {Uint8Array}
 */
function escposBytes(slip) {
  const o = writer();
  o.raw(ESC, 0x40); // reset
  o.bold(true);
  if (slip.to === "bill") bill(o, slip);
  else copy(o, slip);
  o.size(0);
  o.bold(false);
  o.line(); o.line(); o.line();
  o.raw(GS, 0x56, 0x00); // full cut
  return Uint8Array.from(o.bytes);
}

/** A bill with the numbers from the owner's sample — what /selftest prints. */
const sample = (now = new Date()) => ({
  to: "bill", venue: "bar", who: "Synthia", table: "6", at: slipTime(now), date: slipDate(now),
  lines: [{ name: "G. FANTA", qty: 1, total: 1200 }, { name: "P. MUTZIG", qty: 2, total: 3000 }],
  total: 4200, note: "TO PAY",
});

module.exports = { escposBytes, BUSINESS, WIDTH, ascii, money, slipDate, slipTime, sample };
