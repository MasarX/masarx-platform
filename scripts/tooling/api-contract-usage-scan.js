#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const IGNORE_DIRS = new Set([
  '.next',
  '.turbo',
  'dist',
  'build',
  'coverage',
  '.cache',
  'node_modules',
  '.tmp',
]);
const SUPPORTED_EXTS = /\.(js|jsx|ts|tsx|mjs|cjs)$/i;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    roots: ['supabase/functions', 'tests/integration'],
    format: 'md',
    out: '',
    maxRefsPerItem: 10,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--roots') {
      out.roots = String(args[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--format') {
      out.format = String(args[++i] || '').trim() || 'md';
    } else if (a === '--out') {
      out.out = String(args[++i] || '').trim();
    } else if (a === '--max-refs') {
      out.maxRefsPerItem = Math.max(1, parseInt(String(args[++i] || ''), 10) || 10);
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }

  return out;
}

function listFiles(rootDir) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name) || ent.name.startsWith('.')) {
          continue;
        }
        out.push(full);
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!SUPPORTED_EXTS.test(ent.name)) continue;
      out.push(full);
    }
  }
  return out;
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line += 1;
  }
  return line;
}

function scanContent(content) {
  const rpc = [];
  const from = [];

  const rpcRe = /\.rpc\(\s*['"]([^'"]+)['"]/g;
  const fromRe = /(?<!storage)\.from\(\s*['"]([^'"]+)['"]/g;

  for (;;) {
    const m = rpcRe.exec(content);
    if (!m) break;
    rpc.push({ name: m[1], index: m.index });
  }

  for (;;) {
    const m = fromRe.exec(content);
    if (!m) break;
    from.push({ name: m[1], index: m.index });
  }

  return { rpc, from };
}

function addRef(map, key, ref, maxRefsPerItem) {
  if (!map.has(key)) map.set(key, { count: 0, refs: [] });
  const entry = map.get(key);
  entry.count += 1;
  if (entry.refs.length < maxRefsPerItem) entry.refs.push(ref);
}

function renderMarkdown({ generatedAt, roots, rpc, tables, maxRefsPerItem }) {
  const lines = [];
  lines.push('# API Contract Usage (Code Scan)');
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push(`Roots: ${roots.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('Notes:');
  lines.push(`- Scans for \`.rpc('fn')\` and \`.from('table')\` calls in JS/TS files.`);
  lines.push(
    '- Includes source file extensions: .js, .jsx, .ts, .tsx, .mjs, .cjs.'
  );
  lines.push(`- Excludes \`.storage.from('bucket')\` (storage buckets are not DB tables).`);
  lines.push(`- Shows up to ${maxRefsPerItem} references per item.`);
  lines.push('');

  lines.push('## RPC Functions');
  if (!rpc.length) {
    lines.push('- (none found)');
  } else {
    for (const it of rpc) {
      lines.push(`- ${it.name} (${it.count})`);
      for (const ref of it.refs) {
        lines.push(`  - ${ref}`);
      }
    }
  }
  lines.push('');

  lines.push('## Table Endpoints');
  if (!tables.length) {
    lines.push('- (none found)');
  } else {
    for (const it of tables) {
      lines.push(`- ${it.name} (${it.count})`);
      for (const ref of it.refs) {
        lines.push(`  - ${ref}`);
      }
    }
  }
  lines.push('');

  return lines.join('\n') + '\n';
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: node scripts/tooling/api-contract-usage-scan.js [--roots supabase/functions,tests/integration] [--format md] [--out <file>] [--max-refs 10]'
    );
    process.exit(0);
  }

  const generatedAt = new Date().toISOString();

  const rpcMap = new Map();
  const fromMap = new Map();

  const roots = args.roots || [];
  for (const r of roots) {
    const rootDir = path.resolve(r);
    const files = listFiles(rootDir);
    for (const filePath of files) {
      if (!SUPPORTED_EXTS.test(filePath)) continue;
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      const rel = path.relative(process.cwd(), filePath);
      const scanned = scanContent(content);
      for (const hit of scanned.rpc) {
        const line = lineNumberAt(content, hit.index);
        addRef(rpcMap, hit.name, `${rel}:${line}`, args.maxRefsPerItem);
      }
      for (const hit of scanned.from) {
        const line = lineNumberAt(content, hit.index);
        addRef(fromMap, hit.name, `${rel}:${line}`, args.maxRefsPerItem);
      }
    }
  }

  const rpc = [...rpcMap.entries()]
    .map(([name, v]) => ({ name, count: v.count, refs: v.refs }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const tables = [...fromMap.entries()]
    .map(([name, v]) => ({ name, count: v.count, refs: v.refs }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const format = String(args.format || 'md').toLowerCase();
  if (format !== 'md') {
    console.error(`[api-contract-scan] Unsupported format: ${args.format}`);
    process.exit(2);
  }

  const body = renderMarkdown({
    generatedAt,
    roots,
    rpc,
    tables,
    maxRefsPerItem: args.maxRefsPerItem,
  });

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, body, 'utf8');
    console.log(`[api-contract-scan] wrote ${args.out}`);
    return;
  }

  process.stdout.write(body);
}

main();
