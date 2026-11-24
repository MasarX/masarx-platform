const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');

const workflowDir = path.resolve(__dirname, '../../../.github/workflows');
const workflowSource = fs.readFileSync(path.join(workflowDir, 'deploy.yml'), 'utf8');
const workflow = yaml.parse(workflowSource);
const job = workflow.jobs['database-dry-run'];
const measure = job.steps.find(step => step.id === 'measure');
const rendererClaims = workflow.jobs['api-schemas'].steps.find(step => step.name === 'Read renderer JWT claims');
const fixtureRef = 'abcdefghijklmnopqrst';
const tenantStates = ['ready', 'placeholder_url', 'missing_url', 'missing_secret_ref', 'secret_unreadable', 'pin_mismatch', 'placeholder_secret'];

test('runs one manual dry-run job in dev with only read access and pinned GitHub actions', () => {
  expect(workflow.on.push).toEqual({ branches: ['main'] });
  expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.mode == 'dry-run'");
  const inputs = workflow.on.workflow_dispatch.inputs;
  expect(inputs.mode).toMatchObject({ type: 'choice', required: true, default: 'deploy', options: ['deploy', 'dry-run', 'api-schemas'] });
  expect(inputs.project_ref).toMatchObject({ type: 'string' });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(workflow.jobs).sort()).toEqual([
    'api-schemas',
    'console',
    'console-v2',
    'database',
    'database-dry-run',
    'e2e-report',
    'ingress',
    'landing',
    'portal',
    'summary',
  ]);
  expect(job.permissions).toBeUndefined();
  expect(job.environment).toBe('dev');
  expect(job['timeout-minutes']).toBeGreaterThan(45);
  expect(job.concurrency).toEqual({ group: 'dev-db-dry-run', 'cancel-in-progress': false });
  expect(job.concurrency.group).not.toBe(workflow.jobs.database.concurrency.group);
  expect(job.steps.filter(step => step.uses).map(step => step.uses)).toEqual([
    expect.stringMatching(/^actions\/checkout@[a-f0-9]{40}$/),
  ]);
});

test('keeps deploy and its summary on push and on the normal dispatch mode', () => {
  const deployCondition = "github.event_name == 'push' || inputs.mode == 'deploy'";
  expect(workflow.jobs.database.if).toBe(deployCondition);
  expect(workflow.jobs.summary.if).toBe(`\${{ always() && (${deployCondition}) }}`);
  for (const target of ['console', 'portal', 'landing', 'ingress']) {
    expect(workflow.jobs[target].needs).toBe('database');
    expect(workflow.jobs[target].if).toContain("needs.database.result == 'success'");
  }
});

test('runs the configuration readout only on manual dispatch in dev with read access', () => {
  const readout = workflow.jobs['api-schemas'];
  expect(readout.if).toBe("github.event_name == 'workflow_dispatch' && inputs.mode == 'api-schemas'");
  expect(readout.environment).toBe('dev');
  expect(readout['timeout-minutes']).toBe(10);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(readout.permissions).toBeUndefined();
  expect(rendererClaims.run).toContain('renderer_unreadable "sqlstate-$sqlstate"');
  expect(rendererClaims.run).toContain('renderer_unreadable "psql-exit-$psql_status"');
});

test('limits the dedicated DEV diagnostics credential to schema and Edge log reads', () => {
  const steps = workflow.jobs['api-schemas'].steps;
  const diagnosticSecret = '${{ secrets.SUPABASE_DIAGNOSTICS_ACCESS_TOKEN }}';
  const diagnostics = ['Read configured API schemas', 'Read outbound wake HTTP diagnostics'];
  for (const name of diagnostics) {
    const step = steps.find(candidate => candidate.name === name);
    expect(step.env.SUPABASE_ACCESS_TOKEN).toBe(diagnosticSecret);
    expect(step.run).toContain('[[ -z "$SUPABASE_ACCESS_TOKEN" ]]');
    expect(step.run).toMatch(/unreadable no-token\b/);
  }
  expect(rendererClaims.env.SUPABASE_ACCESS_TOKEN).toBe('${{ secrets.SUPABASE_ACCESS_TOKEN }}');
  expect(workflowSource.match(/\bSUPABASE_DIAGNOSTICS_ACCESS_TOKEN\b/g)).toHaveLength(2);
});

