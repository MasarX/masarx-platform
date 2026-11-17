#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { loadEnv } = require('../utils/load-env');
const { parsePgHost } = require('../ops/assert-cloud-env');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    schemas: ['public', 'qa'],
    exposedSchemas: null,
    format: 'md',
    full: false,
    includeHost: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--schemas') out.schemas = String(args[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--exposed-schemas') {
      out.exposedSchemas = String(args[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    else if (a === '--format') out.format = String(args[++i] || '').trim();
    else if (a === '--out') out.out = String(args[++i] || '').trim();
    else if (a === '--full') out.full = true;
    else if (a === '--include-host') out.includeHost = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function readSupabaseConfigApiSchemas(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  let inApi = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (/^\s*\[.*\]\s*$/.test(line)) {
      inApi = trimmed.toLowerCase() === '[api]';
      continue;
    }

    if (!inApi) continue;

    const m = trimmed.match(/^schemas\s*=\s*\[(.*)\]\s*$/i);
    if (!m) continue;

    const inner = String(m[1] || '').trim();
    if (!inner) return [];

    return inner
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => p.replace(/^"(.*)"$/s, '$1'))
      .map((p) => p.replace(/^'(.*)'$/s, '$1'))
      .map((p) => p.trim())
      .filter(Boolean);
  }

  return [];
}

function resolveExposedSchemas({ explicit, schemas }) {
  if (Array.isArray(explicit) && explicit.length) return { schemas: explicit, source: 'arg' };

  try {
    const configPath = path.join('supabase', 'config.toml');
    if (fs.existsSync(configPath)) {
      const cfgSchemas = readSupabaseConfigApiSchemas(configPath);
      if (cfgSchemas.length) return { schemas: cfgSchemas, source: 'supabase/config.toml' };
    }
  } catch {
    // ignore
  }

  return { schemas: Array.isArray(schemas) ? schemas : [], source: 'fallback:--schemas' };
}

function isCloudDbUrl(dbUrl) {
  const host = parsePgHost(dbUrl);
  if (!host) return { ok: false, reason: 'Could not parse DATABASE_URL host' };
  // objectives:allow LOCALHOST Justification: Guard explicitly rejects local DATABASE_URL hosts; not an endpoint constant.
  if (host === 'localhost' || host === '127.0.0.1' || /\.local$/i.test(host)) {
    return { ok: false, reason: `DATABASE_URL must point to cloud; got host=${host}` };
  }
  if (!/\.supabase\.(co|com)$/i.test(host)) {
    return { ok: false, reason: `DATABASE_URL host must end with .supabase.co or .supabase.com; got ${host}` };
  }
  return { ok: true, host };
}

function sqlId(schema, table) {
  return `${schema}.${table}`;
}

function byKey(schema, table) {
  return `${schema}.${table}`.toLowerCase();
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function parsePostgresTextArray(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null;
  const inner = raw.slice(1, -1);
  if (!inner) return [];

  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQuotes) {
      if (ch === '\\' && i + 1 < inner.length) {
        current += inner[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);

  return out
    .map((v) => String(v || '').trim())
    .filter((v) => v && v.toUpperCase() !== 'NULL');
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (value == null) return [];
  if (typeof value === 'string') {
    const parsed = parsePostgresTextArray(value);
    if (parsed) return parsed;
    const trimmed = value.trim();
    if (!trimmed) return [];
    return trimmed.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [String(value)].filter(Boolean);
}

function bool(v) {
  return v === true || v === 't' || v === 1;
}

function normalizeExpr(expr) {
  const s = String(expr || '').trim();
  return s || null;
}

function renderRelationKind(kind) {
  if (kind === 'p') return 'PARTITIONED TABLE';
  if (kind === 'v') return 'VIEW';
  if (kind === 'm') return 'MATERIALIZED VIEW';
  return 'TABLE';
}

function parseReloptionsFlags(reloptions) {
  const opts = asStringArray(reloptions).map((o) => String(o).trim()).filter(Boolean);
  const flags = new Set(opts.map((o) => o.toLowerCase()));
  return {
    raw: opts,
    securityInvoker: flags.has('security_invoker=true'),
    securityBarrier: flags.has('security_barrier=true'),
  };
}

function renderMarkdown({ meta, summary, issues, tables, partitions }, { full }) {
  const lines = [];
  lines.push('# Live Schema Audit (DB catalog)');
  lines.push('');
  lines.push(`Generated: ${meta.generatedAt}`);
  if (meta.dbHost) lines.push(`Database host: ${meta.dbHost}`);
  lines.push(`Schemas: ${meta.schemas.join(', ')}`);
  if (Array.isArray(meta.exposedSchemas) && meta.exposedSchemas.length) {
    const src = meta.exposedSchemasSource ? ` (source: ${meta.exposedSchemasSource})` : '';
    lines.push(`Exposed schemas: ${meta.exposedSchemas.join(', ')}${src}`);
  }
  lines.push('');

  lines.push('## Summary');
  if (summary.relationCount != null) lines.push(`- Relations (scanned): ${summary.relationCount}`);
  lines.push(`- Tables (base): ${summary.baseTableCount}`);
  if (summary.viewCount != null) lines.push(`- Views: ${summary.viewCount}`);
  if (summary.materializedViewCount != null) lines.push(`- Materialized views: ${summary.materializedViewCount}`);
  lines.push(`- Partitioned tables: ${summary.partitionedTableCount}`);
  lines.push(`- User-facing objects (API): ${summary.userFacingCount ?? summary.userFacingTableCount ?? 0}`);
  lines.push(`- Service-only objects: ${summary.serviceOnlyCount ?? summary.serviceOnlyTableCount ?? 0}`);
  if (summary.partitionLeafCount != null) lines.push(`- Partition leaf tables: ${summary.partitionLeafCount}`);
  lines.push('');

  const severities = ['critical', 'high', 'medium', 'low', 'info'];
  for (const sev of severities) {
    const group = issues.filter((i) => i.severity === sev);
    if (!group.length) continue;
    lines.push(`## ${sev.toUpperCase()} (${group.length})`);
    for (const item of group) {
      lines.push(`- [${item.code}] ${item.object}: ${item.message}`);
    }
    lines.push('');
  }

  if (partitions && partitions.parents.length) {
    lines.push('## Partitioning');
    lines.push(`- Partitioned parents in inventory: ${partitions.parents.length}`);
    if (partitions.leafIssues.length) lines.push(`- Leaf security issues: ${partitions.leafIssues.length}`);
    lines.push('');
    const sample = partitions.parents.slice(0, 30);
    for (const p of sample) {
      lines.push(`- ${p.schema}.${p.table}: key=${p.partitionKey || '(unknown)'} leaves=${p.leafCount}`);
    }
    if (partitions.parents.length > sample.length) {
      lines.push(`- (truncated) remaining parents: ${partitions.parents.length - sample.length}`);
    }
    lines.push('');
  }

  if (!full) return lines.join('\n') + '\n';

  lines.push('## Relation Appendix');
  lines.push('');
  const sorted = [...tables.values()].sort((a, b) => sqlId(a.schema, a.name).localeCompare(sqlId(b.schema, b.name)));
  for (const t of sorted) {
    lines.push(`### ${t.schema}.${t.name}`);
    lines.push(`- Kind: ${renderRelationKind(t.kind)}`);
    lines.push(`- Owner: ${t.owner || '(unknown)'}`);
    lines.push(`- Exposed: ${t.exposed ? 'yes' : 'no'}`);
    lines.push(`- User-facing (API): ${t.userFacing ? 'yes' : 'no'}`);
    if (t.kind === 'v' || t.kind === 'm') {
      lines.push(`- View security_invoker: ${t.reloptions?.securityInvoker ? 'enabled' : 'disabled'}`);
      lines.push(`- View security_barrier: ${t.reloptions?.securityBarrier ? 'enabled' : 'disabled'}`);
    } else {
      lines.push(`- RLS: ${t.rls.enabled ? 'enabled' : 'disabled'}${t.rls.forced ? ' (forced)' : ''}`);
    }
    lines.push(`- Grants (anon): ${t.privileges.anonSummary}`);
    lines.push(`- Grants (authenticated): ${t.privileges.authSummary}`);
    lines.push(`- Policies: ${t.policies.length}`);
    if (t.partitionKey) lines.push(`- Partition key: ${t.partitionKey}`);
    lines.push('');

    lines.push('#### Columns');
    for (const c of t.columns) {
      const bits = [
        `${c.name} ${c.type}`,
        c.notNull ? 'NOT NULL' : 'NULL',
        c.identity ? `IDENTITY(${c.identity})` : null,
        c.generated ? `GENERATED(${c.generated})` : null,
        c.default ? `DEFAULT ${c.default}` : null,
      ].filter(Boolean);
      lines.push(`- ${bits.join(' ')}`);
    }
    lines.push('');

    if (t.constraints.length) {
      lines.push('#### Constraints');
      for (const con of t.constraints) {
        lines.push(`- ${con.type} ${con.name}: ${con.definition}`);
      }
      lines.push('');
    }

    if (t.indexes.length) {
      lines.push('#### Indexes');
      for (const idx of t.indexes) {
        const tags = [idx.primary ? 'PRIMARY' : null, idx.unique ? 'UNIQUE' : null].filter(Boolean).join(' ');
        lines.push(`- ${idx.name}${tags ? ` (${tags})` : ''}: ${idx.definition}`);
      }
      lines.push('');
    }

    if (t.triggers.length) {
      lines.push('#### Triggers');
      for (const trg of t.triggers) {
        lines.push(`- ${trg.name}: ${trg.definition}`);
      }
      lines.push('');
    }

    if (t.policies.length) {
      lines.push('#### Policies');
      for (const pol of t.policies) {
        const roles = pol.roles.length ? pol.roles.join(',') : '(all roles)';
        lines.push(`- ${pol.name}: cmd=${pol.cmd} roles=${roles}`);
        if (pol.using) lines.push(`  - USING: ${pol.using}`);
        if (pol.check) lines.push(`  - WITH CHECK: ${pol.check}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n') + '\n';
}

function privilegeSummary(priv) {
  const ordered = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'];
  const allowed = ordered.filter((k) => bool(priv[k]));
  return allowed.length ? allowed.join(',') : '(none)';
}

async function withClient(dbUrl, fn) {
  const client = new Client({ connectionString: dbUrl });
  client.on('error', (err) => {
    if (err && err.code === 'XX000' && String(err).includes('db_termination')) {
      console.warn('[schema-audit] Transient db_termination:', err.message || String(err));
    } else {
      console.error('[schema-audit] Client error:', err.message || String(err));
    }
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch {
      // ignore cleanup errors
    }
  }
}

async function query(client, text, params) {
  const res = await client.query(text, params);
  return res.rows || [];
}

async function regclassExists(client, qualifiedName) {
  const rows = await query(client, 'select to_regclass($1) as oid', [qualifiedName]);
  return Boolean(rows[0] && rows[0].oid);
}

function buildIssues({ tables, partitionLeafChecks }) {
  const issues = [];

  for (const t of tables.values()) {
    const fq = `${t.schema}.${t.name}`;
    const isTable = t.kind === 'r' || t.kind === 'p';
    const isView = t.kind === 'v' || t.kind === 'm';

    if (t.exposed && t.hasUserGrants && t.owner && t.owner !== 'postgres') {
      issues.push({
        severity: 'high',
        code: 'NON_APP_OWNER_EXPOSED',
        object: fq,
        message: `Exposed object is owned by ${t.owner}; verify ownership/RLS manageability and prefer postgres-owned app objects in exposed schemas`,
      });
    }

    if (t.userFacing && isTable && !t.rls.enabled) {
      issues.push({
        severity: 'critical',
        code: 'RLS_MISSING_USER_FACING',
        object: fq,
        message: 'User-facing table has RLS disabled',
      });
    }

    if (t.userFacing && isTable && t.policies.length === 0) {
      issues.push({
        severity: 'high',
        code: 'POLICY_MISSING_USER_FACING',
        object: fq,
        message: 'User-facing table has no RLS policies',
      });
    }

    if (!t.exposed && t.hasUserGrants) {
      issues.push({
        severity: 'info',
        code: 'USER_GRANTS_UNEXPOSED_SCHEMA',
        object: fq,
        message: 'Object has anon/authenticated grants but schema is not exposed; not reachable via PostgREST unless exposure changes',
      });
    }

    if (isTable) {
      const pk = t.constraints.find((c) => c.type === 'PRIMARY KEY');
      if (!pk) {
        issues.push({
          severity: 'medium',
          code: 'PK_MISSING',
          object: fq,
          message: 'Table has no primary key',
        });
      }

      for (const check of t.checkConstraints) {
        if (check.isHardcodedEnum) {
          issues.push({
            severity: 'low',
            code: 'HARDCODED_ENUM_CHECK',
            object: `${fq}.${check.name}`,
            message: 'CHECK constraint contains a literal IN(...) list; prefer lookup-driven enforcement',
          });
        }
      }

      for (const fk of t.foreignKeys) {
        if (!fk.hasSupportingIndex) {
          issues.push({
            severity: 'medium',
            code: 'FK_INDEX_MISSING',
            object: `${fq}.${fk.name}`,
            message: `Foreign key has no supporting index on (${fk.columns.join(', ')})`,
          });
        }
      }
    }

    if (t.userFacing && isView && !t.reloptions?.securityInvoker) {
      issues.push({
        severity: 'high',
        code: 'VIEW_SECURITY_INVOKER_MISSING',
        object: fq,
        message: 'User-facing view is not security_invoker; enable security_invoker to avoid owner-privilege surprises and RLS bypass risk',
      });
    }
  }

  for (const leaf of partitionLeafChecks.issues) {
    issues.push({
      severity: leaf.severity,
      code: leaf.code,
      object: leaf.object,
      message: leaf.message,
    });
  }

  return issues;
}

function annotateTableRelationships(tables) {
  for (const t of tables.values()) {
    const fkConstraints = t.constraints.filter(
      (c) => c.type === 'FOREIGN KEY' && Number(c.parentConstraintOid || 0) === 0,
    );
    t.foreignKeys = fkConstraints.map((c) => ({
      name: c.name,
      columns: c.columns,
      hasSupportingIndex: false,
    }));
    t.checkConstraints = t.constraints
      .filter((c) => c.type === 'CHECK')
      .map((c) => ({
        name: c.name,
        definition: c.definition,
        isHardcodedEnum: /\bIN\s*\(\s*'[^']+'(?:\s*,\s*'[^']+')+\s*\)/i.test(c.definition),
      }));

    for (const fk of t.foreignKeys) {
      fk.hasSupportingIndex = t.indexes.some((idx) => {
        if (!idx.columns.length) return false;
        if (idx.columns.length < fk.columns.length) return false;
        for (let i = 0; i < fk.columns.length; i++) {
          if (idx.columns[i] !== fk.columns[i]) return false;
        }
        return true;
      });
    }
  }
}

async function loadBaseTables(client, schemas) {
  const rows = await query(
    client,
    `
      SELECT
        n.nspname AS schema,
        c.relname AS name,
        c.relkind AS kind,
        c.reloptions AS reloptions,
        pg_get_userbyid(c.relowner) AS owner,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced,
        obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r','p','v','m')
        AND c.relispartition = FALSE
      ORDER BY n.nspname, c.relname
    `,
    [schemas],
  );

  const tables = new Map();
  for (const r of rows) {
    const key = byKey(r.schema, r.name);
    tables.set(key, {
      schema: r.schema,
      name: r.name,
      kind: r.kind,
      reloptions: parseReloptionsFlags(r.reloptions),
      owner: r.owner || null,
      comment: r.comment || null,
      rls: { enabled: bool(r.rls_enabled), forced: bool(r.rls_forced) },
      privileges: {
        anon: {},
        authenticated: {},
        anonAny: false,
        authAny: false,
        anonSummary: '(unknown)',
        authSummary: '(unknown)',
      },
      exposed: false,
      hasUserGrants: false,
      userFacing: false,
      policies: [],
      columns: [],
      constraints: [],
      indexes: [],
      triggers: [],
      partitionKey: null,
      foreignKeys: [],
      checkConstraints: [],
    });
  }
  return tables;
}

async function loadPrivileges(client, schemas) {
  const rows = await query(
    client,
    `
      SELECT
        n.nspname AS schema,
        c.relname AS name,
        has_table_privilege('anon', c.oid, 'select') AS anon_select,
        has_table_privilege('anon', c.oid, 'insert') AS anon_insert,
        has_table_privilege('anon', c.oid, 'update') AS anon_update,
        has_table_privilege('anon', c.oid, 'delete') AS anon_delete,
        has_table_privilege('authenticated', c.oid, 'select') AS auth_select,
        has_table_privilege('authenticated', c.oid, 'insert') AS auth_insert,
        has_table_privilege('authenticated', c.oid, 'update') AS auth_update,
        has_table_privilege('authenticated', c.oid, 'delete') AS auth_delete
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r','p','v','m')
        AND c.relispartition = FALSE
      ORDER BY n.nspname, c.relname
    `,
    [schemas],
  );
  return rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    anon: { select: bool(r.anon_select), insert: bool(r.anon_insert), update: bool(r.anon_update), delete: bool(r.anon_delete) },
    authenticated: { select: bool(r.auth_select), insert: bool(r.auth_insert), update: bool(r.auth_update), delete: bool(r.auth_delete) },
  }));
}

async function loadColumns(client, schemas) {
  return query(
    client,
    `
      SELECT
        n.nspname AS schema,
        c.relname AS name,
        a.attname AS column_name,
        pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        a.attnotnull AS not_null,
        a.attidentity AS identity,
        a.attgenerated AS generated,
        pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
        col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r','p','v','m')
        AND c.relispartition = FALSE
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY n.nspname, c.relname, a.attnum
    `,
    [schemas],
  );
}

async function loadConstraints(client, schemas) {
  return query(
    client,
    `
      SELECT
        n.nspname AS schema,
        c.relname AS name,
        con.conname AS constraint_name,
        con.contype AS constraint_type,
        con.conparentid AS parent_constraint_oid,
        pg_get_constraintdef(con.oid) AS definition,
        ARRAY(
          SELECT a.attname
          FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
          ORDER BY k.ord
        ) AS columns
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r','p')
        AND c.relispartition = FALSE
      ORDER BY n.nspname, c.relname, con.conname
    `,
    [schemas],
  );
}

async function loadIndexes(client, schemas) {
  return query(
    client,
    `
      SELECT
        n.nspname AS schema,
        c.relname AS name,
        idx.relname AS index_name,
        i.indisunique AS is_unique,
        i.indisprimary AS is_primary,
        pg_get_indexdef(i.indexrelid) AS definition,
        ARRAY(
          SELECT a.attname
          FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
          WHERE k.attnum > 0
          ORDER BY k.ord
        ) AS columns
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r','p','m')
        AND c.relispartition = FALSE
      ORDER BY n.nspname, c.relname, idx.relname
    `,
    [schemas],
  );
}

async function loadTriggers(client, schemas) {
  return query(
    client,
    `
      SELECT
        n.nspname AS schema,
        c.relname AS name,
        t.tgname AS trigger_name,
        pg_get_triggerdef(t.oid, true) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r','p','v')
        AND c.relispartition = FALSE
        AND NOT t.tgisinternal
      ORDER BY n.nspname, c.relname, t.tgname
    `,
    [schemas],
  );
}

async function loadPolicies(client, schemas) {
  return query(
    client,
    `
      SELECT
        n.nspname AS schema,
        c.relname AS name,
        p.polname AS policy_name,
        p.polcmd AS cmd,
        COALESCE((
          SELECT array_agg(r.rolname ORDER BY r.rolname)
          FROM unnest(p.polroles) AS x(role_oid)
          JOIN pg_roles r ON r.oid = x.role_oid
        ), '{}'::text[]) AS roles,
        pg_get_expr(p.polqual, p.polrelid) AS using_expr,
        pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind IN ('r','p')
        AND c.relispartition = FALSE
      ORDER BY n.nspname, c.relname, p.polname
    `,
    [schemas],
  );
}

async function loadPartitionKeys(client, schemas) {
  return query(
    client,
    `
      SELECT
        n.nspname AS schema,
        c.relname AS name,
        pg_get_partkeydef(c.oid) AS partition_key
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[])
        AND c.relkind = 'p'
        AND c.relispartition = FALSE
      ORDER BY n.nspname, c.relname
    `,
    [schemas],
  );
}

async function loadPartitionInventory(client) {
  const exists = await regclassExists(client, 'public.partition_inventory');
  if (!exists) return [];
  return query(
    client,
    `
      SELECT
        table_name,
        partition_name,
        parent_name,
        partition_expression,
        start_at,
        end_at,
        age_days,
        row_estimate,
        partition_strategy,
        partition_interval,
        retention_months,
        retention_policy
      FROM public.partition_inventory
      ORDER BY table_name, partition_name
    `,
    [],
  );
}

async function checkPartitionLeafSecurity(client, partitionNames) {
  const out = { issues: [] };
  if (!partitionNames.length) return out;

  const rows = await query(
    client,
    `
      SELECT
        c.relname AS name,
        c.relrowsecurity AS rls_enabled,
        has_table_privilege('anon', c.oid, 'select') OR
          has_table_privilege('anon', c.oid, 'insert') OR
          has_table_privilege('anon', c.oid, 'update') OR
          has_table_privilege('anon', c.oid, 'delete') AS anon_any,
        has_table_privilege('authenticated', c.oid, 'select') OR
          has_table_privilege('authenticated', c.oid, 'insert') OR
          has_table_privilege('authenticated', c.oid, 'update') OR
          has_table_privilege('authenticated', c.oid, 'delete') AS auth_any
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY($1::text[])
    `,
    [partitionNames],
  );

  for (const r of rows) {
    const fq = `public.${r.name}`;
    if (!bool(r.rls_enabled)) {
      out.issues.push({
        severity: 'critical',
        code: 'RLS_MISSING_PARTITION_LEAF',
        object: fq,
        message: 'Partition leaf has RLS disabled',
      });
    }
    if (bool(r.anon_any) || bool(r.auth_any)) {
      out.issues.push({
        severity: 'critical',
        code: 'GRANT_DRIFT_PARTITION_LEAF',
        object: fq,
        message: 'Partition leaf has anon/authenticated grants (must be service-only)',
      });
    }
  }

  return out;
}

async function run({ schemas, exposedSchemas, format, out, full, includeHost }) {
  loadEnv();
  const resolvedSchemas = Array.isArray(schemas) && schemas.length ? schemas : ['public', 'qa'];
  const resolvedExposed = resolveExposedSchemas({ explicit: exposedSchemas, schemas: resolvedSchemas });
  const apiSchemas = resolvedExposed.schemas;
  const apiSchemasSource = resolvedExposed.source;
  const scanSchemas = Array.from(new Set([...(resolvedSchemas || []), ...(apiSchemas || [])])).filter(Boolean);
  const dbUrl = String(process.env.DATABASE_URL || '').trim();
  if (!dbUrl) {
    console.error('[schema-audit] DATABASE_URL is required. Set ENV_FILE=config/env/.env.cloud or export DATABASE_URL.');
    process.exit(2);
  }

  const cloud = isCloudDbUrl(dbUrl);
  if (!cloud.ok) {
    console.error(`[schema-audit] ${cloud.reason}`);
    process.exit(2);
  }

  const generatedAt = new Date().toISOString();

  const result = await withClient(dbUrl, async (client) => {
    const tables = await loadBaseTables(client, scanSchemas);

    const privilegesRows = await loadPrivileges(client, scanSchemas);
    for (const p of privilegesRows) {
      const key = byKey(p.schema, p.name);
      const t = tables.get(key);
      if (!t) continue;
      t.privileges.anon = p.anon;
      t.privileges.authenticated = p.authenticated;
      t.privileges.anonAny = Object.values(p.anon).some(Boolean);
      t.privileges.authAny = Object.values(p.authenticated).some(Boolean);
      t.privileges.anonSummary = privilegeSummary(p.anon);
      t.privileges.authSummary = privilegeSummary(p.authenticated);
      t.exposed = apiSchemas.includes(t.schema);
      t.hasUserGrants = t.privileges.anonAny || t.privileges.authAny;
      t.userFacing = t.exposed && t.hasUserGrants;
    }

    const cols = await loadColumns(client, scanSchemas);
    for (const c of cols) {
      const t = tables.get(byKey(c.schema, c.name));
      if (!t) continue;
      t.columns.push({
        name: c.column_name,
        type: c.data_type,
        notNull: bool(c.not_null),
        identity: String(c.identity || '').trim() || null,
        generated: String(c.generated || '').trim() || null,
        default: normalizeExpr(c.default_expr),
        comment: c.comment || null,
      });
    }

    const cons = await loadConstraints(client, scanSchemas);
    for (const c of cons) {
      const t = tables.get(byKey(c.schema, c.name));
      if (!t) continue;
      const typeMap = {
        p: 'PRIMARY KEY',
        u: 'UNIQUE',
        f: 'FOREIGN KEY',
        c: 'CHECK',
        x: 'EXCLUDE',
      };
      t.constraints.push({
        name: c.constraint_name,
        type: typeMap[c.constraint_type] || c.constraint_type,
        parentConstraintOid: Number(c.parent_constraint_oid) || 0,
        definition: c.definition,
        columns: asStringArray(c.columns),
      });
    }

    const idxs = await loadIndexes(client, scanSchemas);
    for (const idx of idxs) {
      const t = tables.get(byKey(idx.schema, idx.name));
      if (!t) continue;
      t.indexes.push({
        name: idx.index_name,
        unique: bool(idx.is_unique),
        primary: bool(idx.is_primary),
        definition: idx.definition,
        columns: asStringArray(idx.columns),
      });
    }

    const triggers = await loadTriggers(client, scanSchemas);
    for (const trg of triggers) {
      const t = tables.get(byKey(trg.schema, trg.name));
      if (!t) continue;
      t.triggers.push({
        name: trg.trigger_name,
        definition: trg.definition,
      });
    }

    const policies = await loadPolicies(client, scanSchemas);
    for (const pol of policies) {
      const t = tables.get(byKey(pol.schema, pol.name));
      if (!t) continue;
      t.policies.push({
        name: pol.policy_name,
        cmd: pol.cmd,
        roles: asStringArray(pol.roles),
        using: normalizeExpr(pol.using_expr),
        check: normalizeExpr(pol.check_expr),
      });
    }

    const partKeys = await loadPartitionKeys(client, scanSchemas);
    for (const pk of partKeys) {
      const t = tables.get(byKey(pk.schema, pk.name));
      if (!t) continue;
      t.partitionKey = normalizeExpr(pk.partition_key);
    }

    annotateTableRelationships(tables);

    const partitionInventory = await loadPartitionInventory(client);
    const partitionNames = partitionInventory.map((r) => r.partition_name);
    const partitionLeafChecks = await checkPartitionLeafSecurity(client, partitionNames);

    const partitionParents = partitionInventory.length
      ? (() => {
          const byTable = groupBy(partitionInventory, (r) => String(r.table_name));
          const parents = [];
          for (const [tableName, rows] of byTable.entries()) {
            parents.push({
              schema: 'public',
              table: tableName,
              leafCount: rows.length,
              partitionKey: tables.get(byKey('public', tableName))?.partitionKey || null,
            });
          }
          parents.sort((a, b) => a.table.localeCompare(b.table));
          return parents;
        })()
      : [];

    const issues = buildIssues({ tables, partitionLeafChecks });
    issues.sort((a, b) => {
      const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      const d = (sevOrder[a.severity] ?? 99) - (sevOrder[b.severity] ?? 99);
      if (d !== 0) return d;
      return `${a.code}:${a.object}`.localeCompare(`${b.code}:${b.object}`);
    });

    const summary = {
      relationCount: tables.size,
      baseTableCount: [...tables.values()].filter((t) => t.kind === 'r').length,
      viewCount: [...tables.values()].filter((t) => t.kind === 'v').length,
      materializedViewCount: [...tables.values()].filter((t) => t.kind === 'm').length,
      partitionedTableCount: [...tables.values()].filter((t) => t.kind === 'p').length,
      userFacingCount: [...tables.values()].filter((t) => t.userFacing).length,
      serviceOnlyCount: [...tables.values()].filter((t) => !t.userFacing).length,
      partitionLeafCount: partitionInventory.length || null,
    };

    const rendered = format.toLowerCase() === 'json'
      ? JSON.stringify(
        {
          meta: {
            generatedAt,
            dbHost: includeHost ? cloud.host : null,
            schemas: scanSchemas,
            exposedSchemas: apiSchemas,
            exposedSchemasSource: apiSchemasSource,
          },
          summary,
          issues,
          partitions: {
            leafCount: partitionInventory.length,
            parents: partitionParents,
            leafIssues: partitionLeafChecks.issues,
          },
          tables: [...tables.values()].sort((a, b) => sqlId(a.schema, a.name).localeCompare(sqlId(b.schema, b.name))),
        },
        null,
        2,
      ) + '\n'
      : renderMarkdown(
        {
          meta: {
            generatedAt,
            dbHost: includeHost ? cloud.host : null,
            schemas: scanSchemas,
            exposedSchemas: apiSchemas,
            exposedSchemasSource: apiSchemasSource,
          },
          summary,
          issues,
          tables,
          partitions: {
            parents: partitionParents,
            leafIssues: partitionLeafChecks.issues,
          },
        },
        { full },
      );

    return rendered;
  });

  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, result, 'utf8');
    console.log(`[schema-audit] wrote ${out}`);
    return;
  }

  process.stdout.write(result);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(
      'Usage: node scripts/tooling/schema-audit-from-db.js [--schemas <comma list>] [--exposed-schemas <comma list>] [--format md|json] [--full] [--out <file>] [--include-host]'
    );
    process.exit(0);
  }
  run(args).catch((err) => {
    const msg = err && err.message ? err.message : String(err);
    if (/Tenant or user not found/i.test(msg) || /password authentication failed/i.test(msg)) {
      console.error(`[schema-audit] DB auth failure: ${msg}`);
      process.exit(2);
    }
    console.error('[schema-audit] Unexpected failure:', err);
    process.exit(2);
  });
}

main();
