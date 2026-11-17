#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    in: path.join('docs', 'database', 'schema-audit', 'LIVE_AUDIT.json'),
    format: 'md',
    out: '',
    maxTables: 1000,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--in') out.in = String(args[++i] || '').trim();
    else if (a === '--out') out.out = String(args[++i] || '').trim();
    else if (a === '--format') out.format = String(args[++i] || '').trim();
    else if (a === '--max-tables') out.maxTables = Math.max(1, parseInt(args[++i] || '0', 10) || 1000);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function readJson(filePath) {
  const raw = filePath === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function writeFile(outPath, body) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body, 'utf8');
}

function countBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const key = keyFn(it);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function parseReferenceTable(constraintDef) {
  const m = String(constraintDef || '').match(/\bREFERENCES\s+([A-Za-z0-9_\.\"]+)/i);
  if (!m) return '';
  const raw = m[1].replace(/"/g, '');
  return raw.split('.').pop();
}

function normalizeColumns(columns) {
  if (Array.isArray(columns)) return columns.map((c) => String(c)).filter(Boolean);
  if (columns == null) return [];
  if (typeof columns === 'string') {
    const t = columns.trim();
    if (!t) return [];
    if (t.startsWith('{') && t.endsWith('}')) {
      const inner = t.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map((c) => c.replace(/^"+|"+$/g, '').trim()).filter(Boolean);
    }
    return t.split(',').map((c) => c.trim()).filter(Boolean);
  }
  return [String(columns)];
}

function parseFkIndexIssue(issue) {
  const obj = String(issue.object || '');
  const parts = obj.split('.');
  if (parts.length < 3) return null;
  const schema = parts[0];
  const table = parts[1];
  const constraint = parts.slice(2).join('.');
  const m = String(issue.message || '').match(/\bon\s+\(([^)]+)\)/i);
  const cols = m ? m[1].split(',').map((c) => c.trim()).filter(Boolean) : [];
  return { schema, table, constraint, columns: cols };
}

function parseIndexMeta(definition) {
  const raw = String(definition || '');
  const method = (raw.match(/\bUSING\s+([a-z0-9_]+)/i) || [])[1] || '';
  const where = raw.split(/\bWHERE\b/i)[1] || '';
  const nullsNotDistinct = /\bNULLS\s+NOT\s+DISTINCT\b/i.test(raw);
  return {
    method: method.toLowerCase(),
    predicate: where.trim(),
    nullsNotDistinct,
  };
}

function isLiteralListCheck(definition) {
  const def = String(definition || '');
  return /\bIN\s*\(/i.test(def) || /ARRAY\s*\[/i.test(def);
}

function renderMarkdown(audit, opts) {
  const maxTables = opts.maxTables || 1000;
  const lines = [];
  const meta = audit.meta || {};
  const summary = audit.summary || {};
  const issues = Array.isArray(audit.issues) ? audit.issues : [];

  lines.push('# Live Schema Audit Summary');
  lines.push('');
  lines.push(`Generated: ${meta.generatedAt || '(unknown)'}`);
  lines.push(`Schemas: ${(meta.schemas || []).join(', ') || '(unknown)'}`);
  lines.push('');

  lines.push('## Inventory');
  if (summary.relationCount != null) lines.push(`- Relations (scanned): ${summary.relationCount}`);
  lines.push(`- Base tables: ${summary.baseTableCount ?? '(unknown)'}`);
  if (summary.viewCount != null) lines.push(`- Views: ${summary.viewCount}`);
  if (summary.materializedViewCount != null) lines.push(`- Materialized views: ${summary.materializedViewCount}`);
  lines.push(`- Partitioned parents: ${summary.partitionedTableCount ?? '(unknown)'}`);
  lines.push(`- Partition leaves (via partition_inventory): ${summary.partitionLeafCount ?? '(n/a)'}`);
  lines.push(`- User-facing objects: ${summary.userFacingCount ?? summary.userFacingTableCount ?? '(unknown)'}`);
  lines.push(`- Service-only objects: ${summary.serviceOnlyCount ?? summary.serviceOnlyTableCount ?? '(unknown)'}`);
  lines.push('');

  const sevOrder = ['critical', 'high', 'medium', 'low', 'info'];
  const bySev = countBy(issues, (i) => i.severity || 'unknown');
  lines.push('## Issue Counts');
  for (const sev of sevOrder) {
    if (!bySev.has(sev)) continue;
    lines.push(`- ${sev}: ${bySev.get(sev)}`);
  }
  lines.push('');

  const important = issues.filter((i) => i.severity === 'critical' || i.severity === 'high');
  lines.push('## Critical / High');
  if (!important.length) {
    lines.push('- (none)');
  } else {
    for (const it of important) {
      lines.push(`- [${it.code}] ${it.object}: ${it.message}`);
    }
  }
  lines.push('');

  const fkIndexIssues = issues.filter((i) => i.code === 'FK_INDEX_MISSING').map(parseFkIndexIssue).filter(Boolean);
  const fkByTable = new Map();
  for (const item of fkIndexIssues) {
    const key = `${item.schema}.${item.table}`;
    if (!fkByTable.has(key)) fkByTable.set(key, []);
    fkByTable.get(key).push(item);
  }
  const fkTables = [...fkByTable.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  lines.push('## Foreign Keys Missing Supporting Indexes');
  lines.push(`- Total: ${fkIndexIssues.length}`);
  lines.push('');
  if (!fkIndexIssues.length) {
    lines.push('- (none)');
    lines.push('');
  } else {
    for (const [tableKey, list] of fkTables.slice(0, maxTables)) {
      lines.push(`### ${tableKey} (${list.length})`);
      for (const fk of list) {
        const cols = fk.columns.length ? fk.columns.join(', ') : '(unknown columns)';
        lines.push(`- ${fk.constraint}: (${cols})`);
      }
      lines.push('');
    }
    if (fkTables.length > maxTables) {
      lines.push(`- (truncated) remaining tables: ${fkTables.length - maxTables}`);
      lines.push('');
    }
  }

  // FK redundancy analysis (leaf vs parent, duplicates).
  const tables = Array.isArray(audit.tables) ? audit.tables : [];
  const allTableNames = new Set(tables.filter((t) => t && t.schema === 'public').map((t) => t.name));

  const leafAndParentPairs = [];
  const leafOnly = [];
  const exactDuplicates = [];

  for (const t of tables) {
    if (!t || !Array.isArray(t.constraints)) continue;
    const fks = t.constraints.filter(
      (c) => c.type === 'FOREIGN KEY' && Number(c.parentConstraintOid || 0) === 0,
    );
    if (!fks.length) continue;

    const byCols = new Map();
    const byColsAndRef = new Map();

    for (const fk of fks) {
      const cols = normalizeColumns(fk.columns);
      const colsKey = cols.join(',');
      const ref = parseReferenceTable(fk.definition);
      if (!byCols.has(colsKey)) byCols.set(colsKey, []);
      byCols.get(colsKey).push({ name: fk.name, ref, cols });

      const key = `${colsKey} -> ${ref}`;
      if (!byColsAndRef.has(key)) byColsAndRef.set(key, []);
      byColsAndRef.get(key).push({ name: fk.name, ref, cols });
    }

    for (const [key, list] of byColsAndRef.entries()) {
      if (list.length > 1) {
        exactDuplicates.push({
          table: `${t.schema}.${t.name}`,
          key,
          constraints: list.map((x) => x.name),
        });
      }
    }

    for (const [colsKey, list] of byCols.entries()) {
      if (list.length < 2) continue;
      const leaf = list.find((x) => /_p0$/i.test(x.ref));
      if (!leaf) continue;
      const base = leaf.ref.replace(/_p0$/i, '');
      const hasBase = list.some((x) => x.ref === base);
      if (hasBase) {
        leafAndParentPairs.push({
          table: `${t.schema}.${t.name}`,
          cols: colsKey,
          base,
          leaf: leaf.ref,
          leafConstraint: leaf.name,
        });
        continue;
      }
      if (base && allTableNames.has(base)) {
        leafOnly.push({
          table: `${t.schema}.${t.name}`,
          cols: colsKey,
          base,
          leaf: leaf.ref,
          leafConstraint: leaf.name,
        });
      }
    }
  }

  leafAndParentPairs.sort((a, b) => a.table.localeCompare(b.table) || a.cols.localeCompare(b.cols));
  leafOnly.sort((a, b) => a.table.localeCompare(b.table) || a.cols.localeCompare(b.cols));
  exactDuplicates.sort((a, b) => a.table.localeCompare(b.table) || a.key.localeCompare(b.key));

  lines.push('## FK Redundancy / Partition Leaf Risks');
  lines.push('');

  lines.push('### Redundant leaf+parent FKs (same columns)');
  lines.push(`- Count: ${leafAndParentPairs.length}`);
  if (!leafAndParentPairs.length) {
    lines.push('- (none)');
  } else {
    for (const r of leafAndParentPairs) {
      lines.push(`- ${r.table} (${r.cols}): ${r.leafConstraint} references ${r.leaf} and also references ${r.base}`);
    }
  }
  lines.push('');

  lines.push('### Leaf-only FKs (future hash expansion blockers)');
  lines.push(`- Count: ${leafOnly.length}`);
  if (!leafOnly.length) {
    lines.push('- (none)');
  } else {
    for (const r of leafOnly) {
      lines.push(`- ${r.table} (${r.cols}): ${r.leafConstraint} references ${r.leaf} (no FK to ${r.base})`);
    }
  }
  lines.push('');

  lines.push('### Exact duplicate FK constraints (same columns and same referenced table)');
  lines.push(`- Count: ${exactDuplicates.length}`);
  if (!exactDuplicates.length) {
    lines.push('- (none)');
  } else {
    for (const d of exactDuplicates) {
      lines.push(`- ${d.table}: ${d.key} -> ${d.constraints.join(', ')}`);
    }
  }
  lines.push('');

  // Index redundancy analysis (exact duplicates: same method, same columns, same predicate).
  const indexDupes = [];
  for (const t of tables) {
    if (!t || !Array.isArray(t.indexes)) continue;
    const byKey = new Map();
    for (const idx of t.indexes) {
      const cols = normalizeColumns(idx.columns);
      if (!cols.length) continue;
      const metaIdx = parseIndexMeta(idx.definition);
      const key = `${metaIdx.method}|${cols.join(',')}|${metaIdx.predicate}|${metaIdx.nullsNotDistinct ? '1' : '0'}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({
        name: idx.name,
        unique: Boolean(idx.unique),
        primary: Boolean(idx.primary),
        predicate: metaIdx.predicate,
        method: metaIdx.method,
        nullsNotDistinct: metaIdx.nullsNotDistinct,
      });
    }
    for (const [key, list] of byKey.entries()) {
      if (list.length < 2) continue;
      indexDupes.push({
        table: `${t.schema}.${t.name}`,
        key,
        indexes: list.map((x) => `${x.name}${x.primary ? ' (PRIMARY)' : x.unique ? ' (UNIQUE)' : ''}`),
      });
    }
  }
  indexDupes.sort((a, b) => a.table.localeCompare(b.table) || a.key.localeCompare(b.key));

  lines.push('## Index Redundancy (Exact Duplicates)');
  lines.push(`- Duplicate groups: ${indexDupes.length}`);
  if (!indexDupes.length) {
    lines.push('- (none)');
  } else {
    const sample = indexDupes.slice(0, maxTables);
    for (const d of sample) {
      lines.push(`- ${d.table}: ${d.indexes.join(', ')}`);
    }
    if (indexDupes.length > sample.length) {
      lines.push(`- (truncated) remaining groups: ${indexDupes.length - sample.length}`);
    }
  }
  lines.push('');

  // Hardcoded enum checks (literal list via IN(...) or ANY(ARRAY[...]) patterns).
  const literalChecks = [];
  for (const t of tables) {
    if (!t || !Array.isArray(t.constraints)) continue;
    for (const c of t.constraints) {
      if (c.type !== 'CHECK') continue;
      if (!isLiteralListCheck(c.definition)) continue;
      literalChecks.push({
        table: `${t.schema}.${t.name}`,
        name: c.name,
      });
    }
  }
  literalChecks.sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name));

  lines.push('## CHECK Constraints With Literal Lists');
  lines.push(`- Count: ${literalChecks.length}`);
  if (!literalChecks.length) {
    lines.push('- (none)');
  } else {
    const sample = literalChecks.slice(0, maxTables);
    for (const it of sample) {
      lines.push(`- ${it.table}: ${it.name}`);
    }
    if (literalChecks.length > sample.length) {
      lines.push(`- (truncated) remaining checks: ${literalChecks.length - sample.length}`);
    }
  }
  lines.push('');

  lines.push('## Recommended Next Steps (Prod Readiness)');
  lines.push('- Add missing FK indexes (prioritize partitioned/high-volume tables + RLS-filter columns).');
  lines.push('- Avoid user-defined FKs that reference partition leaves (e.g., *_p0) when an equivalent parent FK exists; Postgres may create child constraints automatically.');
  lines.push('- Replace leaf-only FKs with parent FKs when referenced tables are partitioned parents with valid unique keys.');
  lines.push('- Treat extension-owned tables (e.g., spatial_ref_sys) as explicit exceptions (or lock down grants) to avoid accidental user-facing classification drift.');
  lines.push('');

  return lines.join('\n') + '\n';
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/tooling/schema-audit-summarize.js [--in <audit.json>] [--out <file>] [--format md|json] [--max-tables <n>]');
    process.exit(0);
  }

  const auditPath = args.in || '';
  if (!auditPath) {
    console.error('[schema-audit-summarize] --in is required');
    process.exit(2);
  }
  const audit = readJson(auditPath);

  const fmt = String(args.format || 'md').trim().toLowerCase();
  const rendered = fmt === 'json'
    ? JSON.stringify(audit, null, 2) + '\n'
    : renderMarkdown(audit, { maxTables: args.maxTables });

  if (args.out) {
    writeFile(args.out, rendered);
    console.log(`[schema-audit-summarize] wrote ${args.out}`);
    return;
  }

  process.stdout.write(rendered);
}

main();
