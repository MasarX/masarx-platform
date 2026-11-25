'use strict';
let checks = 0;
const rawAssert = require('node:assert/strict');
const assert = new Proxy(rawAssert, { get(target, key) { const value = target[key]; return typeof value === 'function' ? (...args) => { checks++; return value(...args); } : value; } });
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { evaluate, identity, parseList, resultDetails, relativeFile } = require('./jest.cjs');
const { bucketSections, migrationInventory, imagePreflight, completePins, mainSwitch } = require('./backend.cjs');
const { handleRequest, handleConnect } = require('./deny-egress.cjs');
const { exceptions, assess, objectsAt, outOfOrder, orderFloor } = require('./migrations.cjs');
const { targetBase, targetFile } = require('./target-policy.cjs');
const { guardPlan } = require('./base-guard.cjs');
const { changedPaths, select } = require('./changes.cjs');
const { workflowIgnore, installCommand, checkInstallPolicy, enforceWorkflowInventory } = require('./install-policy.cjs');
const { installCommandPatternSource } = require('./install-policy.cjs');
const { installCommandPatternFlags } = require('./install-policy.cjs');
const legacyShimModule = require.resolve('../ops/ci/install-unit-qualification-dependencies');
const { legacyCmdShimTargetPatternFlags, legacyCmdShimTargetPatternSource } = require(legacyShimModule);
const { generate } = require('./generate-migration-exceptions.cjs');
const { rewrite, policyDecision } = require('./docker-images.cjs');
const { sanitize, outputTail, failureDetails, environmentSecrets } = require('./diagnostics.cjs');
const { detect } = require('./tasks.cjs');
assert.equal(
  installCommandPatternSource,
  String.raw`\b(npm|pnpm|yarn)\s+(?:(?:--(?:prefix|workspace|dir|cwd|userconfig|globalconfig)\s+(?!(?:-g|--[\w=./-]+)\s)\S+|--[\w=./-]+|-g)\s+)*(?:ci|install|add|rebuild)\b`,
  'approved install command pattern changed',
);
assert.ok(installCommandPatternSource.includes(String.raw`(?!(?:-g|--[\w=./-]+)\s)\S+`));

assert.equal(installCommandPatternFlags, '', 'approved install command pattern flags changed');
assert.equal(
  fs.readFileSync(require.resolve('./install-policy.cjs'), 'utf8').split(installCommandPatternSource).length - 1,
  1,
  'expected exactly one install command pattern occurrence',
);
assert.equal(legacyCmdShimTargetPatternFlags, 'gim', 'approved legacy Windows shim target pattern flags changed');
assert.equal(
  fs.readFileSync(legacyShimModule, 'utf8').split(legacyCmdShimTargetPatternSource).length - 1,
  1,
  'expected exactly one legacy Windows shim target pattern occurrence',
);

const sensitive = ['synthetic credential with spaces', 'b'.repeat(48), 'MixedOpaqueValueWithDigits1234567890'];
const jwt = ['eyJ' + 'h'.repeat(20), 'p'.repeat(20), 's'.repeat(20)].join('.');
const key = 'sb_' + 'secret_' + 'synthetic';
const rawDiagnostic = `stack health failed password=synthetic-password token: 'synthetic token value' JWT=${jwt} API_KEY=${key} postgresql://user:synthetic-db-pass@127.0.0.1/db https://user:synthetic-http-pass@example.invalid/ ${sensitive.join(' ')} https://example.invalid/?signature=synthetic-signature`;
const cleanDiagnostic = sanitize(rawDiagnostic, [sensitive[0]]);
for (const secret of [...sensitive, jwt, key, 'synthetic-password', 'synthetic token value', 'synthetic-db-pass', 'synthetic-http-pass', 'synthetic-signature']) assert.equal(cleanDiagnostic.includes(secret), false);
assert.equal(cleanDiagnostic.includes('stack health failed'), true);
const jsonDiagnostic = sanitize('({"API_KEY":"synthetic-json-key"})');
assert.equal(sanitize(jsonDiagnostic), jsonDiagnostic);
assert.equal(jsonDiagnostic.endsWith('})'), true);
const cookieDiagnostic = sanitize('Cookie: sid=synthetic-cookie; session=synthetic-session');
assert.equal(cookieDiagnostic.includes('synthetic-cookie') || cookieDiagnostic.includes('synthetic-session'), false);

