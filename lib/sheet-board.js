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

  // --- Goal rows: "Quarterly Goal:" and "Monthly Goal:" each hold Total Revenue (B),
  // Actual Revenue (C) and a toggle (E). Column labels come from the row above them.
  const isGoal = (r) => /^(quarterly|monthly)\s+goal/i.test(cell(r, 0));
  const tcolGoal = colIndex(tog.quarter);
  const goalRows = [];
  rows.forEach((r, i) => {
    if (!isGoal(r)) return;
    const raw = cell(r, tcolGoal);
    goalRows.push({
      kind: /^monthly/i.test(cell(r, 0)) ? "monthly" : "quarterly",
      label: cell(r, 0).replace(/:$/, ""),
      revenue: cell(r, 1),
      actual: cell(r, 2),
      toggle: raw ? { cell: addr(tcolGoal, i + 1), state: parseToggleValue(raw) } : null,
    });
  });
  const lastGoal = rows.reduce((n, r, i) => (isGoal(r) ? i : n), -1);
  if (goalRows.length) {
    const firstGoal = rows.findIndex(isGoal);
    const head = firstGoal > 0 ? rows[firstGoal - 1] || [] : [];
    out.goals = {
      labels: { revenue: cell(head, 1) || "Total Revenue", actual: cell(head, 2) || "Actual Revenue" },
      rows: goalRows,
    };
    out.quarter = goalRows[0]; // kept for older readers of the snapshot
  }

  // --- Groups: each header row starts a new group.
  let current = null;
  let sectionLabel = null;
  const start = lastGoal + 1; // first row after the last goal row (0 when there are none)
  for (let i = start; i < rows.length; i++) {
    const r = rows[i] || [];
    if (isBlankRow(r)) { current = null; continue; }
    const a = cell(r, 0);

    // "Retention:" / "Acquisition:" alone on a row start a section; "Total:" with numbers beside it is a data row.
    const restBlank = r.slice(1).every((c) => String(c == null ? "" : c).trim() === "");
    if (a.endsWith(":") && restBlank) { sectionLabel = a.replace(/:$/, ""); current = null; continue; }

    // A header row has text (not a number) in column B and either an empty/"Partner" label
    // or a label that starts a fresh group (e.g. "October" right under "Acquisition:").
    const b1 = cell(r, 1);
    const textB = b1 !== "" && !/^[\s$#\d.,%-]/.test(b1);
    const looksLikeHeader = textB && (a === "" || /^partner$/i.test(a) || current === null);
    if (looksLikeHeader) {
      const isAcq = /^(acquisition)$/i.test(sectionLabel || "");
      const tcol = colIndex(isAcq ? tog.acquisition : tog.default);
      const headers = [];
      for (let c = 1; c < tcol; c++) headers.push(fixHeader(cell(r, c)));
      current = {
        section: sectionLabel,
        tone: isAcq ? palette[palette.length - 1] : palette[out.groups.filter((x) => x.section !== sectionLabel || !isAcq).length % (palette.length - 1)],
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
        total: /^total\b/i.test(a),
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
  if (boardModel.goals) {
    boardModel.goals.rows.forEach((g) => { if (g.toggle) t.push({ id: g.kind, ...g.toggle }); });
  } else if (boardModel.quarter && boardModel.quarter.toggle) {
    t.push({ id: "quarter", ...boardModel.quarter.toggle });
  }
  boardModel.groups.forEach((g) =>
    g.rows.forEach((r) => { if (r.toggle) t.push({ id: r.label, ...r.toggle }); })
  );
  return t;
}

const norm = (s) => String(s || "").trim().toLowerCase();

/** A cell counts as "empty" for the Monday fallback when blank or a zero ($0, 0). */
const isEmptyCell = (v) => v === "" || /^\$?\s*0(\.0+)?$/.test(String(v).trim());

/**
 * Fills cells from the live sources. A cell that already has a value in the
 * sheet is never overwritten (including Meta's numbers), and a cell with no
 * source stays empty. The Monday board is a fallback only: it fills cells that
 * are blank or zero, and only with a real (non-zero) Monday value.
 *
 * sources = { profitByLabel: {label: number},
 *             mondayByLabel: {label: {cpa, spend}}, goalAmount }
 */
function fillActuals(boardModel, sources) {
  boardModel.groups.forEach((g) => {
    const idx = (re) => g.headers.findIndex((h) => re.test(h));
    const iActual = idx(/actual/i);
    const iCpa = g.headers.findIndex((h) => /^cpa$/i.test(h));
    const iRemain = idx(/remaining/i);
    const iSpend = idx(/total spend/i);
    const kind = /target spend/i.test(g.headers[0] || "") ? "spend"
      : /target profit/i.test(g.headers[0] || "") ? "profit"
      : iSpend >= 0 ? "pv" : "other";

    g.rows.forEach((row) => {
      const key = norm(row.label);
      const set = (i, text, source, { zeroOk = false } = {}) => {
        if (i < 0 || text === "") return false;
        const empty = zeroOk ? isEmptyCell(row.cells[i]) : row.cells[i] === "";
        if (!empty) return false;
        row.cells[i] = text;
        (row.filled = row.filled || []).push({ col: i, source });
        return true;
      };

      // Profit rows: Actual MTD is profit from the P&L tracker.
      const profit = sources.profitByLabel && sources.profitByLabel[key];
      if (profit != null && kind === "profit") set(iActual, fmtMoney(profit), "P&L tracker");

      // Monday fallback (blank or zero cells only, real values only).
      const m = sources.mondayByLabel && sources.mondayByLabel[key];
      if (!m) return;
      if (m.cpa != null && m.cpa > 0) set(iCpa, fmtMoney(m.cpa), "Monday (L7D CPA)", { zeroOk: true });
      if (m.spend != null && m.spend > 0) {
        if (kind === "spend") set(iActual, fmtMoney(m.spend), "Monday (MTD Spend)", { zeroOk: true });
        if (kind === "pv") {
          const filled = set(iSpend, fmtMoney(m.spend), "Monday (MTD Spend)", { zeroOk: true });
          // Remaining spend is derived from total spend, so refresh it when spend came from Monday.
          if (filled && sources.goalAmount && iRemain >= 0) {
            row.cells[iRemain] = fmtMoney(Math.max(0, sources.goalAmount - m.spend));
            row.filled.push({ col: iRemain, source: "Goal minus spend" });
          }
        }
      }
    });
  });
  return boardModel;
}

/** Index source rows by sheet label using the config's label maps. */
function buildSources({ cpaRows, mondayAll, matchesAny, board, goalAmount }) {
  const profitByLabel = {};
  Object.entries(board.profitRowMap || {}).forEach(([label, matchers]) => {
    const hits = (cpaRows || []).filter((r) => !r.placeholder && matchesAny(matchers, r.buyer, r.name));
    if (hits.length) profitByLabel[norm(label)] = hits.reduce((s, r) => s + (Number(r.profit) || 0), 0);
  });

  // Monday: first word of the account name is the sheet label ("GAL (<$400)" -> GAL);
  // aliases cover accounts named differently. Active rows beat closed / non-account groups.
  const aliases = board.mondayAliases || {};
  const rank = (r) => (r.closed ? 2 : r.groupExcluded ? 1 : 0);
  const mondayByLabel = {};
  (mondayAll || []).forEach((r) => {
    const name = norm(r.name);
    const keys = [norm(name.split(/[\s(]/)[0])];
    Object.entries(aliases).forEach(([label, text]) => { if (name.includes(norm(text))) keys.push(norm(label)); });
    keys.forEach((k) => {
      if (!k) return;
      const cur = mondayByLabel[k];
      if (!cur || rank(r) < cur.rank) mondayByLabel[k] = { cpa: r.cpaL7d, spend: r.adSpend, rank: rank(r) };
    });
  });
  return { profitByLabel, mondayByLabel, goalAmount };
}

module.exports = { parseBoard, listToggles, fillActuals, buildSources, parseToggleValue, parseMoneyText, fmtMoney, colIndex };
