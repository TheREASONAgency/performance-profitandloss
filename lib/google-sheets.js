/**
 * Minimal Google Sheets client for a service account (no dependencies).
 * Used by the scheduled refresh job (read) and the toggle endpoint (read + one-cell write).
 * The key comes from the GOOGLE_SA_KEY environment variable and never reaches the browser.
 */
const crypto = require("crypto");

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const b64 = (x) => Buffer.from(x).toString("base64url");

let cached = null; // { token, exp }

function parseKey(raw) {
  if (!raw) throw new Error("GOOGLE_SA_KEY is not set");
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch (_) { throw new Error("GOOGLE_SA_KEY is not valid JSON"); }
}

async function getToken(rawKey, scope) {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.scope === scope && cached.exp - 60 > now) return cached.token;
  const key = parseKey(rawKey);
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({
    iss: key.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(key.private_key).toString("base64url");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${head}.${claim}.${sig}`,
    }),
  });
  if (!res.ok) throw new Error(`Google sign-in failed (HTTP ${res.status})`);
  const json = await res.json();
  cached = { token: json.access_token, exp: now + (json.expires_in || 3600), scope };
  return cached.token;
}

async function call(url, token, init) {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (res.status === 403 || res.status === 404) {
    throw new Error("Google Sheets denied access. Share the sheet with the service account (Editor to use toggles).");
  }
  if (!res.ok) throw new Error(`Google Sheets returned HTTP ${res.status}`);
  return res.json();
}

/** Display values (what you see in the sheet), 2-D array. */
async function getValues(rawKey, sheetId, range) {
  const token = await getToken(rawKey, "https://www.googleapis.com/auth/spreadsheets");
  const url = `${API}/${sheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`;
  return (await call(url, token)).values || [];
}

/** Write ONE cell, e.g. setCell(key, id, "Sheet1", "F7", "On Track"). */
async function setCell(rawKey, sheetId, tab, a1, value) {
  if (!/^[A-Z]{1,2}\d{1,4}$/.test(a1)) throw new Error("Bad cell address");
  const token = await getToken(rawKey, "https://www.googleapis.com/auth/spreadsheets");
  const range = `${tab}!${a1}`;
  const url = `${API}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  return call(url, token, { method: "PUT", body: JSON.stringify({ range, values: [[value]] }) });
}

module.exports = { getValues, setCell };
