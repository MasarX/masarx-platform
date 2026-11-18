const fs = require('fs');
const path = require('path');

describe('webhook API-schema wrappers', () => {
  const migration = fs.readFileSync(
    path.join(
      process.cwd(),
      'supabase',
      'migrations',
      '202608161900_webhook_api_schema_wrappers_v1.sql',
    ),
    'utf8',
  );
  const edgeShared = fs.readFileSync(
    path.join(process.cwd(), 'supabase', 'functions', '_shared', 'mod.mjs'),
    'utf8',
  );
  const integration = fs.readFileSync(
    path.join(process.cwd(), 'tests', 'integration', 'webhook-replay-stress.test.js'),
    'utf8',
  );

  test('delegates both exposed RPCs to public SSOT as security invokers', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION api.workflow_intake_webhook(');
    expect(migration).toContain('SELECT public.workflow_intake_webhook(p_token, p_headers, p_raw_body, p_payload);');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION api.get_webhook_edge_dispatch_jobs(p_webhook_id UUID)');
    expect(migration).toContain('SELECT * FROM public.get_webhook_edge_dispatch_jobs(p_webhook_id);');
    expect(migration.match(/^SECURITY INVOKER$/gm)).toHaveLength(2);
    expect(migration.match(/SET search_path TO api, public, extensions, pg_temp/g)).toHaveLength(3);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\./);
  });

  test('keeps the public privilege boundary on the api wrappers', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION api.workflow_intake_webhook(TEXT, JSONB, TEXT, JSONB)\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION api.get_webhook_edge_dispatch_jobs(UUID)\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain('GRANT USAGE ON SCHEMA api TO edge_webhook_role, service_role;');
    expect(migration).toContain('TO edge_webhook_role, service_role;');
    expect(migration).not.toMatch(/\bTO\s+(?:anon|authenticated)\b/i);
  });

  test('binds the edge and governed integration path to the api profile', () => {
    expect(edgeShared).toContain('schema = "api"');
    expect(edgeShared).toContain('headers.set("accept-profile", rpcSchema)');
    expect(edgeShared).toContain('headers.set("content-profile", rpcSchema)');
    expect(integration).toContain("'Accept-Profile': 'api'");
    expect(integration).toContain("'Content-Profile': 'api'");
    expect(integration).toContain("postApiRpc('workflow_intake_webhook'");
    expect(integration).toContain("postApiRpc('get_webhook_edge_dispatch_jobs'");
    expect(integration).toContain("payload.role !== 'edge_webhook_role'");
    expect(integration).not.toContain('process.env.EDGE_SUPABASE_SECRET_KEY');
    expect(integration).not.toContain('process.env.SUPABASE_SERVICE_ROLE_KEY');
    expect(integration).toContain("const details = body.details && typeof body.details === 'object'");
    expect(integration).toContain('Number.isInteger(details.rpc_status)');
  });

  test('counts all raw-event inboxes independently of the canonical ACK binding', () => {
    const inboxSql = integration.match(/`SELECT id FROM public\.webhook_inbox([\s\S]*?)`/)[1];
    expect(inboxSql).toContain('webhook_source_id = $1');
    expect(inboxSql).toContain('organization_id = $3');
    expect(inboxSql).toContain("raw_payload #>> '{event,id}' = $2");
    expect(inboxSql).not.toMatch(/\bLIMIT\b|\bidempotency_key\b|\bid\s*=/i);
    expect(integration).toContain('expect(rows).toHaveLength(1)');
    expect(integration).toContain('[sourceId, idempotencyKey, basicContract.source.organization_id]');
    expect(integration).toContain('SELECT DISTINCT webhook_inbox_id FROM public.webhook_ack_history');
    expect(integration).toContain('expect(ackRows).toEqual([{ webhook_inbox_id: rows[0].id }])');
  });

  test('preserves every semantic ACK field and excludes only request correlation without mutating it', () => {
    const helper = integration.match(/function semanticAckBody\(body\) \{[\s\S]*?\n\}/)[0];
    const semanticAckBody = require('vm').runInNewContext(`(${helper})`);
    const first = { status: 'accepted', resource: { id: 'original' }, correlation_id: 'request-0' };
    const replay = { ...first, correlation_id: 'request-1' };
    expect(semanticAckBody(replay)).toEqual(semanticAckBody(first));
    expect(semanticAckBody({ ...replay, resource: { id: 'duplicate-insert' } }))
      .not.toEqual(semanticAckBody(first));
    expect(semanticAckBody({ ...replay, status: 'changed' })).not.toEqual(semanticAckBody(first));
    expect(first.correlation_id).toBe('request-0');
    expect(replay.correlation_id).toBe('request-1');
    expect(integration).toContain('expect(semanticAckBody(duplicate.body)).toEqual(semanticAckBody(first.body))');
  });

  test('requires one replay audit per successful duplicate alongside the first response and decisions', () => {
    expect(integration).toContain('Array.from({ length: 4 }');
    expect(integration).toContain("history.filter((row) => row.response_outcome === 'response_replayed')");
    expect(integration).toContain('.toHaveLength(duplicates.length)');
    expect(integration).toContain("expect(history[0].response_outcome).toBe('response_sent')");
    expect(integration).toContain("expect(decisionOutcomes).toContain('response_replayed')");
    expect(integration).toContain('attempt < 20');
    expect(integration).toContain('await sleep(100)');
    expect(integration).toContain('}, 60000)');
  });
});
