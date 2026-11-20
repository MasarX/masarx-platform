const assert = require('node:assert/strict');
const path = require('node:path');
const { assertCliShimBinding } = require('../../../scripts/ops/ci/install-unit-qualification-dependencies');
const { pinSelectedDsnForDownstream, safeHash } = require('../../../scripts/ops/db-connect-smoke');
const { quoteNodeOptionsValue } = require('../../../scripts/ops/mobile/run-fieldops-expo');
const { renderPriorityMatrix } = require('../../../scripts/ops/security-audit-inventory');
const { validateFieldopsExport } = require('../../../scripts/ops/vercel/fieldops-dev-hosting');

jest.mock('../../../scripts/utils/load-env', () => ({ loadEnv: jest.fn() }));

test('binds a legacy Windows shim and promptly rejects a long incomplete launcher', () => {
  const repoRoot = path.resolve('synthetic');
  const shimRelative = 'node_modules/.bin/jest.cmd';
  const shim = [
    'IF EXIST "%~dp0\\node.exe" (',
    '  "%~dp0\\node.exe"  "%~dp0\\..\\jest\\bin\\jest.js" %*',
    ') ELSE (',
    '  SETLOCAL',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    '  node "%~dp0\\..\\jest\\bin\\jest.js" %*',
    ')',
  ].join('\r\n');
  const bind = (content) => assertCliShimBinding({
    spec: { id: 'jest_cli' },
    repoRoot,
    shimRelative,
    shimPath: path.join(repoRoot, shimRelative),
    cliPath: path.join(repoRoot, 'node_modules/jest/bin/jest.js'),
    platform: 'win32',
    fsImpl: {
      lstatSync: () => ({ isFile: () => true, size: Buffer.byteLength(content) }),
      readFileSync: () => content,
    },
  });
  assert.doesNotThrow(() => bind(shim));
  const started = performance.now();
  assert.throws(() => bind('node\t\t--' + 'a'.repeat(5000)), /cli_shim_target_invalid/);
  assert.ok(performance.now() - started < 1000);
});

test('uses the same DB label after credential rotation in logs and GITHUB_ENV', () => {
  const first = 'postgresql://demo:example-one@db.example.test:5432/demo';
  const rotated = 'postgresql://demo:example-two@db.example.test:5432/demo';
  const label = safeHash(first);
  assert.match(label, /^[a-f0-9]{12}$/);
  assert.equal(safeHash(rotated), label);
  assert.equal(safeHash('postgresql://other@db.example.test:5432/demo?password=example-three'), label);
  assert.equal(safeHash('invalid connection string'), '');
  assert.notEqual(safeHash('postgresql://db.example.test:5432/other'), label);

  const appendFileSync = jest.fn();
  pinSelectedDsnForDownstream({ name: 'synthetic', dsn: rotated }, {
    env: { GITHUB_ENV: 'synthetic.env' },
    appendFileSync,
    logger: {},
  });
  assert.ok(appendFileSync.mock.calls[0][1].includes(`DB_SMOKE_SELECTED_DSN_HASH=${label}\n`));

  const env = jest.replaceProperty(process, 'env', { DATABASE_URL_DIRECT: first, DATABASE_URL: rotated });
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    jest.isolateModules(() => require('../../../scripts/ops/debug-db-env'));
    const labels = log.mock.calls.map(([line]) => line).filter((line) => line.startsWith('  hash:'));
    assert.equal(labels.length, 2);
    for (const line of labels) assert.equal(line, `  hash:       ${label}…`);
  } finally {
    log.mockRestore();
    env.restore();
  }
});

test('detects inline scripts across HTML script end-tag variants', () => {
  const exportDir = path.resolve('synthetic');
  const manifest = { display: 'standalone', start_url: './', scope: './',
    icons: [{ src: './icon-192.png' }, { src: './icon-512.png' }] };
  const validate = (script) => validateFieldopsExport(exportDir, {
    existsSync: () => true,
    lstatSync: () => ({ isFile: () => true }),
    statSync: () => ({ size: 1 }),
    readdirSync: () => [],
    readFileSync: (file) => path.basename(file) === 'manifest.json' ? JSON.stringify(manifest) : [
      '<link href="/fieldops/manifest.json">',
      '<link href="/fieldops/icon-192.png">',
      '<script src="/fieldops/register-sw.js"></script>',
      '<script src="/fieldops/_expo/static/main.js"></script>',
      script,
    ].join('\n'),
  });
  assert.doesNotThrow(() => validate('<script type="application/json">{}</script >'));
  for (const close of ['</script >', '</script x>', '</script\n bar>', '</script foo="bar">', '</SCRIPT\t>']) {
    assert.throws(() => validate('<script>0' + close), /inline executable scripts/);
  }
  assert.throws(
    () => validate('<script type="application/json">{}</script x><script>evil()</script>'),
    /inline executable scripts/,
  );
});

test('escapes Windows path separators inside a quoted NODE_OPTIONS value', () => {
  assert.equal(quoteNodeOptionsValue('Demo Folder\\preload.js'), '"Demo Folder\\\\preload.js"');
});

test('keeps advisory text with a backslash and pipe in one Markdown cell', () => {
  const matrix = renderPriorityMatrix({
    findings: [{ priority: 'P1', package_name: 'synthetic', recommended_action: 'Review A\\|B' }],
  });
  assert.ok(matrix.includes(' | Review A\\\\\\|B |'));
});
