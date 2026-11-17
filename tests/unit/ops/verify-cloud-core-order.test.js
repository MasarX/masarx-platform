const fs = require('fs');
const path = require('path');

describe('verify-cloud-core', () => {
  test('keeps code checks without plan paperwork', () => {
    const file = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'verify-cloud-core.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).not.toMatch(/plan-lint|lint:plans|PLAN_LINT/);
    expect(body).toContain("label: 'lint:objectives'");
    expect(body).toContain("label: 'typecheck:fieldops'");
    expect(body).toContain("label: 'test:unit'");
    expect(body).toContain('...plannedCloudTestSteps');
  });

  test('runs db:push before validate:configs (fresh preview projects)', () => {
    const file = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'verify-cloud-core.js');
    const body = fs.readFileSync(file, 'utf8');

    const idxFixtureGuard = body.indexOf("label: 'guard:migration-fixtures'");
    const idxPush = body.indexOf("label: 'db:push'");
    const idxValidate = body.indexOf("label: 'validate:configs'");

    expect(idxFixtureGuard).toBeGreaterThan(-1);
    expect(idxPush).toBeGreaterThan(-1);
    expect(idxValidate).toBeGreaterThan(-1);
    expect(idxFixtureGuard).toBeLessThan(idxPush);
    expect(idxPush).toBeLessThan(idxValidate);
    expect(body).toContain("MIGRATION_FIXTURE_GUARD_MODE: 'full'");
  });

  test('deploys edge functions after db:push and before integration tests', () => {
    const file = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'verify-cloud-core.js');
    const body = fs.readFileSync(file, 'utf8');

    const idxPush = body.indexOf("label: 'db:push'");
    const idxDeploy = body.indexOf("label: 'edge:deploy'");
    const idxPlannedTests = body.indexOf('...plannedCloudTestSteps');

    expect(idxPush).toBeGreaterThan(-1);
    expect(idxDeploy).toBeGreaterThan(-1);
    expect(idxPlannedTests).toBeGreaterThan(-1);
    expect(idxPush).toBeLessThan(idxDeploy);
    expect(idxDeploy).toBeLessThan(idxPlannedTests);
  });

  test('plans integration execution through shared step planner', () => {
    const coreFile = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'verify-cloud-core.js');
    const plannerFile = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'verify-cloud-core-steps.js');
    const coreBody = fs.readFileSync(coreFile, 'utf8');
    const plannerBody = fs.readFileSync(plannerFile, 'utf8');

    expect(coreBody).toContain('planPgtapIntegrationSteps');
    expect(coreBody).toContain('const plannedCloudTestSteps = (() => {');
    expect(coreBody).toContain('...plannedCloudTestSteps');
    expect(coreBody).toContain("label: 'test:unit+integration'");
    expect(plannerBody).toContain("label: 'test:integration:cloud'");
    expect(plannerBody).toContain("run-integration-cloud.js");
  });

  test('skips edge smoke when edge deploy is skipped', () => {
    const file = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'verify-cloud-core.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toContain('const skipEdgeSmoke = skipEdgeDeploy || isTruthy(process.env.VERIFY_SKIP_EDGE_SMOKE);');
    expect(body).toContain("label: 'test:edge-smoke:cloud'");
    expect(body).toContain('Edge smoke skipped');
    expect(body).toContain('test:edge-smoke:cloud skipped');
    expect(body).toContain("'edge.log'");
  });

  test('runs db connectivity smoke before planned cloud test suites', () => {
    const file = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'verify-cloud-core.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toContain("type: 'db_smoke'");
    const idxDbSmoke = body.indexOf("label: 'db:connect:smoke'");
    const idxPlannedTests = body.indexOf('...plannedCloudTestSteps');
    const idxPinnedLog = body.indexOf('db:connect:smoke pinned DATABASE_URL');

    expect(idxDbSmoke).toBeGreaterThan(-1);
    expect(idxPlannedTests).toBeGreaterThan(-1);
    expect(idxPinnedLog).toBeGreaterThan(-1);
    expect(idxDbSmoke).toBeLessThan(idxPlannedTests);
    expect(body).toContain('env.DB_SMOKE_SELECTED_DSN_NAME = selectedCandidateName;');
    expect(body).toContain('process.env.DB_SMOKE_SELECTED_DSN_NAME = selectedCandidateName;');
    expect(body).toContain('env.DATABASE_URL_SELECTED_DSN_NAME = selectedCandidateName;');
  });

  test('bootstraps DB schema before configure:edge-api-caller (merge_group project-mode fallback)', () => {
    const coreFile = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'verify-cloud-core.js');
    const bootstrapFile = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'cloud-db-bootstrap.js');
    const coreBody = fs.readFileSync(coreFile, 'utf8');
    const bootstrapBody = fs.readFileSync(bootstrapFile, 'utf8');

    expect(coreBody).toContain("type: 'db_bootstrap'");
    expect(coreBody).toContain('ensureCloudDbBootstrap');
    expect(bootstrapBody).toContain("qualifiedName: 'public.scope_type_registry'");

    const idxBootstrap = coreBody.indexOf("label: 'db:bootstrap'");
    const idxConfigure = coreBody.indexOf("label: 'configure:edge-api-caller'");

    expect(idxBootstrap).toBeGreaterThan(-1);
    expect(idxConfigure).toBeGreaterThan(-1);
    expect(idxBootstrap).toBeLessThan(idxConfigure);
  });

  test('repairs shared DB secdef search_path drift after bootstrap and before downstream DB checks', () => {
    const file = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'verify-cloud-core.js');
    const body = fs.readFileSync(file, 'utf8');

    expect(body).toContain("label: 'db:secdef-search-path-repair'");
    expect(body).toContain("secdef-search-path-repair.js");

    const idxBootstrap = body.indexOf("label: 'db:bootstrap'");
    const idxRepair = body.indexOf("label: 'db:secdef-search-path-repair'");
    const idxStorage = body.indexOf("label: 'ensure:storage-buckets'");

    expect(idxBootstrap).toBeGreaterThan(-1);
    expect(idxRepair).toBeGreaterThan(-1);
    expect(idxStorage).toBeGreaterThan(-1);
    expect(idxBootstrap).toBeLessThan(idxRepair);
    expect(idxRepair).toBeLessThan(idxStorage);
  });
});