assert.equal(outputTail('safe\n'.repeat(200)).split('\n').length <= 80, true);
assert.equal(outputTail('x'.repeat(20000)).length, 16384);
assert.deepEqual(environmentSecrets({ TOKEN: 'synthetic-value', ORDINARY: 'visible' }), ['synthetic-value']);
const failure = failureDetails({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stderr: rawDiagnostic }, [sensitive[0]]);
assert.equal(failure.timeout, true); assert.equal(failure.signal, 'SIGTERM'); assert.equal(failure.exitCode, null);
assert.equal(failure.outputTail.includes(jwt), false);
assert.equal(policyDecision(new Error('CLI image pulls are forbidden; images must already be pulled by digest'), 'POST', '/images/create').operation, 'image-pull');
assert.equal(policyDecision(new Error('password=synthetic'), 'POST', '/containers/create').reason, 'Malformed Docker policy request');
assert.equal(policyDecision(null, 'GET', '/images/synthetic/json').decision, 'allowed');
for (const image of ['public.ecr.aws/synthetic/unreviewed:v1', `public.ecr.aws/synthetic/unreviewed:v1@sha256:${'a'.repeat(64)}`]) {
  for (const [method, url, body] of [['GET', `/v1.51/images/${encodeURIComponent(image)}/json`, Buffer.alloc(0)],
    ['POST', '/containers/create', Buffer.from(JSON.stringify({ Image: image }))]]) {
    assert.throws(() => rewrite(method, url, body, []), error => {
      assert.deepEqual(policyDecision(error, method, url), { decision: 'denied',
        operation: method === 'GET' ? 'image-inspect' : 'container-create', reason: 'Image is outside the reviewed digest set', image });
      return true;
    });
  }
}
const root = path.resolve(__dirname, '../..'); const now = new Date('2026-11-16T12:00:00Z');
const base = 'a'.repeat(40); const head = 'b'.repeat(40); const candidate = 'c'.repeat(40);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const file = 'tests/unit/synthetic.test.js'; const id = identity(file, 'synthetic case');
const report = status => ({ testResults: [{ name: path.join(root, file), status: status === 'failed' ? 'failed' : 'passed', assertionResults: [{ fullName: 'synthetic case', status }] }] });
assert.equal(evaluate(report('passed'), new Set(), 0, root).ok, true);
assert.equal(evaluate(report('failed'), new Set(), 1, root).ok, false);
assert.equal(evaluate(report('failed'), new Set([id]), 1, root).ok, true);
for (const status of ['passed', 'pending']) assert.equal(evaluate(report(status), new Set([id]), 0, root).ok, false);
assert.equal(evaluate(report('pending'), new Set(), 0, root).ok, false);
for (const expected of [new Set(), new Set([id])]) assert.equal(evaluate({ testResults: [] }, expected, 1, root).ok, false);
assert.equal(evaluate({ ...report('passed'), numRuntimeErrorTestSuites: 1 }, new Set(), 0, root).ok, false);
assert.equal(evaluate(report('failed'), new Set([id]), null, root).ok, false);
assert.equal(evaluate({ ...report('passed'), snapshot: { unchecked: 1 } }, new Set(), 0, root).ok, false);
assert.deepEqual(evaluate(report('passed'), new Set(), 1, root).reasons, ['EXIT_WITHOUT_FAILED_ASSERTIONS']);
const loadReport = { numRuntimeErrorTestSuites: 1, testResults: [{ name: path.join(root, file), status: 'failed', message: 'Cannot load module; password=synthetic-load-password', assertionResults: [] }] };
const loadVerdict = evaluate(loadReport, new Set(), 1, root);
assert.equal(loadVerdict.reasons.includes('RUNTIME_OR_SUITE_LOAD_ERROR'), true);
const loaded = resultDetails(loadReport, loadVerdict, { status: 1, stderr: 'load failed token=synthetic-load-token' }, root);
assert.equal(loaded.suites[0].file, file);
assert.equal(loaded.suites[0].suiteLoadError.includes('Cannot load module'), true);
assert.equal(JSON.stringify(loaded).includes('synthetic-load-password'), false);
assert.equal(JSON.stringify(loaded).includes('synthetic-load-token'), false);
const failedReport = report('failed'); failedReport.testResults[0].assertionResults[0].failureMessages = ['Expected value; API_KEY=synthetic-assertion-key'];
const failedDetails = resultDetails(failedReport, evaluate(failedReport, new Set(), 1, root), { status: 1 }, root);
assert.equal(failedDetails.suites[0].tests[0].fullName, 'synthetic case');
assert.equal(failedDetails.suites[0].tests[0].id, id);
assert.equal(failedDetails.suites[0].tests[0].failureMessages[0].includes('synthetic-assertion-key'), false);
const duplicateReport = report('passed'); duplicateReport.testResults.push(duplicateReport.testResults[0]);
assert.equal(evaluate(duplicateReport, new Set(), 0, root).reasons.includes('DUPLICATE_TEST_IDENTITIES'), true);
assert.equal(evaluate({ ...report('passed'), snapshot: { unchecked: 1 } }, new Set(), 0, root).reasons.includes('SNAPSHOT_FAILURE_OR_UNCHECKED'), true);
assert.equal(resultDetails(null, null, { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }, root).process.timeout, true);
assert.equal(relativeFile(path.resolve(root, '..', 'external.test.js'), root), '[external]/external.test.js');
assert.deepEqual(parseList(`# generated\nunit\t${id}\nui\t${id}\n`, 'unit'), new Set([id]));
assert.throws(() => parseList(`unit\t${id}\nunit\t${id}\n`, 'unit'));
assert.throws(() => parseList('unit\tmalformed\n', 'unit'));
assert.deepEqual(migrationInventory(['20260102_second.sql', 'note.txt', '20260101_first.sql']), ['20260101', '20260102']);
for (const names of [[], ['bad.sql'], ['20260101_first.sql', '20260101_duplicate.sql']]) assert.throws(() => migrationInventory(names));
const buckets = bucketSections('[api]\nenabled = true\n[storage.buckets.one]\npublic = false\n[auth]\nenabled = true\n');
assert.equal(buckets.includes('[api]') || buckets.includes('[auth]'), false);
assert.equal(buckets.includes('[storage.buckets.one]'), true);
for (const [url, expected] of [['/healthz', 200], ['http://external.invalid/healthz', 403]]) {
  let status; handleRequest({ url }, { writeHead: code => { status = code; }, end: () => {} }); assert.equal(status, expected);
}
let response; handleConnect({}, { end: text => { response = text; } }); assert.equal(response.startsWith('HTTP/1.1 403'), true);
const old = 'supabase/migrations/20260101000000_old.sql'; const newer = 'supabase/migrations/20260102000000_new.sql';
const earlier = 'supabase/migrations/20251231000000_early.sql'; const digest = hash('reviewed SQL');
const objects = new Map([old, newer, earlier].map(file => [file, { mode: '100644', digest }]));
assert.deepEqual(assess([old], [['A', newer]], new Map(), objects).failed, []);
for (const change of [['A', earlier], ['M', old], ['D', old], ['T', old]]) assert.equal(assess([old], [change], new Map(), objects).failed.length, 1);
const allowedText = `expires 2026-11-17\n20260101000000_old.sql ${digest}\n20251231000000_early.sql ${digest}\n`;
const allowed = exceptions(allowedText, now);
assert.deepEqual(assess([old], [['M', old], ['A', earlier]], allowed, objects).tolerated, [old, earlier]);
for (const mode of ['120000', '100755', '160000']) assert.equal(assess([old], [['A', newer]], allowed, new Map([[newer, { mode, digest }]])).failed.length, 1);
assert.equal(assess([old], [['M', old]], allowed, new Map([[old, { mode: '100644', digest: hash('changed later') }]])).failed.length, 1);
assert.equal(assess([old], [['M', old]], allowed, new Map([[old, { mode: '100644' }]])).failed.length, 1);
for (const status of ['D', 'T']) assert.equal(assess([old], [[status, old]], allowed, objects).failed.length, 1);
for (const text of ['1_a.sql '+digest, 'expires 2026-11-15', 'expires 2026-02-30', 'expires 2026-11-17\n*.sql '+digest,
  'expires 2026-11-17\n1_a.sql '+digest+'\n1_a.sql '+digest, 'expires 2026-11-17\nexpires 2026-11-18']) assert.throws(() => exceptions(text, now));
