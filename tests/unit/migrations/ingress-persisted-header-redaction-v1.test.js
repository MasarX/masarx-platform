/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ts = require('typescript');

describe('ingress persisted header and query redaction migration', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202608161540_b3_ingress_persisted_header_redaction_v1.sql',
  );
  const readMigration = () => fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n');
  const requiredRegistryKeys = [
    'backfill',
    'classification',
    'column',
    'malformed_semantics',
    'mode',
    'nested_path',
    'null_semantics',
    'policy_source',
    'representation',
    'sanitizer',
    'schema',
    'surface_id',
    'table',
    'version',
    'writer',
  ];
  const expectedSurfaceIds = [
    'api_gateway.path_projection',
    'api_gateway.policy_snapshot',
    'api_gateway.query_projection',
    'api_gateway.request_headers',
    'audit.request_context',
    'audit.row_new',
    'audit.row_old',
    'decision.ingress_recursive',
    'outbound.gateway_context',
    'outbound.gateway_execution_url_reference',
    'outbound.gateway_headers',
    'outbound.gateway_response_headers',
    'outbound.gateway_url_projection',
    'webhook.ack_body',
    'webhook.ack_headers',
    'webhook.ack_validation',
    'webhook.headers',
    'workflow.api_outbound_headers',
    'workflow.api_path_projection',
    'workflow.api_policy_snapshot',
    'workflow.api_query_projection',
    'workflow.api_request_headers',
    'workflow.api_upstream_url_projection',
    'workflow.webhook_headers',
  ];

  function parseRegistry(sql) {
    const match = sql.match(/SELECT \$registry\$([\s\S]*?)\$registry\$::jsonb;/);
    if (!match) throw new Error('durable-surface registry literal is missing');
    return JSON.parse(match[1]);
  }

  function discoverDirectPersistenceWrites(sql) {
    const writes = [];
    const add = (table, columns, source) => {
      for (const column of columns) {
        const normalized = column.replace(/^["']|["']$/g, '').trim();
        if (/^(?:persistence_policy_snapshot|request_headers|response_headers|query_string|path|url|headers|ack_headers|ack_body|ack_validation|context|decision_inputs|row_old|row_new|request_context)$/i.test(normalized)) {
          writes.push({ table, column: normalized.toLowerCase(), source });
        }
      }
    };
    for (const match of sql.matchAll(/INSERT\s+INTO\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)/gi)) {
      add(match[1].toLowerCase(), match[2].split(','), 'insert');
    }
    for (const match of sql.matchAll(/UPDATE\s+public\.([a-z0-9_]+)(?:\s+[a-z0-9_]+)?\s+SET\s+([\s\S]*?)(?=\n\s*(?:FROM|WHERE|RETURNING)\b|;)/gi)) {
      const columns = [...match[2].matchAll(/(?:^|,)\s*([a-z0-9_]+)\s*=/gim)].map((entry) => entry[1]);
      add(match[1].toLowerCase(), columns, 'update');
    }
    return writes;
  }

  function discoverNestedPersistencePaths(sql) {
    return [...sql.matchAll(/jsonb_set\([^,]+,\s*'\{(api_gateway,[a-z0-9_]+)\}'::TEXT\[\]/gi)]
      .map((match) => match[1].toLowerCase().split(','))
      .filter((segments) => /(?:header|query|url|path|policy_snapshot)/.test(segments.at(-1)));
  }

  function assertClosedRegistryContract(sql) {
    const registry = parseRegistry(sql);
    expect(registry).toHaveLength(24);
    const cardinalityGuards = [...sql.matchAll(/jsonb_array_length\(v_registry\)\s*<>\s*(\d+)/g)]
      .map((match) => Number(match[1]));
    expect(cardinalityGuards).toEqual([registry.length, registry.length]);
    expect(registry.map((item) => item.surface_id).sort()).toEqual(expectedSurfaceIds);
    expect(new Set(registry.map((item) => item.surface_id)).size).toBe(registry.length);
    for (const item of registry) {
      expect(Object.keys(item).sort()).toEqual(requiredRegistryKeys);
      expect(item.version).toBe(2);
      expect(item.nested_path).toEqual(expect.any(Array));
      for (const key of requiredRegistryKeys.filter((name) => !['nested_path', 'version'].includes(name))) {
        expect(String(item[key]).trim()).not.toBe('');
      }
    }

    const physical = new Set(registry.map((item) => `${item.table}.${item.column}`));
    for (const write of discoverDirectPersistenceWrites(sql)) {
      expect(physical.has(`${write.table}.${write.column}`)).toBe(true);
    }
    const nested = new Set(registry.map((item) => `${item.table}.${item.column}.${item.nested_path.join('.')}`));
    for (const segments of discoverNestedPersistencePaths(sql)) {
      expect(nested.has(`workflow_runs.context.${segments.join('.')}`)).toBe(true);
    }

    expect(sql).toContain('DO $registry_install$');
    expect(sql).toContain('FROM jsonb_array_elements(v_registry) WITH ORDINALITY');
    expect(sql).toContain("CREATE TRIGGER a00_ingress_persistence_redaction BEFORE INSERT OR UPDATE ON %I.%I");
    expect(sql).toContain('ingress durable-surface registry/backfill trigger contract is incomplete');
    expect(sql).not.toMatch(/RETURN\s+v_out\s*-|jsonb\s*-\s*lower\s*\(/i);
  }

  test('keeps one canonical policy-aware DB-side redaction contract', () => {
    const sql = readMigration();
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.resolve_protected_query_names_v1(p_policy_or_snapshot JSONB)');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.redact_sensitive_url(\n  p_url TEXT,');
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.redact_sensitive_url\(p_url TEXT\)[\s\S]*?SELECT public\.redact_sensitive_url\(p_url, '\{\}'::jsonb, FALSE\);/);
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.redact_sensitive_query_string_v1(\n  p_query_string TEXT,');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.resolve_ingress_protected_header_names_v1(p_policy_or_snapshot JSONB)');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.ingress_header_policy_snapshot_v1(p_policy JSONB)');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.rebuild_ingress_headers_v1(');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.ingress_durable_surface_registry_v1()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sanitize_ingress_persisted_projection_v1()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.backfill_ingress_persisted_redaction_v1(');
    expect(sql).not.toMatch(/DISABLE\s+TRIGGER|CASCADE|GRANT\s+ALL/i);
  });

  test('binds configured raw query names and exact immutable policy snapshots', () => {
    const sql = readMigration();
    expect(sql).toContain("p_policy_or_snapshot ->> 'policy_revision'");
    expect(sql).toContain("p_policy_or_snapshot #> '{query,protected}'");
    expect(sql).toContain("'raw_name', v_name");
    expect(sql).toContain("'match', v_match");
    expect(sql).toContain("'case_sensitive', v_case_sensitive");
    expect(sql).toContain("'source', 'api_route.policy.query.protected'");
    expect(sql).toContain("v_revision := encode(extensions.digest(convert_to(p_policy_or_snapshot::TEXT, 'UTF8'), 'sha256'), 'hex')");
    expect(sql).toContain("COALESCE(NULLIF(v_rule ->> 'match', ''), 'exact')");
    expect(sql).toContain("COALESCE((v_rule ->> 'case_sensitive')::BOOLEAN, TRUE)");
    expect(sql).toContain("p_policy_or_snapshot ->> 'snapshot_version' <> '2'");
    expect(sql).toContain("p_policy_or_snapshot ->> 'snapshot_provenance' <> 'public.ingress_header_policy_snapshot_v1'");
    expect(sql).toContain("p_policy_or_snapshot ->> 'snapshot_digest' <> encode(extensions.digest(");
    expect(sql).toContain("ingress protected-query snapshot omits mandatory protocol rules");
    expect(sql).toContain("ingress protected-header snapshot omits mandatory protocol names");
  });

  test('redacts duplicate, malformed, and ambiguous query values after one decode', () => {
    const sql = readMigration();
    expect(sql).toContain("get_byte(decode(v_hex, 'hex'), 0)");
    expect(sql).toContain('IF v_byte < 33 OR v_byte > 126 THEN');
    expect(sql).toContain("IF v_key_decoded ~ '%[0-9a-fA-F]{2}' THEN");
    expect(sql).toContain("v_out_pairs := v_out_pairs || (COALESCE(v_key, '') || '=REDACTED')");
    expect(sql).toContain("v_pairs := string_to_array(v_query, '&')");
    expect(sql).toContain("IF p_policy_or_snapshot IS NULL OR p_policy_or_snapshot = 'null'::jsonb THEN");
    expect(sql).toContain('RETURN NULL;');
  });

  test('keeps executable gateway query in Vault while durable projections use the redactor', () => {
    const sql = readMigration();
    expect(sql).toContain('v_query_projection TEXT;');
    expect(sql).toContain('v_url_projection TEXT;');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.workflow_intake_api_gateway_base_v1(');
    expect(sql).toContain("v_url := v_url || '?' || v_query;");
    expect(sql.match(/NULLIF\(v_query_projection, ''\)/g)).toHaveLength(2);
    expect(sql).toContain("'persistence_policy_snapshot', public.ingress_header_policy_snapshot_v1(v_policy)");
    expect(sql).toContain("'upstream_url', v_url_projection");
    expect(sql).toContain("v_outbound_headers := public.prepare_ingress_provider_headers_v1(");
    expect(sql).not.toContain('pg_get_functiondef');
    expect(sql).toContain('"surface_id":"outbound.gateway_url_projection"');
    expect(sql).toContain('"surface_id":"outbound.gateway_execution_url_reference"');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.persist_ingress_execution_url_v1(');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.resolve_ingress_execution_url_v1(p_outbound_call_id UUID)');
    expect(sql).toContain('public.get_job_call_spec_without_ingress_vault_v1(p_job_id)');
    expect(sql).toContain('public.resolve_ingress_execution_url_v1(p_job_id)');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.purge_obsolete_ingress_execution_url_v1()');
    expect(sql).toContain('z99_purge_obsolete_ingress_execution_url');
    expect(sql).toContain('z99_purge_deleted_ingress_execution_url');
    expect(sql).toContain("v_enrichment_suffix := substring(v_enriched_url FROM length(v_durable_url) + 1)");
    expect(sql).toContain('to_jsonb(v_execution_url || v_enrichment_suffix)');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.get_job_call_spec_without_ingress_vault_v1(UUID) FROM PUBLIC');
    expect(sql).toContain("ARRAY['anon', 'authenticated', 'service_role', 'edge_api_caller_role']");
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.get_job_call_spec(UUID) TO edge_api_caller_role');
    expect(sql).toContain('AND v_redacted_url IS NOT DISTINCT FROM v_raw_url');
    expect(sql).toMatch(/PERFORM vault\.update_secret\(\s*v_vault_id,\s*p_url,\s*v_name,\s*'Transient executable ingress gateway URL; durable evidence is redacted'\s*\);/);
    expect(sql).toContain('AFTER UPDATE ON public.outbound_calls');
    expect(sql).toContain('WHEN (OLD.execution_url_vault_id IS NOT NULL AND NEW.execution_url_vault_id IS NULL)');
    expect(sql).toContain('active ingress outbound calls contain unrecoverable redacted execution URLs without Vault references (count %, sample ids %)');
  });

  test('ships deterministic webhook and gateway intake definitions', () => {
    const sql = readMigration();
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.workflow_intake_webhook_core_v1(');
    expect(sql).toContain("v_persisted_headers JSONB := '{}'::jsonb;");
    expect(sql).toContain('v_persisted_headers := public.redact_webhook_persisted_headers_v1(');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.workflow_intake_api_gateway_base_v1(');
    expect(sql).not.toContain('pg_get_functiondef');
  });

  test('sanitizes direct gateway response-header evidence at trigger and backfill boundaries', () => {
    const sql = readMigration();
    expect(sql).toContain('"surface_id":"outbound.gateway_response_headers"');
    expect(sql).toContain('"column":"response_headers"');
    expect(sql).toContain('"mode":"gateway_response_headers"');
    expect(sql).toContain("columns.column_name IN ('url', 'headers', 'response_headers', 'context')");
    expect(sql).toMatch(/ELSIF v_mode = 'gateway_response_headers'[\s\S]*?public\.rebuild_ingress_headers_v1\([\s\S]*?'persisted',[\s\S]*?v_snapshot IS NULL/);
    expect(sql).toMatch(/OR response_headers IS DISTINCT FROM public\.rebuild_ingress_headers_v1\([\s\S]*?'persisted',[\s\S]*?TRUE/);
    expect(sql).toMatch(/response_headers = public\.rebuild_ingress_headers_v1\([\s\S]*?'persisted',[\s\S]*?TRUE/);
  });

  test('makes canonical policy snapshots route-bound and immutable across updates', () => {
    const sql = readMigration();
    expect(sql).toContain('api gateway persistence policy snapshot is immutable on route-preserving update');
    expect(sql).toContain('outbound ingress persistence policy snapshot is immutable on route-preserving update');
    expect(sql).toContain('workflow ingress persistence policy snapshot is immutable on route-preserving update');
    expect(sql).toContain("v_api_route_id IS DISTINCT FROM v_old_api_route_id");
    expect(sql).toContain("FROM public.api_routes\n         WHERE id = v_api_route_id");
    expect(sql).toContain('ingress execution URL Vault reference cannot be supplied or replaced directly');
  });

  test('uses one closed registry to install, validate, backfill, and test all durable surfaces', () => {
    assertClosedRegistryContract(readMigration());
  });

  test('mutation discovery rejects an unregistered physical writer or nested path', () => {
    const sql = readMigration();
    const relationKinds = new Map();
    const removedRelations = new Set();
    for (const migrationName of fs.readdirSync(path.dirname(migrationPath)).filter((name) => name.endsWith('.sql')).sort()) {
      const migrationSource = fs.readFileSync(path.join(path.dirname(migrationPath), migrationName), 'utf8');
      for (const relation of migrationSource.matchAll(/(?:CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?|DROP\s+(TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?)(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi)) {
        const relationName = relation[3].toLowerCase();
        if (relation[1]) {
          relationKinds.set(relationName, relation[1].toLowerCase());
          removedRelations.delete(relationName);
        } else {
          relationKinds.delete(relationName);
          removedRelations.add(relationName);
        }
      }
    }
    const physicalMutation = `${sql}\nUPDATE public.api_gateway_requests SET replay_query = 'secret';`;
    const nestedMutation = `${sql}\nSELECT jsonb_set(context, '{api_gateway,replay_query}'::TEXT[], '"secret"');`;
    const newTableMutation = `${sql}\nINSERT INTO public.api_gateway_replay_log (query_string) VALUES ('secret');`;
    const schemaMutation = `${sql}\nCREATE TABLE public.api_gateway_replay_log (\n  replay_query TEXT\n);`;
    const discoverWithExpandedSensitiveNames = (candidate) => {
      const registry = parseRegistry(candidate);
      const physical = new Set(registry.map((item) => `${item.table}.${item.column}`));
      const unregistered = [];
      const canonicalTable = (value) => value.replaceAll('"', '').toLowerCase();
      const canonicalColumn = (value) => value.replaceAll('"', '').trim().toLowerCase();
      const isIngressTable = (table) => physical.has(`${table}.context`)
        || [...physical].some((entry) => entry.startsWith(`${table}.`))
        || /(?:^|_)(?:api_gateway|ingress|webhook)(?:_|$)/.test(table);
      const record = (tableValue, columnValue) => {
        const table = canonicalTable(tableValue);
        const column = canonicalColumn(columnValue);
        // Compatibility views do not own durable state. Their underlying
        // canonical tables remain subject to the registry and DB trigger.
        if (relationKinds.get(table) === 'view' || removedRelations.has(table)) return;
        if (!isIngressTable(table) || !/(?:header|query|url|path)/.test(column)) return;
        if (/^response_(?:headers?|url|path|query)$/.test(column)) return;
        if (!physical.has(`${table}.${column}`)) unregistered.push(`${table}.${column}`);
      };
      const tablePattern = '(?:"?public"?\\.)?"?([a-z0-9_]+)"?';
      for (const match of candidate.matchAll(new RegExp(`INSERT\\s+INTO\\s+${tablePattern}\\s*\\(([^)]*)\\)`, 'gi'))) {
        for (const column of match[2].split(',')) record(match[1], column);
      }
      for (const match of candidate.matchAll(new RegExp(`UPDATE\\s+${tablePattern}(?:\\s+"?[a-z0-9_]+"?)?\\s+SET\\s+([\\s\\S]*?)(?=\\n\\s*(?:FROM|WHERE|RETURNING)\\b|;)`, 'gi'))) {
        for (const assignment of match[2].matchAll(/(?:^|,)\s*("?[a-z0-9_]+"?)\s*=/gim)) record(match[1], assignment[1]);
      }
      for (const match of candidate.matchAll(new RegExp(`MERGE\\s+INTO\\s+${tablePattern}[\\s\\S]*?UPDATE\\s+SET\\s+([\\s\\S]*?)(?=WHEN\\s+|;)`, 'gi'))) {
        for (const assignment of match[2].matchAll(/(?:^|,)\s*("?[a-z0-9_]+"?)\s*=/gim)) record(match[1], assignment[1]);
      }
      for (const match of candidate.matchAll(/\.from\(\s*['"]([a-z0-9_]+)['"]\s*\)\s*\.(?:insert|upsert|update)\(\s*\{([\s\S]*?)\}\s*\)/gi)) {
        for (const property of match[2].matchAll(/(?:^|,)\s*['"]?([a-z0-9_]+)['"]?\s*:/gim)) record(match[1], property[1]);
      }
      const resolveObject = (name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const assignment = candidate.match(new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=\\s*\\{([\\s\\S]*?)\\n?\\s*\\};`, 'i'));
        return assignment?.[1] || '';
      };
      const recordPayload = (table, payload) => {
        for (const property of payload.matchAll(/(?:^|,)\s*['"]?([a-z0-9_]+)['"]?\s*:/gim)) record(table, property[1]);
      };
      for (const match of candidate.matchAll(/\.from\(\s*['"]([a-z0-9_]+)['"]\s*\)\s*\.(?:insert|upsert|update)\(\s*([a-z_$][a-z0-9_$]*)\s*\)/gi)) {
        recordPayload(match[1], resolveObject(match[2]));
      }
      for (const match of candidate.matchAll(/\/(?:rest\/v1|api)\/([a-z0-9_]+)([\s\S]{0,1000})/gi)) {
        for (const property of match[2].matchAll(/['"]([a-z0-9_]*(?:header|query|url|path)[a-z0-9_]*)['"]\s*:/gi)) record(match[1], property[1]);
        for (const variable of match[2].matchAll(/JSON\.stringify\(\s*([a-z_$][a-z0-9_$]*)\s*\)/gi)) {
          recordPayload(match[1], resolveObject(variable[1]));
        }
      }
      const sqlLiteral = String.raw`\b[Ee]'(?:\\.|''|[^'\\])*'|'(?:''|[^'])*'`;
      const quotedSql = `${sqlLiteral}|"(?:""|[^"])*"`;
      for (const match of candidate.matchAll(new RegExp(`CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${tablePattern}\\s*\\(((?:${quotedSql}|[^'"])*?)\\);`, 'gi'))) {
        const declarations = match[2].replace(new RegExp(sqlLiteral, 'g'), "''");
        for (const declaration of declarations.matchAll(/(?:^|,)\s*("?[a-z0-9_]+"?)\s+[a-z]/gim)) record(match[1], declaration[1]);
      }
      for (const match of candidate.matchAll(new RegExp(`ALTER\\s+TABLE\\s+${tablePattern}\\s+ADD\\s+COLUMN(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+("?[a-z0-9_]+"?)\\b`, 'gi'))) {
        record(match[1], match[2]);
      }
      const nested = new Set(registry.map((item) => `${item.table}.${item.column}.${item.nested_path.join('.')}`));
      for (const segments of discoverNestedPersistencePaths(candidate)) {
        const key = `workflow_runs.context.${segments.join('.')}`;
        if (!nested.has(key)) unregistered.push(key);
      }
      for (const match of candidate.matchAll(/jsonb_set\(\s*(context|decision_inputs)\s*,\s*'\{([^}]+)\}'(?:::TEXT\[\])?/gi)) {
        const container = match[1].toLowerCase();
        const segments = match[2].toLowerCase().split(',');
        if (!/(?:header|query|url|path)/.test(segments.at(-1))) continue;
        const table = container === 'decision_inputs' ? 'decision_log' : 'workflow_runs';
        const exact = `${table}.${container}.${segments.join('.')}`;
        const recursive = registry.some((item) => item.table === table
          && item.column === container
          && item.representation === 'jsonb_recursive');
        if (!nested.has(exact) && !recursive) unregistered.push(exact);
      }
      for (const match of candidate.matchAll(/UPDATE\s+public\.(workflow_runs|outbound_calls|decision_log)\s+SET\s+(context|decision_inputs)\s*=\s*jsonb_build_object\(([\s\S]*?)\);/gi)) {
        for (const property of match[3].matchAll(/['"]([a-z0-9_]*(?:header|query|url|path)[a-z0-9_]*)['"]/gi)) {
          const table = match[1].toLowerCase();
          const column = match[2].toLowerCase();
          const recursive = registry.some((item) => item.table === table
            && item.column === column
            && item.representation === 'jsonb_recursive');
          if (!recursive && !nested.has(`${table}.${column}.${property[1].toLowerCase()}`)) {
            unregistered.push(`${table}.${column}.${property[1].toLowerCase()}`);
          }
        }
      }
      const sourceFile = ts.createSourceFile(
        'ingress-writer.tsx',
        candidate,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const bindings = new Map();
      const isFunctionScope = (node) => ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node)
        || ts.isConstructorDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node);
      const lexicalScope = (node) => {
        let current = node.parent;
        while (current
          && !ts.isSourceFile(current)
          && !ts.isBlock(current)
          && !isFunctionScope(current)) current = current.parent;
        return current || sourceFile;
      };
      const bindVariables = (node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const entries = bindings.get(node.name.text) || [];
          entries.push({
            declaration: node,
            initializer: node.initializer,
            scope: lexicalScope(node),
          });
          bindings.set(node.name.text, entries);
        }
        ts.forEachChild(node, bindVariables);
      };
      bindVariables(sourceFile);
      const isWithinScope = (node, scope) => {
        let current = node;
        while (current) {
          if (current === scope) return true;
          current = current.parent;
        }
        return false;
      };
      const scopeDepth = (scope) => {
        let depth = 0;
        let current = scope;
        while (current) {
          depth += 1;
          current = current.parent;
        }
        return depth;
      };
      const resolveNode = (node, seen = new Set()) => {
        if (!node) return null;
        if (ts.isParenthesizedExpression(node)) return resolveNode(node.expression, seen);
        if (ts.isIdentifier(node) && bindings.has(node.text)) {
          const candidates = bindings.get(node.text)
            .filter((entry) => entry.declaration.getStart(sourceFile) < node.getStart(sourceFile)
              && isWithinScope(node, entry.scope)
              && !seen.has(entry.declaration.pos))
            .sort((left, right) => scopeDepth(right.scope) - scopeDepth(left.scope)
              || right.declaration.getStart(sourceFile) - left.declaration.getStart(sourceFile));
          if (candidates.length) {
            const selected = candidates[0];
            return resolveNode(selected.initializer, new Set([...seen, selected.declaration.pos]));
          }
        }
        return node;
      };
      const propertyName = (name) => {
        if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
        return null;
      };
      const collectPaths = (node, prefix = [], seen = new Set()) => {
        const resolved = resolveNode(node, seen);
        if (!resolved) return [];
        if (ts.isArrayLiteralExpression(resolved)) {
          return resolved.elements.flatMap((element) => collectPaths(element, prefix, seen));
        }
        if (!ts.isObjectLiteralExpression(resolved)) return [];
        const paths = [];
        for (const property of resolved.properties) {
          if (ts.isSpreadAssignment(property)) {
            paths.push(...collectPaths(property.expression, prefix, seen));
            continue;
          }
          if (ts.isShorthandPropertyAssignment(property)) {
            const next = [...prefix, property.name.text.toLowerCase()];
            paths.push(next, ...collectPaths(property.name, next, seen));
            continue;
          }
          if (!ts.isPropertyAssignment(property)) continue;
          const name = propertyName(property.name);
          if (!name) continue;
          const next = [...prefix, name.toLowerCase()];
          paths.push(next, ...collectPaths(property.initializer, next, seen));
        }
        return paths;
      };
      const validateAstPayload = (tableValue, payloadNode) => {
        const table = canonicalTable(tableValue);
        for (const segments of collectPaths(payloadNode)) {
          if (segments.length === 1) record(table, segments[0]);
          const containerIndex = segments.findIndex((part) => part === 'context' || part === 'decision_inputs');
          if (containerIndex < 0 || containerIndex === segments.length - 1) continue;
          const container = segments[containerIndex];
          const nestedSegments = segments.slice(containerIndex + 1);
          if (!nestedSegments.some((part) => /(?:header|query|url|path)/.test(part))) continue;
          const exact = `${table}.${container}.${nestedSegments.join('.')}`;
          const recursive = registry.some((item) => item.table === table
            && item.column === container
            && item.representation === 'jsonb_recursive');
          if (!recursive && !nested.has(exact)) unregistered.push(exact);
        }
      };
      const inspectCall = (node) => {
        if (!ts.isCallExpression(node)) return ts.forEachChild(node, inspectCall);
        if (ts.isPropertyAccessExpression(node.expression)
          && ['insert', 'upsert', 'update'].includes(node.expression.name.text)
          && ts.isCallExpression(node.expression.expression)
          && ts.isPropertyAccessExpression(node.expression.expression.expression)
          && node.expression.expression.expression.name.text === 'from'
          && ts.isStringLiteral(node.expression.expression.arguments[0])) {
          validateAstPayload(node.expression.expression.arguments[0].text, node.arguments[0]);
        }
        if (ts.isIdentifier(node.expression)
          && node.expression.text === 'fetch'
          && ts.isStringLiteral(node.arguments[0])) {
          const endpoint = node.arguments[0].text.match(/\/(?:rest\/v1|api)\/([a-z0-9_]+)/i);
          const optionsNode = resolveNode(node.arguments[1]);
          if (endpoint && optionsNode && ts.isObjectLiteralExpression(optionsNode)) {
            const bodyProperty = optionsNode.properties.find((property) => ts.isPropertyAssignment(property)
              && propertyName(property.name)?.toLowerCase() === 'body');
            if (bodyProperty && ts.isPropertyAssignment(bodyProperty)) {
              const bodyNode = resolveNode(bodyProperty.initializer);
              if (bodyNode && ts.isCallExpression(bodyNode)
                && ts.isPropertyAccessExpression(bodyNode.expression)
                && bodyNode.expression.expression.getText(sourceFile) === 'JSON'
                && bodyNode.expression.name.text === 'stringify') {
                validateAstPayload(endpoint[1], bodyNode.arguments[0]);
              }
            }
          }
        }
        return ts.forEachChild(node, inspectCall);
      };
      inspectCall(sourceFile);
      if (unregistered.length) throw new Error(`unregistered ingress persistence: ${[...new Set(unregistered)].join(', ')}`);
    };
    const migrationDirectory = path.dirname(migrationPath);
    const laterMigrationSource = fs.readdirSync(migrationDirectory)
      .filter((name) => name.endsWith('.sql') && name > path.basename(migrationPath))
      .sort()
      .map((name) => fs.readFileSync(path.join(migrationDirectory, name), 'utf8'))
      .join('\n');
    expect(() => discoverWithExpandedSensitiveNames(sql)).not.toThrow();
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\n${laterMigrationSource}`)).not.toThrow();
    // Earlier migrations are immutable execution history: this migration's
    // registry, trigger installation, and backfill reconcile their final
    // schema. Scan live writers here; later migrations are scanned above.
    const trackedWriters = execFileSync('git', [
      'grep', '-Il', '-E',
      '(api_gateway_requests|webhook_[a-z0-9_]+|workflow_runs|outbound_calls|decision_log|audit_table_changes|api_gateway_[a-z0-9_]*(log|replay))',
      '--', '.github', 'apps', 'packages', 'scripts', 'supabase/functions',
    ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/)
      .filter((name) => name && !name.includes('/archive/') && !name.startsWith('docs/ops/evidence/'));
    const untrackedWriters = execFileSync('git', [
      'ls-files', '--others', '--exclude-standard', '--',
      '.github', 'apps', 'packages', 'scripts', 'supabase/functions',
    ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/)
      .filter((name) => name && /\.(?:js|cjs|mjs|ts|tsx|sql|yml|yaml)$/i.test(name));
    const repositoryWriters = [...new Set([...trackedWriters, ...untrackedWriters])];
    for (const writerPath of repositoryWriters) {
      const writerSource = fs.readFileSync(path.join(process.cwd(), writerPath), 'utf8');
      expect(() => discoverWithExpandedSensitiveNames(`${sql}\n${writerSource}`)).not.toThrow();
    }
    expect(() => discoverWithExpandedSensitiveNames(physicalMutation)).toThrow('replay_query');
    expect(() => discoverWithExpandedSensitiveNames(nestedMutation)).toThrow('replay_query');
    expect(() => discoverWithExpandedSensitiveNames(newTableMutation)).toThrow('api_gateway_replay_log.query_string');
    expect(() => discoverWithExpandedSensitiveNames(schemaMutation)).toThrow('api_gateway_replay_log.replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nCREATE TABLE public.api_gateway_replay_log (replay_query TEXT);`)).toThrow('api_gateway_replay_log.replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nCREATE TABLE public.api_gateway_replay_log (id UUID, replay_query TEXT);`)).toThrow('api_gateway_replay_log.replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nCREATE TABLE public.api_gateway_replay_log (value TEXT DEFAULT 'x);y', replay_query TEXT);`)).toThrow('api_gateway_replay_log.replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nCREATE TABLE public.webhook_state (value TEXT DEFAULT 'x, replay_query TEXT');`)).not.toThrow();
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nMERGE INTO "public"."api_gateway_replay_log" t USING s ON true WHEN MATCHED THEN UPDATE SET "replay_query" = s.value;`)).toThrow('replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nclient.from('api_gateway_replay_log').upsert({ replay_query: value });`)).toThrow('replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nfetch('/rest/v1/api_gateway_replay_log', { body: JSON.stringify({ "replay_query": value }) });`)).toThrow('replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nconst payload = { replay_query: value };\nclient.from('api_gateway_replay_log').insert(payload);`)).toThrow('replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nconst payload = { replay_query: value };\nfetch('/rest/v1/api_gateway_replay_log', { body: JSON.stringify(payload) });`)).toThrow('replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nUPDATE public.workflow_runs SET context = jsonb_build_object('api_gateway', jsonb_build_object('replay_query', value));`)).toThrow('workflow_runs.context.replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nINSERT INTO public.webhook_replay_events (request_url) VALUES ('secret');`)).toThrow('webhook_replay_events.request_url');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nconst context = { api_gateway: { replay_query: value } };\nconst payload = { context };\nclient.from('workflow_runs').insert(payload);`)).toThrow('workflow_runs.context.api_gateway.replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nconst payload = { context: { api_gateway: { replay_url: value } } };\nfetch('/rest/v1/workflow_runs', { body: JSON.stringify(payload) });`)).toThrow('workflow_runs.context.api_gateway.replay_url');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nfunction unsafeWriter() { const payload = { context: { api_gateway: { replay_query: secret } } }; client.from('workflow_runs').insert(payload); }\nfunction safeWriter() { const payload = { context: { api_gateway: { query_string: safe } } }; client.from('workflow_runs').insert(payload); }`)).toThrow('workflow_runs.context.api_gateway.replay_query');
    expect(() => discoverWithExpandedSensitiveNames(`${sql}\nUPDATE public.outbound_calls SET url = safe_projection;`)).not.toThrow();
  });

  test('backfills every registered table in bounded skip-locked cohorts', () => {
    const sql = readMigration();
    for (const table of ['api_gateway_requests', 'webhook_inbox', 'workflow_runs', 'outbound_calls', 'decision_log', 'audit_table_changes']) {
      expect(sql).toContain(`UPDATE public.${table}`);
    }
    expect(sql).toContain('LIMIT v_limit\n    FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('LEAST(GREATEST(COALESCE(p_batch_size, 500), 1), 2000)');
    expect(sql).toContain('target.persistence_policy_snapshot,\n          TRUE');
    expect(sql).toContain("'has_more', v_has_more");
    expect(sql).toContain('v_unrecoverable_count BIGINT := 0');
    expect(sql).toContain('LIMIT 10');
    expect(sql).toContain('count %, sample ids %');
  });

  test('preserves dynamic function ACLs and limits the repair operator', () => {
    const sql = readMigration();
    expect(sql).not.toMatch(/(?:GRANT|REVOKE)[^;]*workflow_intake_webhook_core_v1/i);
    expect(sql).not.toMatch(/(?:GRANT|REVOKE)[^;]*workflow_intake_api_gateway_v1/i);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.backfill_ingress_persisted_redaction_v1(INT) FROM PUBLIC');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.backfill_ingress_persisted_redaction_v1(INT) TO service_role');
  });
});
