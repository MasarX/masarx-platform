const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../../..');
const sync = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'edge', 'sync-shared.js')], {
  cwd: repoRoot,
  stdio: 'ignore',
});
if (sync.status !== 0) {
  throw new Error('edge shared sync failed before webhook receiver malformed JSON tests');
}

describe('webhook receiver malformed JSON handling', () => {
  const functionPath = path.join(
    __dirname,
    '../../../supabase/functions/webhook-receiver/index.ts',
  );
  const sharedPath = path.join(
    __dirname,
    '../../../supabase/functions/webhook-receiver/_shared/mod.mjs',
  );
  const source = fs.readFileSync(functionPath, 'utf8');
  const sharedSource = fs.readFileSync(sharedPath, 'utf8');

  test('returns a controlled bad-request response for invalid JSON instead of top-level 500', () => {
    expect(sharedSource).toContain('throw new Error(`Invalid JSON payload: ${error.message}`);');
    expect(source).toContain('const parsedBody = await parseRequestBody(req);');
    expect(source).toContain('if (!message.startsWith("Invalid JSON payload")) throw error;');
    expect(source).toContain('jsonResponse(');
    expect(source).toContain('400,');
    expect(source).toContain('code: "invalid_json_payload"');
    expect(source).toContain('"edge.request.invalid_json"');
  });

  test('redacts request URL and forwarded secret headers in invalid JSON logs', () => {
    const marker = 'code: "invalid_json_payload"';
    const markerIndex = source.indexOf(marker);
    expect(markerIndex).toBeGreaterThan(-1);
    const invalidJsonBlock = source.slice(
      markerIndex,
      source.indexOf('if (!normalizedHeaders[', markerIndex),
    );
    expect(invalidJsonBlock).toContain('path: redactIngressSecretText(req.url)');
    expect(invalidJsonBlock).toContain('headers: redactIngressForwardedHeaders(normalizedHeaders)');
    expect(invalidJsonBlock).not.toContain('rawBody');
    expect(invalidJsonBlock).not.toContain('raw_body');
  });
});
