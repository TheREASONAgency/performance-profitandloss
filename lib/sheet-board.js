/**
 * Turns the "Dashboard Data" sheet (a 2-D array of display strings) into the
 * board the Account Status tab draws. Pure functions, no I/O.
 *
 * Layout rules (see config.board):
 *   - Section labels ("Retention:", "Acquisition:") are column A cells ending in ":".
 *   - A header row has column A empty (or "Partner") and text in column B.
 *   - A data row has a label in column A. Blank cells stay blank.
 *   - A toggle lives in a fixed column per group. A row HAS a toggle when that
 *     cell is non-empty; its value is "On Track", "Off Track", or anything else = not set.
 */

const COLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const colIndex = (letter) => COLS.indexOf(letter.toUpperCase());
const cell = (row, i) => String((row && row[i]) == null ? "" : row[i]).trim();
const isBlankRow = (row) => !row || row.every((c) => String(c == null ? "" : c).trim() === "");

function fixHeader(text) {
  return text.replace(/acutal/i, (m) => (m[0] === "A" ? "Actual" : "actual"));
}

function parseToggleValue(text) {
  const t = String(text || "").trim().toLowerCase();
  if (/^on\b/.test(t)) return "on";
  if (/^off\b/.test(t)) return "off";
  return null;
}

function parseMoneyText(text) {
  const t = String(text || "").trim();
  if (!/^\$?\s*-?[\d,]+(\.\d+)?$/.test(t)) return null;
  const n = Number(t.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const fmtMoney = (n) =>
  n == null || !Number.isFinite(n)
    ? ""
    : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: n % 1 ? 2 : 0, minimumFractionDigits: n % 1 ? 2 : 0 });

/** Cell address like "F7" for a 0-based column index and 1-based sheet row. */
const addr = (colIdx, rowNum) => COLS[colIdx] + rowNum;

function parseBoard(values, board) {
  const rows = values || [];
  const tog = board.toggleColumns;
  const palette = board.groupTones;
  const out = { quarter: null, sections: [], groups: [] };

  // --- Quarterly goal block (row with "Quarterly Goal" in A and the row under it)
  const qi = rows.findIndex((r) => /^quarterly goal/i.test(cell(r, 0)));
  if (qi >= 0) {
    const head = rows[qi] || [];
    const val = rows[qi + 1] || [];
    const tcol = colIndex(tog.quarter);
    out.quarter = {
      labels: { revenue: cell(head, 1), actual: cell(head, 2) },
      revenue: cell(val, 1),
      actual: cell(val, 2),
      toggle: cell(head, tcol) ? { cell: addr(tcol, qi + 1), state: parseToggleValue(cell(head, tcol)) } : null,
    };
  }

  // --- Groups: each header row starts a new group.
  let current = null;
  let sectionLabel = null;
  const start = qi >= 0 ? qi + 2 : 0;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i] || [];
    if (isBlankRow(r)) { current = null; continue; }
    const a = cell(r, 0);

    if (a.endsWith(":")) { sectionLabel = a.replace(/:$/, ""); current = null; continue; }

    const looksLikeHeader = (a === "" || /^partner$/i.test(a)) && cell(r, 1) !== "";
    if (looksLikeHeader) {
      const isAcq = /^(acquisition)$/i.test(sectionLabel || "");
      const tcol = colIndex(isAcq ? tog.acquisition : tog.default);
      const headers = [];
      for (let c = 1; c < tcol; c++) headers.push(fixHeader(cell(r, c)));
      current = {
        section: sectionLabel,
        tone: palette[out.groups.length % palette.length],
        firstColLabel: a || "",
        headers,
        toggleCol: tcol,
        rows: [],
      };
      out.groups.push(current);
      continue;
    }

    if (current && a) {
      const cells = [];
      for (let c = 1; c < current.toggleCol; c++) cells.push(cell(r, c));
      const raw = cell(r, current.toggleCol);
      current.rows.push({
        label: a,
        row: i + 1,
        cells,
        toggle: raw ? { cell: addr(current.toggleCol, i + 1), state: parseToggleValue(raw) } : null,
      });
    }
  }
  return out;
}

/** Positions of every toggle cell, for the live toggle endpoint. */
function listToggles(boardModel) {
  const t = [];
  if (boardModel.quarter && boardModel.quarter.toggle) t.push({ id: "quarter", ...boardModel.quarter.toggle });
  boardModel.groups.forEach((g) =>
    g.rows.forEach((r) => { if (r.toggle) t.push({ id: r.label, ...r.toggle }); })
  );
  return t;
}

const norm = (s) => String(s || "").trim().toLowerCase();

/**
 * Fills BLANK cells from the live sources. A cell that already has a value in
 * the sheet is never overwritten, and a cell with no source stays empty.
 *
 * sources = { profitByLabel: {label: number}, managedByLabel: {label: {cpa, spend}},
 *             goalAmount }
 */
function fillActuals(boardModel, sources) {
  boardModel.groups.forEach((g) => {
    const idx = (re) => g.headers.findIndex((h) => re.test(h));
    const iActual = idx(/actual/i);
    const iCpa = g.headers.findIndex((h) => /^cpa$/i.test(h));
    const iRemain = idx(/remaining/i);
    const iSpend = idx(/total spend/i);

    g.rows.forEach((row) => {
      const key = norm(row.label);
      const set = (i, text, source) => {
        if (i >= 0 && text !== "" && row.cells[i] === "") {
          row.cells[i] = text;
          (row.filled = row.filled || []).push({ col: i, source });
        }
      };
      const profit = sources.profitByLabel && sources.profitByLabel[key];
      if (profit != null) set(iActual, fmtMoney(profit), "P&L tracker");

      const m = sources.managedByLabel && sources.managedByLabel[key];
      if (m) {
        if (m.cpa != null) set(iCpa, fmtMoney(m.cpa), "Monday (L7D CPA)");
        if (m.spend != null && m.spend > 0) {
          set(iSpend, fmtMoney(m.spend), "Monday (MTD Spend)");
          if (sources.goalAmount) set(iRemain, fmtMoney(Math.max(0, sources.goalAmount - m.spend)), "Goal minus spend");
        }
      }
    });
  });
  return boardModel;
}

/** Index source rows by sheet label using the config's label maps. */
function buildSources({ cpaRows, mondayManaged, matchesAny, board, goalAmount }) {
  const profitByLabel = {};
  Object.entries(board.profitRowMap || {}).forEach(([label, matchers]) => {
    const hits = (cpaRows || []).filter((r) => !r.placeholder && matchesAny(matchers, r.buyer, r.name));
    if (hits.length) profitByLabel[norm(label)] = hits.reduce((s, r) => s + (Number(r.profit) || 0), 0);
  });

  const managedByLabel = {};
  (mondayManaged || []).forEach((r) => {
    const code = norm(String(r.name || "").split(/[\s(]/)[0]);
    if (code) managedByLabel[code] = { cpa: r.cpaL7d, spend: r.adSpend };
  });
  return { profitByLabel, managedByLabel, goalAmount };
}

module.exports = { parseBoard, listToggles, fillActuals, buildSources, parseToggleValue, parseMoneyText, fmtMoney, colIndex };
