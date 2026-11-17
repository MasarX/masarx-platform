#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { format: 'md', includeEphemeral: false, includePartitions: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--format') out.format = String(args[++i] || '').trim();
    else if (a === '--out') out.out = String(args[++i] || '').trim();
    else if (a === '--include-ephemeral') out.includeEphemeral = true;
    else if (a === '--include-partitions') out.includePartitions = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function normalizeName(raw) {
  const n = String(raw || '').replace(/"/g, '').trim();
  if (!n) return null;
  if (n.toUpperCase() === 'PARTITION') return null;
  if (n.endsWith('.')) return null;
  return n;
}

function isEphemeralName(name) {
  const lower = String(name || '').toLowerCase();
  return (
    lower.endsWith('_new') ||
    lower.endsWith('_backup') ||
    /_v\d+_backup$/.test(lower) ||
    lower.endsWith('_tmp') ||
    lower.endsWith('_temp')
  );
}

function schemaTable(name) {
  const n = normalizeName(name);
  if (!n) return null;
  const parts = n.split('.');
  if (parts.length === 1) return { schema: 'public', table: parts[0] };
  if (parts.length === 2) return { schema: parts[0], table: parts[1] };
  return { schema: parts[0], table: parts.slice(1).join('.') };
}

function extractFromSql(sql) {
  const createRe = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_\.\"]+)/gi;
  const partitionOfRe =
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_\.\"]+)\s+PARTITION\s+OF\s+([A-Za-z0-9_\.\"]+)/gi;

  const partitions = new Set();
  const tables = [];

  let m;
  while ((m = partitionOfRe.exec(sql))) {
    const after = sql[partitionOfRe.lastIndex] || '';
    if (after === '%') continue; // ignore format strings like "table_p%s"
    const child = schemaTable(m[1]);
    if (child) partitions.add(`${child.schema}.${child.table}`.toLowerCase());
  }

  while ((m = createRe.exec(sql))) {
    const after = sql[createRe.lastIndex] || '';
    if (after === '%') continue;
    const name = normalizeName(m[1]);
    if (name) tables.push(name);
  }

  return { partitions, tables };
}

function buildInventory({ includeEphemeral, includePartitions }) {
  const root = process.cwd();
  const migDir = path.join(root, 'supabase', 'migrations');
  const files = walk(migDir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .filter((f) => !f.toLowerCase().includes(path.sep + 'archive' + path.sep));

  const partitions = new Set();
  const created = [];

  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');
    const extracted = extractFromSql(sql);
    for (const p of extracted.partitions) partitions.add(p);
    created.push(...extracted.tables);
  }

  const bySchema = new Map();
  for (const raw of created) {
    const st = schemaTable(raw);
    if (!st) continue;
    const fullyQualified = `${st.schema}.${st.table}`;
    const key = fullyQualified.toLowerCase();

    if (!includePartitions && partitions.has(key)) continue;
    if (!includeEphemeral && isEphemeralName(st.table)) continue;

    if (!bySchema.has(st.schema)) bySchema.set(st.schema, new Map());
    bySchema.get(st.schema).set(key, fullyQualified);
  }

  const out = {};
  const schemas = [...bySchema.keys()].sort((a, b) => a.localeCompare(b));
  for (const schema of schemas) {
    out[schema] = [...bySchema.get(schema).values()].sort((a, b) => a.localeCompare(b));
  }

  return out;
}

function toMarkdown(inv, { outPath } = {}) {
  const lines = [];
  lines.push('# Schema Inventory (Derived from migrations)');
  lines.push('');
  lines.push('This inventory is derived from `supabase/migrations/` (static parsing).');
  lines.push('For the live database truth, prefer catalog queries against the cloud DB.');
  lines.push('');
  lines.push('Regenerate:');
  if (outPath) {
    lines.push(`\`node scripts/tooling/schema-inventory-from-migrations.js --format md --out ${outPath}\``);
  } else {
    lines.push('`node scripts/tooling/schema-inventory-from-migrations.js --format md`');
  }

  const schemas = Object.keys(inv).sort((a, b) => a.localeCompare(b));
  for (const schema of schemas) {
    const tables = inv[schema] || [];
    lines.push('');
    lines.push(`## ${schema} (${tables.length})`);
    for (const t of tables) lines.push(`- ${t}`);
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const { help, format, out, includeEphemeral, includePartitions } = parseArgs(process.argv);
  if (help) {
    console.log('Usage: node scripts/tooling/schema-inventory-from-migrations.js [--format md|json] [--out <file>] [--include-ephemeral] [--include-partitions]');
    process.exit(0);
  }

  const inv = buildInventory({ includeEphemeral, includePartitions });
  const fmt = (format || 'md').toLowerCase();
  let rendered;
  if (fmt === 'json') rendered = JSON.stringify(inv, null, 2) + '\n';
  else rendered = toMarkdown(inv, { outPath: out || null });

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, rendered + (rendered.endsWith('\n') ? '' : '\n'), 'utf8');
    console.log(`[schema-inventory] wrote ${out}`);
    return;
  }

  process.stdout.write(rendered + (rendered.endsWith('\n') ? '' : '\n'));
}

main();
