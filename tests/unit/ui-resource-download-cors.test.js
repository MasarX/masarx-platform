const fs = require('fs');
const path = require('path');
describe('ui-resource-download browser contract', () => {
  test('function source handles preflight and emits CORS response headers', () => {
    const helperPath = path.join(
      process.cwd(),
      'supabase/functions/_shared/cors.mjs',
    );
    const functionPath = path.join(
      process.cwd(),
      'supabase/functions/ui-resource-download/index.ts',
    );
    const helperSource = fs.readFileSync(helperPath, 'utf8');
    const functionSource = fs.readFileSync(functionPath, 'utf8');

    expect(helperSource).toContain('"Access-Control-Allow-Origin"');
    expect(helperSource).toContain('"Access-Control-Allow-Headers"');
    expect(helperSource).toContain('"Access-Control-Allow-Methods"');
    expect(helperSource).toContain('"access-control-request-headers"');
    expect(functionSource).toContain('req.method === "OPTIONS"');
    expect(functionSource).toContain('new Response(null, { status: 204, headers: corsHeaders })');
    expect(functionSource).toContain('from "../_shared/cors.mjs"');
    expect(functionSource).toContain('withCorsJson(');
    expect(functionSource).toContain('db: { schema: "api" }');
  });

  test('edge registry deploys ui-resource-download with public_no_jwt', () => {
    const registryPath = path.join(process.cwd(), 'config/edge/functions.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const entry = registry.functions.find((item) => item.name === 'ui-resource-download');

    expect(entry).toBeTruthy();
    expect(entry.auth_mode).toBe('public_no_jwt');
    expect(entry.enabled).toBe(true);
  });
});
