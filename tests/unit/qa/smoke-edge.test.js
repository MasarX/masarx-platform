const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('edge smoke local execution control', () => {
  test('native smoke failure classifier exposes only fixed response-shape classes', () => {
    const ts = require('typescript');
    for (const file of ['scripts/qa/smoke-edge.js']) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const matches = [];
      const visit = node => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === 'classifyApiCallerFailure') matches.push(node);
        ts.forEachChild(node, visit);
      };
      visit(ast);
      expect(matches).toHaveLength(1);
      const classify = new Function(matches[0].getText(ast) + '; return classifyApiCallerFailure;')();
      const secret = 'secret-token-should-never-escape';
      for (const [body, expected] of [
        [null, 'non_object_response'],
        [secret, 'non_object_response'],
        [{ error: 'Server missing EDGE_INTERNAL_CALLER_ROLES', token: secret }, 'missing_internal_caller_roles'],
        [{ status: 500, completed: false, body: null, error: secret }, 'caught_handler_exception'],
        [{ code: secret, message: secret }, 'runtime_code_response'],
        [{ error: secret }, 'unclassified_object_response'],
      ]) {
        expect(classify(body)).toBe(expected);
        expect(classify(body)).not.toContain(secret);
      }
    }
  });

  test('requires native JWT admission and an exact nonclaimable probe envelope', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/qa/smoke-edge.js'),
      'utf8',
    );
    expect(source).toContain('const probeJobId = crypto.randomUUID();');
    expect(source).toContain('api-caller expected nonclaimable envelope; response omitted');
    expect(source).not.toContain('JSON.stringify(apiCallerBody)');
    expect(source).not.toContain('body: apiCallerBody');
    expect(source).toContain("apiCallerBody?.result?.body?.reason !== 'job_not_claimable'");
    expect(source).toContain("assertStatus(forged.status, 401, 'api-caller forged JWT')");
    expect(source).toContain("assertHandlerReached(res, 'api-gateway')");
    expect(source).toContain("assertHandlerReached(res, 'webhook-receiver')");
    expect(source).not.toContain("job_id: '00000000-0000-0000-0000-000000000000'");
    expect(source).not.toContain('[200, 502, 500]');
    expect(source).not.toContain('422');
  });

  test('explicit local smoke opt-in survives an authoritative env-file overlay', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-edge-smoke-'));
    const envFile = path.join(tempDir, '.env.local');
    fs.writeFileSync(
      envFile,
      [
        'RUN_LOCAL_EDGE_TESTS=false',
        'SUPABASE_URL=http://127.0.0.1:1',
      ].join('\n'),
    );

    try {
      const result = spawnSync(
        process.execPath,
        [path.resolve(process.cwd(), 'scripts/qa/smoke-edge.js')],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            ENV_FILE: envFile,
            ENV_FILE_OVERRIDE: '1',
            RUN_LOCAL_EDGE_TESTS: 'true',
            EDGE_SMOKE_RETRIES: '1',
            EDGE_SMOKE_TIMEOUT_MS: '1000',
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('Skipping local edge smoke');
      expect(result.stderr).toContain('[load-env] Using explicit ENV_FILE=');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('required local smoke fails closed when it is not enabled', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-edge-smoke-required-'));
    const envFile = path.join(tempDir, '.env.local');
    fs.writeFileSync(
      envFile,
      [
        'RUN_LOCAL_EDGE_TESTS=false',
        'SUPABASE_URL=http://127.0.0.1:1',
      ].join('\n'),
    );

    try {
      const result = spawnSync(
        process.execPath,
        [path.resolve(process.cwd(), 'scripts/qa/smoke-edge.js')],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 10000,
          windowsHide: true,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            ENV_FILE: envFile,
            ENV_FILE_OVERRIDE: '1',
            RUN_LOCAL_EDGE_TESTS: 'false',
            EDGE_SMOKE_REQUIRED: '1',
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('Skipping local edge smoke');
      expect(result.stderr).toContain('Local edge smoke is required');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