assert.equal(exceptions('', now).size, 0);
assert.equal(exceptions('# closed\n  # comment only\n', now).size, 0);
const mixed = ['supabase/migrations/202606011200_a.sql', 'supabase/migrations/20260115120000_b.sql'];
assert.equal(outOfOrder('20260116000000_new.sql', orderFloor(mixed)), true);
assert.equal(outOfOrder('20260701000000_new.sql', orderFloor(mixed)), false);
assert.equal(outOfOrder('202606011200_z.sql', orderFloor(mixed)), true);
const duplicate = 'supabase/migrations/20260102000000_duplicate.sql';
assert.equal(assess([old], [['A', newer], ['A', duplicate]], new Map(), new Map([...objects, [duplicate, { mode: '100644', digest }]])).failed.length, 1);
const raw = Buffer.from([0, 255, 10, 13]);
const metadata = `100644 blob ${head}\t${newer}\0`;
const batch = Buffer.concat([Buffer.from(`${head} blob ${raw.length}\n`), raw, Buffer.from('\n')]);
const parsed = objectsAt(candidate, [['A', newer]], args => args[0] === 'ls-tree' ? metadata : batch);
assert.equal(parsed.get(newer).digest, hash(raw));
assert.throws(() => objectsAt(candidate, [['A', newer]], args => args[0] === 'ls-tree' ? metadata : batch.subarray(0, -1)));
let calls = []; const fakeRead = args => { calls.push(args); return args[0] === 'rev-parse' ? `${base}\n` : ''; };
assert.equal(targetBase({ GITHUB_EVENT_NAME: 'pull_request' }, fakeRead), base); assert.deepEqual(calls, [['rev-parse', 'HEAD^1']]);
calls = []; assert.equal(targetBase({ GITHUB_EVENT_NAME: 'merge_group', GROUP_BASE: base }, fakeRead), base);
assert.deepEqual(calls, [['fetch', '--no-tags', '--depth=1', 'origin', base]]);
assert.throws(() => targetBase({ GITHUB_EVENT_NAME: 'merge_group', GROUP_BASE: 'untrusted' }, fakeRead));
const policyFile = 'config/ci/known-failures.main.txt';
assert.equal(targetFile(policyFile, base, args => args[0] === 'ls-tree' ? `${policyFile}\0` : 'trusted'), 'trusted');
assert.equal(targetFile(policyFile, base, () => ''), ''); assert.throws(() => targetFile('../outside', base, fakeRead));
const switchText = 'allow-unpinned-service-images-until=2026-11-17';
for (const [text, event, ref] of [['deny', 'workflow_dispatch', 'refs/heads/main'], ['', 'workflow_dispatch', 'refs/heads/main'],
  [switchText, 'pull_request', 'refs/heads/main'], [switchText, 'workflow_dispatch', 'refs/heads/v2'],
  ['allow-unpinned-service-images-until=2026-11-15', 'workflow_dispatch', 'refs/heads/main']]) assert.throws(() => imagePreflight(text, event, now, ref));