test('runs the outbound wake readout as one fixed read-only query', () => {
  const [, sql] = rendererClaims.run.match(/wake_metrics="\$\(renderer_psql <<'SQL'\n([\s\S]+?)\nSQL\n\)" \|\| renderer_query_failed "\$\?" outbound_wake\n/);
  const statements = sql.replace(/--[^\n]*|'(?:''|[^'])*'/g, '').split(';').slice(0, -1);
  expect(statements.map(statement => statement.trim().split(/\s+/)[0])).toEqual([
    'BEGIN', 'SET', 'SET', 'WITH', 'COMMIT',
  ]);
  expect(sql).toMatch(/^BEGIN TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = '8s';\nSET LOCAL search_path = pg_catalog;/);
  expect(sql).toMatch(/\nCOMMIT;$/);
  expect(statements.join(' ')).not.toMatch(/\\|\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|GRANT|MERGE|TRUNCATE|COPY|CALL|DO|INTO|LOCK)\b|\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b/i);
  const calls = [...statements[3].matchAll(/\b([\w.]+)\s*\(/g)].map(([, name]) => name.toLowerCase());
  expect([...new Set(calls)].sort()).toEqual([
    'and', 'as', 'coalesce', 'count', 'exists', 'extract', 'filter', 'floor', 'from',
    'in', 'materialized', 'now', 'or', 'select', 'to_jsonb', 'using',
  ]);
});

