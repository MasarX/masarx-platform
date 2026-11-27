'use strict';
// Reads the DESIGN.md speed table, the one source of page budgets (#301).
// The speed spec and the docs test both use this parser, so a row either parses here or fails both.
const fs = require('node:fs');
const path = require('node:path');

const DESIGN_PATH = path.join(__dirname, '..', '..', 'DESIGN.md');
const COLUMNS = ['screen', 'usable', 'updating', 'target', 'tolerance', 'journey'];

function readSpeedBudgets(markdown = fs.readFileSync(DESIGN_PATH, 'utf8')) {
  const section = markdown.split(/^### Speed\s*$/m)[1];
  if (!section) throw new Error('DESIGN.md has no "### Speed" section');
  const lines = section.split(/^#{2,3} /m)[0].split(/\r?\n/).filter((line) => line.startsWith('|'));
  // The first two table lines are the header and its separator.
  return lines.slice(2).map((line, index) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== COLUMNS.length) {
      throw new Error(`speed row ${index + 1}: expected ${COLUMNS.length} cells, found ${cells.length}`);
    }
    const row = Object.fromEntries(COLUMNS.map((key, i) => [key, cells[i]]));
    const blank = COLUMNS.find((key) => !row[key] || /\bTBD\b/i.test(row[key]));
    if (blank) throw new Error(`speed row "${row.screen}": ${blank} is blank or TBD`);
    const route = /`([^`]+)`/.exec(row.screen);
    const lcp = /LCP ≤ (\d+(?:\.\d+)?) s/.exec(row.target);
    const inp = /INP ≤ (\d+) ms/.exec(row.target);
    const tolerance = /^\+(\d+)%$/.exec(row.tolerance);
    if (!route || !lcp || !inp || !tolerance) {
      throw new Error(`speed row "${row.screen}": needs a \`route\`, "LCP ≤ n s", "INP ≤ n ms" and a "+n%" tolerance`);
    }
    const spec = /`([a-z0-9-]+-p75)`/.exec(row.journey);
    return {
      ...row,
      route: route[1],
      lcpMs: Number(lcp[1]) * 1000,
      inpMs: Number(inp[1]),
      toleranceRatio: Number(tolerance[1]) / 100,
      spec: spec ? spec[1] : null,
    };
  });
}

module.exports = { readSpeedBudgets, DESIGN_PATH };
