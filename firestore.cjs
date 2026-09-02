/**
 * The bit of Firestore this agent needs, over plain HTTPS.
 *
 * The official SDK pulls in gRPC and a large dependency tree, which is the
 * difference between a single .exe anyone can double-click and an install that
 * needs Node and npm on the till. Everything here is REST plus Node's own crypto.
 */
const crypto = require("crypto");

const SCOPE = "https://www.googleapis.com/auth/datastore";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let cached = { token: null, until: 0 };

/** Trades the service-account key for an access token, and keeps it until it expires. */
async function token(key) {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.until - 60 > now) return cached.token;

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(key.private_key.replace(/\\n/g, "\n")))}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  cached = { token: body.access_token, until: now + (body.expires_in || 3600) };
  return cached.token;
}

const base = (key) =>
  `https://firestore.googleapis.com/v1/projects/${key.project_id}/databases/(default)/documents`;

/* --- Firestore's typed values, both ways ---------------------------------- */

function decode(v) {
  if (!v || typeof v !== "object") return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  if ("mapValue" in v) return fields(v.mapValue.fields || {});
  return undefined;
}
const fields = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decode(v)]));

function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
}

/* --- what the agent actually asks for ------------------------------------- */

/** Documents in a collection whose `field` equals `value`. */
async function where(key, collection, field, value, limit = 20) {
  const res = await fetch(`${base(key)}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await token(key)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: encode(value) } },
        limit,
      },
    }),
  });
  if (!res.ok) throw new Error(`query ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json())
    .filter((row) => row.document)
    .map((row) => ({
      id: row.document.name.split("/").pop(),
      updateTime: row.document.updateTime,
      data: fields(row.document.fields || {}),
    }));
}

/**
 * Writes some fields of a document.
 *
 * `ifUnchanged` is the update time the caller last saw. Firestore rejects the
 * write if anything touched the document since — which is how two terminals
 * watching the same queue never both claim the same slip, without needing a
 * transaction.
 */
async function patch(key, collection, id, values, ifUnchanged) {
  const mask = Object.keys(values).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const guard = ifUnchanged ? `&currentDocument.updateTime=${encodeURIComponent(ifUnchanged)}` : "";
  const res = await fetch(`${base(key)}/${collection}/${encodeURIComponent(id)}?${mask}${guard}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${await token(key)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, encode(v)])) }),
  });
  if (res.status === 409 || res.status === 412) return false; // someone got there first
  if (!res.ok) throw new Error(`patch ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

async function remove(key, collection, id) {
  const res = await fetch(`${base(key)}/${collection}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${await token(key)}` },
  });
  return res.ok;
}

module.exports = { where, patch, remove };