test('projects only outbound wake counts, ages, the active flag and the cron schedule', () => {
  const [, projection] = rendererClaims.run.match(/SELECT to_jsonb\(metrics\) FROM \(\n  SELECT ([\s\S]+?)\n  FROM queue\n\) metrics;/);
  const columns = projection.split(/\s+AS ([a-z_0-9]+)(?:,\s*|$)/);
  expect(columns.pop()).toBe('');
  const fields = Object.fromEntries(columns.filter((_, index) => index % 2 === 1)
    .map((name, index) => [name, columns[index * 2]]));
  expect(Object.keys(fields)).toEqual([
    'gate_slot_age_seconds', 'cron_active', 'cron_schedule', 'cron_starting_count',
    'cron_connecting_count', 'cron_sending_count', 'cron_running_count', 'cron_succeeded_count',
    'cron_failed_count', 'cron_other_count', 'edge_pending_60m_count', 'edge_leased_60m_count',
    'edge_completed_60m_count', 'edge_failed_60m_count', 'edge_pending_due_over_120s_count',
    'edge_last_success_age_seconds',
  ]);
  for (const [name, expression] of Object.entries(fields)) {
    if (name.endsWith('_count')) {
      expect(expression).toMatch(/^(?:\(SELECT count\(\*\) FROM sweep_runs WHERE |count\(\*\) FILTER \(WHERE )[\s\S]+\)$/);
    }
  }
  expect(fields.gate_slot_age_seconds).toContain('SELECT floor(extract(epoch FROM now() - last_run_at))::bigint');
  expect(fields.edge_last_success_age_seconds).toContain('SELECT floor(extract(epoch FROM now() - created_at))::bigint');
  expect(fields.cron_active).toBe('coalesce((SELECT active FROM sweep), false)');
  expect(fields.cron_schedule).toBe('(SELECT schedule FROM sweep)');
  expect(rendererClaims.run).toMatch(/if ! wake_readout="\$\(jq -ces '[\s\S]+?' <<< "\$wake_metrics" 2>\/dev\/null\)"; then\n  renderer_unreadable validate outbound_wake\nfi\nprintf 'outbound_wake=%s\\n' "\$wake_readout" \| tee -a "\$GITHUB_STEP_SUMMARY"/);
});

test('shares one read-only renderer state query and opts in to tenant counts only for claims', () => {
  const { RENDERER_CONFIG_STATE_SQL: sql, RENDERER_CONFIG_STATE_PATTERN: pattern } = rendererClaims.env;
  const states = ['missing_settings', 'missing_url', 'placeholder_url', 'missing_secret_ref', 'secret_unreadable', 'pin_mismatch', 'placeholder_secret', 'ready'];
  expect(pattern).toBe(`^renderer_config_state=(${states.join('|')})$`);
  const sqlStates = [...sql.matchAll(/(?:state :=|THEN|ELSE) '([a-z_]+)'/g)].map(([, state]) => state);
  expect([...new Set(sqlStates)].sort()).toEqual(states.sort());
  expect(sql.replace(/^--.*\n/gm, '').replace(/DO \$renderer_state\$\n[\s\S]+?\n\$renderer_state\$;\n/, '')).toBe([
    'BEGIN READ ONLY;',
    "SET LOCAL statement_timeout = '8s';",
    'SET LOCAL search_path = pg_catalog;',
    '\\if :{?renderer_count_tenants}',
    "SET LOCAL renderer.count_tenants = 'on';",
    '\\else',
    "SET LOCAL renderer.count_tenants = 'off';",
    '\\endif',
    "SELECT 'renderer_config_state=' || current_setting('renderer.config_state');",
    '\\if :{?renderer_count_tenants}',
    "SELECT 'renderer_tenant_states=' || string_agg(",
    "  label || ':' || COALESCE(current_setting('renderer.tenant_counts')::jsonb->>label, '0'),",
    "  ',' ORDER BY position)",
    `FROM unnest(ARRAY[${tenantStates.slice(0, 4).map(state => `'${state}'`).join(', ')},`,
    `  ${tenantStates.slice(4).map(state => `'${state}'`).join(', ')}]) WITH ORDINALITY AS labels(label, position);`,
    '\\endif',
    'COMMIT;',
    '',
  ].join('\n'));
  expect(sql).not.toMatch(/\bRAISE\b|resolve_label_(?:renderer_invoke_config|provider_invoke_secret)_v1/m);
  expect(sql).toContain("PERFORM set_config('renderer.config_state', state, true);");
  expect(sql).toContain([
    '    SELECT s.cached_value, false',
    '    FROM public.settings s',
    "    WHERE current_setting('renderer.count_tenants') = 'on'",
    "      AND s.category = 'label_provider' AND s.scope_type = 'tenant' AND s.scope_id IS NOT NULL",
  ].join('\n'));
  expect(sql).toContain('to_jsonb(COALESCE((tenant_counts->>state)::bigint, 0) + 1)');
});

test('accepts only fixed tenant state labels and unsigned integer counts in the readout', () => {
  const pattern = rendererClaims.env.RENDERER_TENANT_STATES_PATTERN;
  expect(pattern).toBe(`^renderer_tenant_states=${tenantStates.map(state => `${state}:[0-9]+`).join(',')}$`);
  const valid = `renderer_tenant_states=${tenantStates.map((state, index) => `${state}:${index * 10}`).join(',')}`;
  const readout = new RegExp(pattern);
  expect(valid).toMatch(readout);
  for (const count of ['-1', '1.5', 'hidden-value']) {
    expect(valid.replace('ready:0', `ready:${count}`)).not.toMatch(readout);
  }
  expect(valid.replace('ready:0', 'unknown:0')).not.toMatch(readout);
  expect(`${valid}\nother_line`).not.toMatch(readout);
});

test('prints the validated renderer readout before the claims gate and any resolver call', () => {
  const psql = 'psql -X -w -A -q -t -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate';
  expect(rendererClaims.run).toContain(`${psql} "$@" 2>"$psql_stderr"`);
  const readAndGate = [
    'renderer_states="$(renderer_psql -v renderer_count_tenants=on <<< "$RENDERER_CONFIG_STATE_SQL")" || renderer_query_failed "$?"',
    'renderer_state="${renderer_states%%$\'\\n\'*}"',
    'renderer_tenant_states="${renderer_states#*$\'\\n\'}"',
    '[[ "$renderer_state" =~ $RENDERER_CONFIG_STATE_PATTERN ]] || renderer_unreadable state',
    "printf '%s\\n' \"$renderer_state\" | tee -a \"$GITHUB_STEP_SUMMARY\"",
    '[[ "$renderer_tenant_states" =~ $RENDERER_TENANT_STATES_PATTERN ]] || renderer_unreadable tenant-states',
    "printf '%s\\n' \"$renderer_tenant_states\" | tee -a \"$GITHUB_STEP_SUMMARY\"",
    '[[ "$renderer_state" == renderer_config_state=ready ]] || exit 1',
  ].join('\n');
  expect(rendererClaims.run).toContain(readAndGate);
  const gateEnd = rendererClaims.run.indexOf(readAndGate) + readAndGate.length;
  expect(rendererClaims.run.slice(0, gateEnd)).not.toMatch(/resolve_label_(?:renderer_invoke_config|provider_invoke_secret)_v1|vault\.update_secret|node <<'NODE'/);
  expect(rendererClaims.run.slice(gateEnd)).toMatch(/claims="\$\(renderer_psql <<'SQL'\n[\s\S]+public\.resolve_label_renderer_invoke_config_v1/);
});

test('deploy offers no renderer invocation token mint mode or signing step', () => {
  expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual(['environment', 'expected_sha', 'mode', 'project_ref']);
  expect(workflow.jobs).not.toHaveProperty('renderer-jwt-mint');
  const steps = Object.values(workflow.jobs).flatMap(job => job.steps || []);
  expect(steps.map(step => step.name)).not.toContain('Rotate the DEV renderer invoke credential');
  expect(steps.map(step => step.run || '').join('\n')).not.toMatch(/\b(?:RENDERER_(?:IAT|EXP|TOKEN_FILE)|renderer_signing_secret)\b/);
});

test('deploy cannot stage or write the retired renderer invocation token', () => {
  expect(workflowSource).not.toMatch(/renderer_mint_failed|renderer_jwt_mint=|renderer\.jwt\b/);
  expect(workflowSource).not.toMatch(/\b(?:vault\s*\.\s*(?:create_secret|update_secret)|upsert_label_provider_settings_v1|\\bind\s+:renderer_jwt)\b/i);
});

test('rejects other modes and masks the dispatch ref before exporting it', () => {
  const guard = job.steps[0];
  expect(guard.id).toBe('guard');
  expect(guard.if).toBeUndefined();
  expect(guard.env).toEqual({
    MODE: '${{ inputs.mode }}',
    TARGET_MATCHES_DEV: "${{ vars.SUPABASE_PROJECT_REF == '' || vars.SUPABASE_PROJECT_REF == inputs.project_ref }}",
  });
  expect(guard.run).toMatch(/if \[\[ "\$MODE" != dry-run \]\]; then\n[^\n]+\n\s+exit 1\nfi/);
  expect(guard.run).toContain('.inputs.project_ref');
  expect(guard.run).toContain('"$GITHUB_EVENT_PATH"');
  expect(guard.run).toMatch(/::add-mask::%s[\s\S]+>> "\$GITHUB_ENV"/);
  expect(measure.if).toBeUndefined();
});

test('accepts only project refs with exactly 20 lowercase letters', () => {
  const [, encodedPattern] = job.steps[0].run.match(/select\(test\(("(?:\\.|[^"\\])*")\)\)/);
  const jqPattern = JSON.parse(encodedPattern);
  // Translate jq's absolute anchors for JavaScript, including the final newline case.
  const projectRef = new RegExp(jqPattern.replace(/^\\A/, '^').replace(/\\z$/, '(?![\\s\\S])'), 'u');
  expect(fixtureRef).toMatch(projectRef);
  for (const invalid of [
    fixtureRef.slice(1), `${fixtureRef}u`, fixtureRef.toUpperCase(), `${fixtureRef.slice(1)}1`,
    `https://${fixtureRef}.supabase.co`, `${fixtureRef}\n`,
  ]) {
    expect(invalid).not.toMatch(projectRef);
  }
});

test('copies the deploy CLI pin and link command, and always pushes with dry-run enabled', () => {
  const deploy = workflow.jobs.database;
  const deployInstall = deploy.steps.find(step => step.name === 'Prepare edge packages and pinned CLI');
  const dryRunInstall = job.steps.find(step => step.name === 'Install pinned Supabase CLI');
  expect(deployInstall.run).toContain(dryRunInstall.run);
  const deployStep = deploy.steps.find(step => step.id === 'deploy');
  const link = deployStep.run.split('\n').find(line => line.includes(' link --project-ref '));
  expect(link).toBeDefined();
  expect(measure.run).toContain(`if ${link} > /dev/null 2>&1; then`);
  expect(measure.env).toEqual(deployStep.env);
  expect(measure.env.SUPABASE_PROJECT_REF).toBe("${{ inputs.mode != 'dry-run' && vars.SUPABASE_PROJECT_REF || '' }}");
  expect(measure.run).toContain('unset SUPABASE_JWT_SECRET');
  expect(measure.run).toContain('export SUPABASE_PROJECT_REF="$DEV_DRY_RUN_PROJECT_REF"');
  expect(measure.run).toMatch(/if \[\[ -z "\$SUPABASE_ACCESS_TOKEN" \|\| -z "\$SUPABASE_DB_PASSWORD" \]\]; then\n[^\n]+\n\s+exit 1/);
  const commands = job.steps.map(step => step.run || '').join('\n');
  expect(commands).not.toMatch(/\b(?:db\s+reset|migration\s+repair)\b|--include-(?:seed|all|roles)\b/);
  const pushes = commands.split('\n')
    .map(line => line.trim()).filter(line => /\bdb\s+push\b/.test(line));
  expect(pushes).toEqual(['"$cli" db push --dry-run --linked > "$output" 2>&1 || status=$?']);
});

function summarize(output, status, elapsed, stage = 'dry-run', timeoutMinutes = job.env.DEV_DB_DEPLOY_TIMEOUT_MINUTES) {
  const write = jest.fn();
  const error = jest.fn();
  const log = jest.fn();
  const process = {
    argv: ['node', '-', 'output', stage, String(status), String(elapsed)],
    env: {
      DEV_DB_DEPLOY_TIMEOUT_MINUTES: String(timeoutMinutes),
      GITHUB_STEP_SUMMARY: 'summary',
      SUPABASE_PROJECT_REF: fixtureRef,
      SUPABASE_DB_PASSWORD: 'fake-password',
    },
  };
  const script = measure.run.split("<<'NODE'\n")[1].split('\nNODE\n')[0];
  runInNewContext(script, {
    require: () => ({ readFileSync: () => output, appendFileSync: write }),
    console: { error, log },
    process,
  }, { timeout: 1000 });
  expect(write).toHaveBeenCalledWith('summary', expect.any(String));
  return { text: write.mock.calls[0][1], errors: error.mock.calls.flat().join('\n'), logs: log.mock.calls.flat(), code: process.exitCode };
}

test('derives the dry-run warning from the database job timeout', () => {
  expect([workflow.jobs.database['timeout-minutes'], job['timeout-minutes']]).toEqual([180, 90]);
  const document = yaml.parseDocument(workflowSource);
  document.getIn(['jobs', 'database', 'timeout-minutes'], true).value = 2;
  const updatedTimeout = document.toJS().jobs['database-dry-run'].env.DEV_DB_DEPLOY_TIMEOUT_MINUTES;
  const { text } = summarize('Remote database is up to date.\n', 0, 121, 'dry-run', updatedTimeout);
  expect(text).toContain('exceeded the 2-minute DEV database deploy job limit.');
});

test('summarizes the pending migration range and flags a run over 180 minutes', () => {
  const { text, logs, code } = summarize([
    'Connecting to remote database...',
    'Would push these migrations:',
    ' • 20260101000000_first.sql',
    ' • 20260102000000_second.sql',
    ' • 20260103000000_last.sql',
  ].join('\n'), 0, 10801);
  expect(text).toContain('Migrations that would be applied: 3');
  expect(text).toContain('First migration: `20260101000000_first.sql`');
  expect(text).toContain('Last migration: `20260103000000_last.sql`');
  expect(text).toContain('Elapsed seconds (link and dry run): 10801');
  expect(text).toContain('exceeded the 180-minute');
  expect(logs).toEqual([
    'dry-run: migrations=3 first=20260101000000_first.sql last=20260103000000_last.sql order=none elapsed=10801s over_180_min=true',
  ]);
  expect(code).toBeUndefined();
});

test('reports a confirmed empty plan and rejects an unrecognized success response', () => {
  const empty = summarize('Remote database is up to date.\n', 0, 10800);
  expect(empty.text).toContain('Migrations that would be applied: 0');
  expect(empty.text).toContain('First migration: None');
  expect(empty.text).toContain('Last migration: None');
  expect(empty.text).not.toContain('exceeded the 180-minute');
  expect(empty.logs).toEqual(['dry-run: migrations=0 first=None last=None order=none elapsed=10800s over_180_min=false']);
  expect(empty.code).toBeUndefined();
  const unknown = summarize('Unexpected output\n', 0, 2);
  expect(unknown.text).toContain('Migrations that would be applied: Unknown');
  expect(unknown.logs).toEqual(['dry-run: migrations=Unknown first=Unknown last=Unknown order=unknown elapsed=2s over_180_min=false']);
  expect(unknown.code).toBe(1);
});

test('logs the same redacted migration range as the summary', () => {
  const { text, errors, logs } = summarize([
    'Would push these migrations:',
    ` • 20260101000000_${fixtureRef}.sql`,
    ' • 20260102000000_fake-password.sql',
    'Connecting to db.example.test...',
  ].join('\n'), 0, 7);
  expect(text).toContain('First migration: Redacted\n- Last migration: Redacted');
  expect(logs).toEqual(['dry-run: migrations=2 first=Redacted last=Redacted order=none elapsed=7s over_180_min=false']);
  expect([text, errors, ...logs].join('\n')).not.toMatch(new RegExp(`${fixtureRef}|fake-password|db\\.example\\.test`));
});

test('reports out-of-order migration details without emitting project identifiers or secrets', () => {
  const result = summarize([
    'Found local migration files to be inserted before the last migration on remote database.',
    'Rerun the command with --include-all flag to apply these migrations:',
    'supabase/migrations/20260101000000_older.sql',
    `supabase/migrations/20260102000000_${fixtureRef}.sql`,
    'supabase/migrations/20260103000000_fake-password.sql',
    `https://${fixtureRef}.supabase.co`,
  ].join('\n'), 1, 3);
  expect(result.text).toContain('Migrations that would be applied: Unknown');
  expect(result.text).toContain('Out of order');
  expect(result.text).toContain('  - `20260101000000_older.sql`\n  - Redacted\n  - Redacted');
  expect(result.logs).toEqual([
    'dry-run: migrations=Unknown first=Unknown last=Unknown order=out-of-order elapsed=3s over_180_min=false',
    'dry-run: out_of_order=20260101000000_older.sql,Redacted,Redacted',
  ]);
  const output = [result.text, result.errors, ...result.logs].join('\n');
  expect(output).not.toContain(fixtureRef);
  expect(output).not.toMatch(/fake-password|https:\/\//);
  expect(result.code).toBe(1);
});

test('reports missing local migration history and records link failures separately', () => {
  const missing = summarize('Remote migration versions not found in local migrations directory.\n', 1, 8);
  expect(missing.text).toContain('Remote migration versions are missing from the local migrations directory.');
  expect(missing.text).toContain('Migrations that would be applied: Unknown');
  expect(missing.logs).toEqual(['dry-run: migrations=Unknown first=Unknown last=Unknown order=missing-local elapsed=8s over_180_min=false']);
  expect(missing.code).toBe(1);
  const link = summarize('', 2, 4, 'link');
  expect(link.text).toContain('Link failed.');
  expect(link.text).toContain('Elapsed seconds (link and dry run): 4');
  expect(link.code).toBe(2);
});
