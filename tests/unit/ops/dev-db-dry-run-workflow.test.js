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
const rendererMint = workflow.jobs['renderer-jwt-mint'];
const rotate = rendererMint.steps.find(step => step.name === 'Rotate the DEV renderer invoke credential');
const fixtureRef = 'abcdefghijklmnopqrst';
const tenantStates = ['ready', 'placeholder_url', 'missing_url', 'missing_secret_ref', 'secret_unreadable', 'pin_mismatch', 'placeholder_secret'];

test('runs one manual dry-run job in dev with only read access and pinned GitHub actions', () => {
  expect(workflow.on.push).toEqual({ branches: ['main'] });
  expect(job.if).toBe("github.event_name == 'workflow_dispatch' && inputs.mode == 'dry-run'");
  const inputs = workflow.on.workflow_dispatch.inputs;
  expect(inputs.mode).toMatchObject({ type: 'choice', required: true, default: 'deploy', options: ['deploy', 'dry-run', 'api-schemas', 'renderer-jwt-mint'] });
  expect(inputs.project_ref).toMatchObject({ type: 'string' });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(workflow.jobs)).toHaveLength(9);
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

test('shares one read-only renderer state query and opts in to tenant counts only for claims', () => {
  const { RENDERER_CONFIG_STATE_SQL: sql, RENDERER_CONFIG_STATE_PATTERN: pattern } = rendererClaims.env;
  expect(rotate.env.RENDERER_CONFIG_STATE_SQL).toBe(sql);
  expect(rotate.env.RENDERER_CONFIG_STATE_PATTERN).toBe(pattern);
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

test.each([
  ['claims', rendererClaims, 'renderer_unreadable', '[[ "$renderer_state" == renderer_config_state=ready ]] || exit 1'],
  ['mint', rotate, 'renderer_mint_failed', [
    'case "$renderer_state" in',
    '  renderer_config_state=ready|renderer_config_state=placeholder_secret) ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n')],
])('prints the validated renderer readout before the %s gate and any resolver call', (name, step, fail, gate) => {
  const countsTenants = name === 'claims';
  const psql = 'psql -X -w -A -q -t -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate';
  expect(step.run).toContain(`${psql}${countsTenants ? ' "$@"' : ''} 2>"$psql_stderr"`);
  const readAndGate = [
    ...(countsTenants ? [
      'renderer_states="$(renderer_psql -v renderer_count_tenants=on <<< "$RENDERER_CONFIG_STATE_SQL")" || renderer_query_failed "$?"',
      'renderer_state="${renderer_states%%$\'\\n\'*}"',
      'renderer_tenant_states="${renderer_states#*$\'\\n\'}"',
    ] : ['renderer_state="$(renderer_psql <<< "$RENDERER_CONFIG_STATE_SQL")" || renderer_query_failed "$?"']),
    `[[ "$renderer_state" =~ $RENDERER_CONFIG_STATE_PATTERN ]] || ${fail} state`,
    "printf '%s\\n' \"$renderer_state\" | tee -a \"$GITHUB_STEP_SUMMARY\"",
    ...(countsTenants ? [
      '[[ "$renderer_tenant_states" =~ $RENDERER_TENANT_STATES_PATTERN ]] || renderer_unreadable tenant-states',
      "printf '%s\\n' \"$renderer_tenant_states\" | tee -a \"$GITHUB_STEP_SUMMARY\"",
    ] : []),
    gate,
  ].join('\n');
  expect(step.run).toContain(readAndGate);
  const gateEnd = step.run.indexOf(readAndGate) + readAndGate.length;
  expect(step.run.slice(0, gateEnd)).not.toMatch(/resolve_label_(?:renderer_invoke_config|provider_invoke_secret)_v1|vault\.update_secret|node <<'NODE'/);
  expect(step.run.slice(gateEnd)).toMatch(/claims="\$\(renderer_psql <<'SQL'\n[\s\S]+public\.resolve_label_renderer_invoke_config_v1/);
});

test('gates renderer JWT minting to main in dev with read access and independent concurrency', () => {
  expect(rendererMint.if).toBe("github.event_name == 'workflow_dispatch' && inputs.mode == 'renderer-jwt-mint' && inputs.environment == 'dev' && github.ref == 'refs/heads/main'");
  expect(rendererMint.environment).toBe('dev');
  expect(rendererMint.permissions).toBeUndefined();
  expect(rendererMint.concurrency).toEqual({ group: 'dev-renderer-jwt-mint', 'cancel-in-progress': false });
  expect(rendererMint.concurrency.group).not.toBe(workflow.jobs.database.concurrency.group);
});

test('fixes the TTL, masks the JWT before reading or storing it, and clears the signing secret before psql', () => {
  expect(Object.keys(workflow.on.workflow_dispatch.inputs).sort()).toEqual(['environment', 'expected_sha', 'mode', 'project_ref']);
  expect(rotate.run).toContain('RENDERER_EXP="$((RENDERER_IAT + 7 * 24 * 60 * 60))"');
  expect(rotate.run).toMatch(/::add-mask::[\s\S]+token\.split\([\s\S]+writeFileSync\(process\.env\.RENDERER_TOKEN_FILE/);
  expect(rotate.run).toMatch(/renderer_signing_secret="\$SUPABASE_JWT_SECRET"\nunset SUPABASE_JWT_SECRET\numask 077/);
  expect(rotate.run).toContain("SUPABASE_JWT_SECRET=\"$renderer_signing_secret\" node <<'NODE'");
  expect(rotate.run).toMatch(/\nNODE\nunset renderer_signing_secret\n\nclaims="\$\(renderer_psql/);
  expect(rendererMint.steps.map(step => step.run || '').join('\n')).not.toMatch(/\bset\s+(?:-[a-z]*x[a-z]*\b|-o\s+xtrace\b)/);
});

test.each([
  ['valid claims', {}],
  ['wrong role', { role: 'service_role' }],
  ['wrong audience', { aud: 'anonymous' }],
  ['wrong subject', { sub: 'other-function' }],
  ['wrong expiry', { exp: 1 }],
])('checks %s before writing the renderer JWT', (_label, overrides) => {
  const nowSec = 1800000000;
  const ttlSec = 604800;
  const claims = { role: 'edge_label_renderer_role', aud: 'authenticated', sub: 'edge-function', iat: nowSec, exp: nowSec + ttlSec, ...overrides };
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const buildEdgeDbJwtBundle = jest.fn(() => ({ label_renderer_db_jwt: token }));
  const writeFileSync = jest.fn();
  const console = { log: jest.fn(), error: jest.fn() };
  const context = {
    Buffer,
    console,
    require: name => name === 'node:fs' ? { writeFileSync } : { buildEdgeDbJwtBundle },
    process: {
      env: { RENDERER_IAT: String(nowSec), RENDERER_EXP: String(nowSec + ttlSec), SUPABASE_JWT_SECRET: 'synthetic', RENDERER_TOKEN_FILE: 'renderer.jwt' },
      exit: status => { throw new Error(`exit ${status}`); },
    },
  };
  const script = rotate.run.split("<<'NODE'\n")[1].split('\nNODE\n')[0];
  const mint = () => runInNewContext(script, context, { timeout: 1000 });
  if (Object.keys(overrides).length) {
    expect(mint).toThrow('exit 1');
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('::error::Minted renderer JWT claims verification failed.');
  } else {
    mint();
    expect(writeFileSync).toHaveBeenCalledWith('renderer.jwt', token, { mode: 0o600, flag: 'wx' });
  }
  expect(console.log).toHaveBeenCalledWith('::add-mask::' + token);
  expect(buildEdgeDbJwtBundle).toHaveBeenCalledWith({ secret: 'synthetic', nowSec, ttlSec });
});

test('keeps renderer Vault readback atomic and reports only the database failure code', () => {
  expect(rotate.run).toMatch(/umask 077\n[\s\S]+psql_stderr="\$renderer_temp\/psql.stderr"\ntrap '[^\n]+"\$psql_stderr"/);
  const sql = rotate.run.split("<<'SQL'\n")[1].split('\nSQL\n')[0];
  expect(sql).toContain('BEGIN ISOLATION LEVEL SERIALIZABLE;');
  expect(sql).toContain([
    "SELECT public.resolve_settings('label_provider', 'global', NULL::uuid)->'providers'->0 AS value",
    ')',
    'SELECT s.id AS renderer_secret_id',
    'FROM provider p',
    "JOIN vault.secrets s ON s.id = (p.value#>>'{invoke_secret_ref,id}')::uuid",
    "WHERE p.value#>>'{invoke_secret_ref,type}' = 'SecretRef'",
    "  AND starts_with(s.name, 'label_provider/')",
    `  AND NULLIF(p.value->>'invoke_url', '') NOT LIKE (${["'https://'", "'example'", "'.%'"].join(' || ')})`,
    '  AND public.resolve_label_provider_invoke_secret_v1(p.value) <> $1::text',
    '\\bind :renderer_jwt',
    '\\gset',
    '',
    "SELECT vault.update_secret(:'renderer_secret_id'::uuid, $1::text)",
    '\\bind :renderer_jwt',
    '\\g /dev/null',
  ].join('\n'));
  expect(sql).toMatch(/\\g \/dev\/null\n[\s\S]+SELECT public\.resolve_label_renderer_invoke_config_v1\(NULL::uuid\)->>'invoke_secret' AS jwt\n[\s\S]+FROM active WHERE jwt = \$1::text\n\\bind :renderer_jwt\n\\gset\nCOMMIT;\n\\echo :renderer_payload :renderer_digest$/);
  expect(sql.match(/resolve_label_renderer_invoke_config_v1/g)).toHaveLength(1);
  expect(rotate.run).toContain('renderer_jwt_mint=FAILED reason=%s');
  expect(rotate.run).toContain('renderer_mint_failed "sqlstate-$sqlstate"');
  expect(rotate.run).toContain('renderer_mint_failed "psql-exit-$psql_status"');
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
