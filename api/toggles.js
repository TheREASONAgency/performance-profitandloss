/**
 * Live on/off-track toggles for the Account Status tab (Vercel serverless function).
 *
 *   GET  /api/toggles                 -> { toggles: { "<cell>": "on" | "off" | null } }
 *   POST /api/toggles {cell, state, passcode}  -> writes that ONE cell in the sheet
 *
 * Server-only secrets (Vercel env vars): GOOGLE_SA_KEY, TOGGLE_PASSCODE.
 * POST only writes cells that are real toggle cells in the sheet, and only the
 * two values "On Track" / "Off Track", so it cannot edit anything else.
 */
const crypto = require("crypto");
const config = require("../lib/status-config");
const sheets = require("../lib/google-sheets");
const sheetBoard = require("../lib/sheet-board");

const b = config.board;

function sameSecret(a, c) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(c || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function readToggles() {
  const values = await sheets.getValues(process.env[b.serviceAccountEnv], b.sheetId, b.range);
  return sheetBoard.listToggles(sheetBoard.parseBoard(values, b));
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const list = await readToggles();
      const toggles = {};
      list.forEach((t) => { toggles[t.cell] = t.state; });
      return res.status(200).json({ toggles });
    }

    if (req.method === "POST") {
      const expected = process.env[b.passcodeEnv];
      if (!expected) return res.status(503).json({ error: "Toggling is not set up (TOGGLE_PASSCODE missing)." });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      if (!sameSecret(body.passcode, expected)) return res.status(401).json({ error: "Wrong passcode." });
      if (body.state !== "on" && body.state !== "off") return res.status(400).json({ error: "Bad state." });

      const list = await readToggles();
      if (!list.some((t) => t.cell === body.cell)) return res.status(400).json({ error: "Not a toggle cell." });

      await sheets.setCell(process.env[b.serviceAccountEnv], b.sheetId, b.tab, body.cell, b.toggleLabels[body.state]);
      return res.status(200).json({ ok: true, cell: body.cell, state: body.state });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