const savedLog = console.log; const warnings = [];
try { console.log = line => warnings.push(line); imagePreflight(switchText, 'workflow_dispatch', now, 'refs/heads/main'); }
finally { console.log = savedLog; }
assert.equal(warnings.length, 1);
calls = []; assert.equal(mainSwitch({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/v2' }, fakeRead), ''); assert.equal(calls.length, 0);
assert.equal(mainSwitch({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' }, fakeRead, (file, ref) => ref), base);
assert.equal(calls[0][4], '+refs/heads/main:refs/ci-policy/main');
const pins = JSON.parse(fs.readFileSync(path.join(root, 'config/ci/hosted-supabase-images.json'), 'utf8'));
assert.equal(completePins(pins), true); assert.equal(completePins(pins.slice(1)), false);
assert.equal(completePins(pins.slice(0, 4)), false);
assert.equal(completePins([...pins, pins[4]]), false);
assert.equal(imagePreflight('', 'pull_request', now, 'refs/pull/1/merge', pins).qualificationOnly, false);
const created = rewrite('POST', '/v1.51/containers/create', Buffer.from(JSON.stringify({ Image: 'public.ecr.aws/supabase/postgres:other-tag' })), pins);
assert.equal(JSON.parse(created.body).Image, `public.ecr.aws/${pins[0].image}@${pins[0].digest}`);
assert.equal(JSON.parse(rewrite('POST', '/containers/create', Buffer.from('{"Image":"public.ecr.aws/supabase/realtime:v2.129.3"}'), pins).body).Image,
  `public.ecr.aws/${pins[4].image}@${pins[4].digest}`);
assert.throws(() => rewrite('POST', '/v1.51/images/create?fromImage=anything', Buffer.alloc(0), pins));
assert.throws(() => rewrite('POST', '/v1.51/containers/create', Buffer.from('{"Image":"unreviewed/image:latest"}'), pins));
assert.equal(decodeURIComponent(rewrite('GET', '/v1.51/images/public.ecr.aws%2Fsupabase%2Fgotrue%3Av2/json', Buffer.alloc(0), pins).url).includes(pins[1].digest), true);
assert.equal(JSON.parse(rewrite('POST', '/containers/create', Buffer.from('{"Image":"public.ecr.aws/docker/library/kong:2.8.1"}'), pins).body).Image,
  `public.ecr.aws/${pins[3].image}@${pins[3].digest}`);
const baseReads = [];
const readBase = (args, encoding) => { baseReads.push(args); return args[0] === 'ls-tree' ? `100644 blob ${base}\tfile\0` : Buffer.from('reviewed base code'); };
for (const entry of ['migrations.cjs', 'jest.cjs', 'install-policy.cjs']) {
  const plan = guardPlan(entry, base, readBase);
  assert.deepEqual(plan.map(row => row.name), [entry, 'target-policy.cjs', ...(entry === 'jest.cjs' ? ['diagnostics.cjs'] : [])]);
  assert.equal(plan.every(row => row.content.toString() === 'reviewed base code'), true);
}
assert.equal(baseReads.every(args => args[0] === 'ls-tree' ? args[2] === base : args[1].startsWith(base + ':')), true);
assert.throws(() => guardPlan('candidate.js', base, readBase));
assert.throws(() => guardPlan('jest.cjs', 'HEAD', readBase));
assert.throws(() => guardPlan('jest.cjs', base, () => `120000 blob ${base}\tfile\0`));
const affected = files => Object.entries(select(files)).filter(([, enabled]) => enabled).map(([gate]) => gate);
for (const file of ['AGENTS.md', 'DELIVERY.md', 'DESIGN.md', 'CLAUDE.md', 'GEMINI.md', 'agents.md', 'SECURITY.md', 'README.md']) {
  assert.deepEqual(affected([file]), ['unit'], file);
}
for (const file of ['docs/guides/synthetic.md', 'docs/api/openapi.json']) {
  assert.deepEqual(affected([file]), ['unit']);
}
assert.deepEqual(affected(['supabase/migrations/synthetic.sql']), ['database', 'unit']);
for (const file of ['docs/marketing/landing-v2/index.html', 'scripts/frontend/serve-landing.js']) {
  assert.deepEqual(affected([file]), ['unit', 'build_landing', 'e2e']);
}
assert.deepEqual(affected(['tests/landing-e2e/synthetic.spec.ts']), ['unit', 'e2e']);
assert.deepEqual(affected(['playwright.landing.config.ts']), ['unit', 'e2e']);
assert.deepEqual(affected(['apps/console/app/page.tsx']), ['typecheck', 'unit', 'ui', 'build_console']);
assert.deepEqual(affected(['apps/portal/app/page.tsx']), ['typecheck', 'unit', 'ui', 'build_portal']);
assert.deepEqual(affected(['apps/landing/src/synthetic.ts']), ['typecheck', 'unit', 'ui', 'build_landing', 'e2e']);
assert.deepEqual(affected(['apps/fieldops/src/synthetic.ts']), ['typecheck', 'unit', 'ui', 'build_console', 'build_portal', 'build_landing']);
assert.deepEqual(affected(['tests/unit/synthetic.test.js', 'tests/ui/synthetic.test.tsx']), ['unit', 'ui']);
assert.deepEqual(affected(['tests/ui/synthetic.test.tsx']), ['unit', 'ui']);
for (const file of ['unknown/path.ts', 'unknown/path.md', 'synthetic.mdx', 'apps/shared/synthetic.ts',
  'apps/portal/package.json', 'packages/ui/src/synthetic.ts', 'packages/ui/bun.lockb',
  'docs/synthetic/manifest.yaml', '.github/workflows/public-ci.yml', 'scripts/ci-hosted/changes.cjs', 'config/synthetic.json']) {
  assert.deepEqual(select(['README.md', file]), select());
}
assert.equal(affected().length, 8);
const cdWorkflows = ['.github/workflows/deploy.yml', '.github/workflows/release-on-tag.yml'];
const cdTests = ['tests/unit/ops/dev-db-dry-run-workflow.test.js', 'tests/unit/ops/release-workflow.test.js'];
const cdChanges = [...cdWorkflows, ...cdTests];
assert.deepEqual(select(cdChanges, 'pull_request'), { ...select(), database: false });
assert.deepEqual(select(cdChanges, 'merge_group'), select());
assert.deepEqual(select(cdTests, 'pull_request'), select(['tests/unit/synthetic.test.js']));
for (const file of [
  '.github/workflows/public-ci.yml', '.github/workflows/verify-prebuilt.yml', 'CODEOWNERS',
  'scripts/ci-hosted/changes.cjs', 'supabase/migrations/synthetic.sql', 'package-lock.json',
  'tests/unit/ops/synthetic.test.js', 'docs/guides/synthetic.md', 'apps/console/app/page.tsx',
]) {
  assert.deepEqual(select([...cdChanges, file], 'pull_request'), select(), file);
  assert.equal(select([...cdTests, file], 'pull_request').database, true, file);
}
assert.deepEqual(affected([]), []);
assert.deepEqual(select([], 'merge_group'), select());
assert.deepEqual(changedPaths(base, (command, args) => {
  assert.equal(command, 'git');
  assert.deepEqual(args, ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD', '--']);
  return Buffer.from('apps/portal/app/old name.tsx\0docs/guides/new\nname.md\0');
}), ['apps/portal/app/old name.tsx', 'docs/guides/new\nname.md']);
assert.throws(() => changedPaths('HEAD'));
assert.throws(() => changedPaths(base, () => Buffer.from('truncated')), /Incomplete/);
assert.throws(() => changedPaths(base, () => Buffer.from([255, 0])));
const workflow = "name: synthetic\nenv:\n  NPM_CONFIG_IGNORE_SCRIPTS: 'true'\njobs: {}\n";
const workflowPath = '.github/workflows/synthetic.yml';
const publicWorkflow = ['.github/workflows/public-ci.yml', workflow];
assert.doesNotThrow(() => enforceWorkflowInventory(new Map([publicWorkflow])));
assert.doesNotThrow(() => enforceWorkflowInventory(new Map([publicWorkflow, [workflowPath, workflow]])));
assert.throws(() => enforceWorkflowInventory(new Map([[workflowPath, workflow]])), /missing/);
assert.throws(() => enforceWorkflowInventory(new Map([publicWorkflow, ['.github/workflows/nested/extra.yml', workflow]])), /directly/);
assert.equal(workflowIgnore(workflow), true);
assert.equal(workflowIgnore("jobs:\n  x:\n    env:\n      NPM_CONFIG_IGNORE_SCRIPTS: 'true'"), false);
for (const command of ['npm ci', 'npm install x', 'pnpm add x', 'yarn install', 'npm rebuild', 'pip install x']) assert.notEqual(installCommand(command), null);
for (const command of ['npm ci --ignore-scripts', 'npm install x --ignore-scripts=true', 'pnpm add x --ignore-scripts', 'yarn install --mode=skip-builds']) assert.equal(installCommand(command), null);
assert.equal(installCommand('npm ci', true), null);
assert.notEqual(installCommand('npm --prefix app ci'), null);
assert.equal(installCommand('npm --prefix app ci --ignore-scripts'), null);
for (const [command, inherited] of [
  ['npm --cwd - install', false],
  ['npm --prefix - ci', false],
  ['npm --prefix -x ci', false],
  ['npm --prefix --a$b ci', false],
  ['yarn --cwd -app install', true],
]) assert.equal(installCommand(command, inherited), 'install lacks script disabling');
assert.equal(installCommand('npm ci --prefix tooling/apps/deploy --ignore-scripts --no-audit --no-fund'), null);
const repeatedInstallFlags = 'npm --cwd -g ' + '--cwd app '.repeat(5000) + 'run';
const installPolicyStarted = performance.now();
assert.equal(installCommand(repeatedInstallFlags), null);
assert.ok(performance.now() - installPolicyStarted < 1000);
for (const command of ['npm ci --ignore-scripts=false', 'NPM_CONFIG_IGNORE_SCRIPTS=false npm ci', 'npm_config_ignore_scripts=0 npm ci']) assert.notEqual(installCommand(command, true), null);
assert.equal(checkInstallPolicy(new Map([[workflowPath, workflow]])).length, 0);
assert.notEqual(checkInstallPolicy(new Map([[workflowPath, 'name: missing setting']])).length, 0);
assert.notEqual(checkInstallPolicy(new Map([[workflowPath, workflow + "  x:\n    env:\n      npm_config_ignore_" + "scripts: 'false'\n"]])).length, 0);
assert.notEqual(checkInstallPolicy(new Map([[workflowPath, workflow + '  x:\n    env:\n      NPM_CONFIG_IGNORE_SCRIPTS: ${{ false }}\n']])).length, 0);
// Build source fixtures from data so the static scanner does not mistake tests for install calls.
const npmCall = args => 'run' + '(' + JSON.stringify('npm') + ', ' + JSON.stringify(args) + ');';
const helperPath = 'scripts/ci-hosted/synthetic.cjs';
assert.equal(checkInstallPolicy(new Map([[workflowPath, workflow], [helperPath, npmCall(['ci'])]])).length, 0);
assert.notEqual(checkInstallPolicy(new Map([[workflowPath, workflow], [helperPath, npmCall(['ci', '--ignore-scripts=false'])]])).length, 0);
assert.notEqual(checkInstallPolicy(new Map([[helperPath, npmCall(['ci'])]])).length, 0);
assert.equal(checkInstallPolicy(new Map([[helperPath, npmCall(['ci', '--ignore-scripts'])]])).length, 0);
const pythonCall = args => 'subprocess.' + 'run' + '(' + JSON.stringify(['npm', ...args]) + ')';
assert.notEqual(checkInstallPolicy(new Map([['scripts/ci-hosted/synthetic.py', pythonCall(['ci'])]])).length, 0);
assert.equal(checkInstallPolicy(new Map([['scripts/ci-hosted/synthetic.py', pythonCall(['ci', '--ignore-scripts'])]])).length, 0);
const genMain = new Map([['20260101000000_old.sql', digest]]);
const genV2 = new Map([...genMain, ['20251231000000_early.sql', hash('early')], ['20260102000000_new.sql', hash('late')]]);
assert.equal(generate(genMain, genV2, '2026-11-17', now).includes('20251231000000_early.sql '+hash('early')), true);
assert.equal(generate(genMain, genV2, '2026-11-17', now).includes('20260102000000_new.sql'), false);
genV2.set('20260101000000_old.sql', hash('updated'));
assert.equal(generate(genMain, genV2, '2026-11-17', now).includes('20260101000000_old.sql '+hash('updated')), true);
assert.throws(() => generate(genMain, new Map(), '2026-11-17', now)); assert.throws(() => generate(genMain, genV2, '2026-11-15', now));
const savedExists = fs.existsSync; const savedOutput = process.env.GITHUB_OUTPUT; const detection = [];
try { delete process.env.GITHUB_OUTPUT; fs.existsSync = file => file.split(path.sep).join('/').endsWith('scripts/frontend/build-landing.js'); console.log = line => detection.push(line); detect('landing'); }
finally { fs.existsSync = savedExists; console.log = savedLog; if (savedOutput === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = savedOutput; }
assert.deepEqual(detection, ['landing: present']);
const emptyRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hosted-result-selfcheck-'));
try {
  const run = require('node:child_process').spawnSync(process.execPath, [path.join(root, 'scripts/ci-hosted/jest.cjs'), 'unit'], {
    cwd: emptyRoot, encoding: 'utf8', timeout: 10000, env: { ...process.env, JEST_SHARD: '', JEST_DIAGNOSTIC_PROPOSAL: '' },
  });
  assert.equal(run.status, 1);
  const diagnostic = JSON.parse(fs.readFileSync(path.join(emptyRoot, 'ci-reports/jest-results.unit.json'), 'utf8'));
  assert.equal(diagnostic.stage, 'configuration');
  assert.equal(diagnostic.ok, false);
  assert.equal(diagnostic.error.includes('Missing config/'), true);
  assert.deepEqual(diagnostic.reasons, ['JEST_INFRASTRUCTURE_OR_CONFIGURATION_FAILURE']);
} finally {
  assert.equal(path.dirname(emptyRoot), require('node:os').tmpdir());
  fs.rmSync(emptyRoot, { recursive: true, force: true });
}
console.log(`PASS: ${checks} synthetic helper assertions; no Git, Docker, browser, listener or product suite executed`);
