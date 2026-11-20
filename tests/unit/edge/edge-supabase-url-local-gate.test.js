const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { resolveDockerDatabaseUrl } = require('../../../scripts/ops/workspace/docker-runtime-proof');

const hostedUrl = 'https://abcdefghijklmnopqrst.supabase.co';
const loopbackRequests = [
  'http://localhost:9999/functions/v1/x',
  'http://127.0.0.1:54321/functions/v1/x',
];
const dockerHost = new URL(resolveDockerDatabaseUrl({
  DATABASE_URL: 'postgresql://127.0.0.1:5432/postgres',
  MASARX_DOCKER_RUNTIME: '1',
})).hostname;
const dockerUrl = 'http://' + dockerHost + ':54321';

const unusedImports = new Set([
  './upload-limits.ts',
  './_vendor/exceljs.mjs',
  './preparation.ts',
  './studio-mapping-preview.mjs',
  './studio-test-submit.mjs',
  './studio-test-readback.mjs',
  './studio-response.mjs',
  '../api-caller/egress.mjs',
]);

function loadResolver(javascript, filename, env) {
  const edgeModule = { exports: {} };
  const environment = new Map(Object.entries(env));
  const readEnv = (primary, fallbacks = []) =>
    [primary, ...fallbacks].map((name) => environment.get(name)).find(Boolean) ?? '';

  vm.runInNewContext(javascript, {
    module: edgeModule,
    exports: edgeModule.exports,
    URL,
    Deno: { env: environment, serve: () => {} },
    require: (name) => {
      if (name === './_shared/mod.mjs') return { readEnv };
      if (name.startsWith('npm:') || unusedImports.has(name)) return {};
      throw new Error('Unexpected edge import: ' + name);
    },
  }, { filename });
  return edgeModule.exports;
}

test.each(['resource-import-studio', 'integration-plugin-studio'])(
  '%s: deployed Supabase URL never resolves to the request origin',
  (studio) => {
    const filename = path.resolve(__dirname, '../../../supabase/functions', studio, 'index.ts');
    const source = fs.readFileSync(filename, 'utf8');
    const javascript = ts.transpileModule(
      source + '\nmodule.exports = { resolveSupabaseUrl, LOCAL_EDGE_SUPABASE_HOSTS };',
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText;

    for (const env of [{ EDGE_SUPABASE_URL: hostedUrl }, { SUPABASE_URL: hostedUrl }]) {
      const { resolveSupabaseUrl } = loadResolver(javascript, filename, env);
      for (const url of loopbackRequests) {
        expect(resolveSupabaseUrl(new Request(url))).toBe(hostedUrl);
      }
    }

    const { resolveSupabaseUrl, LOCAL_EDGE_SUPABASE_HOSTS } = loadResolver(javascript, filename, {
      EDGE_SUPABASE_URL: dockerUrl,
    });
    expect(resolveSupabaseUrl(new Request('https://edge.example.test/x'))).toBe(dockerUrl);
    expect(resolveSupabaseUrl(new Request('http://127.0.0.1:54321/x'))).toBe('http://127.0.0.1:54321');
    expect([...LOCAL_EDGE_SUPABASE_HOSTS]).toEqual(['kong', dockerHost]);
  },
);
