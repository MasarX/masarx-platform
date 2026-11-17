const fs = require('fs');
const path = require('path');

const integrationRoot = path.resolve(__dirname, '../../integration');
const affectedSuites = [
  'mapping-studio-runtime-save.test.js',
  'workflows/route-run-assignment-lifecycle.test.js',
  'workflows/dispatch-stop-exceptions.test.js',
  'workflows/zones-baskets-workflow.test.js',
  'workflows/warehouse-transfer-execute.test.js',
  'workflows/ui-create-shipment.test.js',
  'workflows/pickup-batch2.test.js',
  'workflows/cod-driver-shift-settlement.test.js',
  'workflows/return-to-branch.test.js',
  'fieldops/fieldops-pickup-execution.test.js',
  'workflows/task-completion-effects.test.js',
  'webhook-replay-stress.test.js',
];
const poolFixtureConsumers = [
  'workflows/create-from-reservation.test.js',
  'workflows/engine-lifecycle.test.js',
  'workflows/recurring-shipment-schedule.test.js',
];

const fixtureAdminSqlSeams = [
  {
    relativePath: 'workflows/route-run-assignment-lifecycle.test.js',
    expected: [
      [/INSERT INTO public\.recipients/i, 1],
      [/INSERT INTO public\.addresses/i, 1],
      [/UPDATE public\.shipments/i, 1],
    ],
  },
  {
    relativePath: 'fieldops/fieldops-pickup-execution.test.js',
    expected: [[/FROM domain_events/i, 1]],
  },
  {
    relativePath: 'workflows/ui-create-shipment.test.js',
    expected: [
      [/FROM workflow_runs/i, 1],
      [/FROM workflow_run_steps/i, 2],
    ],
  },
  {
    relativePath: 'workflows/zones-baskets-workflow.test.js',
    expected: [[/FROM manual_review_tasks/i, 1]],
  },
  {
    relativePath: 'mapping-studio-runtime-save.test.js',
    expected: [
      [/FROM public\.upsert_settings_value_v1/i, 1],
      [/FROM public\.tabular_import_runs/i, 1],
      [/FROM public\.mapping_operation_reports/i, 1],
      [/FROM public\.shipments/i, 3],
      [/FROM public\.recipients/i, 2],
      [/FROM public\.addresses/i, 2],
    ],
  },
  {
    relativePath: 'workflows/dispatch-stop-exceptions.test.js',
    expected: [
      [/(?:INSERT INTO|UPDATE) cron_config/i, 2],
      [/FROM domain_events/i, 5],
      [/(?:FROM|UPDATE) workflow_run_steps/i, 2],
      [/FROM workflow_runs/i, 1],
      [/FROM manual_review_tasks/i, 1],
      [/(?:FROM|UPDATE) shipments/i, 2],
      [/FROM decision_log/i, 1],
    ],
  },
  {
    relativePath: 'workflows/pickup-batch2.test.js',
    expected: [
      [/(?:INSERT INTO|UPDATE) cron_config/i, 2],
      [/FROM domain_events/i, 2],
      [/FROM shipments/i, 2],
      [/FROM pickup_requests/i, 1],
      [/FROM pickup_waves/i, 1],
      [/FROM pickup_failures/i, 1],
      [/FROM tasks/i, 1],
      [/INSERT INTO vehicles/i, 1],
      [/FROM route_runs/i, 1],
    ],
  },
];

function fixtureAdminSql(source) {
  return [...source.matchAll(/adminClient\.query\(\s*`([\s\S]*?)`/g)].map((match) => match[1]);
}

function listJavaScriptFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

describe('integration fixture role contract', () => {
  test.each(affectedSuites)('%s delegates role transitions to tenant-utils', (relativePath) => {
    const source = fs.readFileSync(path.join(integrationRoot, relativePath), 'utf8');

    expect(source).not.toMatch(/\bRESET\s+ROLE\b/i);
    expect(source).not.toMatch(/\bSET\s+LOCAL\s+ROLE\s+service_role\b/i);
  });

  test.each(fixtureAdminSqlSeams)(
    '$relativePath keeps protected fixture SQL inside canonical admin scopes',
    ({ relativePath, expected }) => {
      const source = fs.readFileSync(path.join(integrationRoot, relativePath), 'utf8');
      expect(source).toContain('withFixtureAdminContext');
      const scopedSql = fixtureAdminSql(source);

      for (const [pattern, minimum] of expected) {
        expect(scopedSql.filter((sql) => pattern.test(sql)).length).toBeGreaterThanOrEqual(minimum);
      }
    },
  );

  test('pickup batch delegates authenticated role transitions to tenant-utils', () => {
    const source = fs.readFileSync(path.join(integrationRoot, 'workflows/pickup-batch2.test.js'), 'utf8');
    expect(source).not.toMatch(/SET\s+LOCAL\s+ROLE\s+authenticated/i);
    expect(source).toContain('setAuthContext(client, userId, { organization_id: organizationId })');
  });

  test('canonical helper clears all JWT role state without widening grants', () => {
    const helperSource = fs.readFileSync(
      path.join(integrationRoot, 'helpers/tenant-utils.js'),
      'utf8',
    );
    const helperStart = helperSource.indexOf('async function setFixtureAdminContext');
    const helperEnd = helperSource.indexOf('async function setAuthContext', helperStart);
    const helperContract = helperSource.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(helperContract).toContain("client.query('SET LOCAL ROLE NONE')");
    expect(helperContract).toContain("'request.jwt.claims'");
    expect(helperContract).toContain("'request.jwt.claim.sub'");
    expect(helperContract).toContain("'request.jwt.claim.role'");
    expect(helperContract).toContain('isPoolQueryTarget(queryTarget)');
    expect(helperContract).toContain('await queryTarget.connect()');
    expect(helperContract).toContain("await client.query('BEGIN')");
    expect(helperContract).toContain('SAVEPOINT ${savepoint}');
    expect(helperContract).toContain("await client.query('COMMIT')");
    expect(helperContract).not.toMatch(/\bGRANT\b/i);
  });

  test('audits the complete shared tenant-utils consumer set and Pool call sites', () => {
    const consumers = listJavaScriptFiles(integrationRoot)
      .filter((filePath) => filePath !== path.join(integrationRoot, 'helpers/tenant-utils.js'))
      .filter((filePath) => /require\([^)]*tenant-utils[^)]*\)/.test(fs.readFileSync(filePath, 'utf8')))
      .map((filePath) => path.relative(integrationRoot, filePath).replaceAll('\\', '/'))
      .sort();

    expect(consumers.length).toBeGreaterThanOrEqual(50);
    const observedPoolConsumers = consumers.filter((relativePath) =>
      /\bapplySetting\(pool\s*,/.test(
        fs.readFileSync(path.join(integrationRoot, relativePath), 'utf8'),
      )
    );
    expect(observedPoolConsumers).toEqual(poolFixtureConsumers);
  });
});
