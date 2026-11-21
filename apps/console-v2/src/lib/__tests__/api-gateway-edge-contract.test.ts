import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(process.cwd(), '../..');
const apiGatewaySource = readFileSync(path.join(repoRoot, 'supabase/functions/api-gateway/index.ts'), 'utf8').replace(/\r\n/g, '\n');
const apiCallerSource = readFileSync(path.join(repoRoot, 'supabase/functions/api-caller/index.ts'), 'utf8');
const webhookReceiverSource = readFileSync(path.join(repoRoot, 'supabase/functions/webhook-receiver/index.ts'), 'utf8');
const corsSource = readFileSync(path.join(repoRoot, 'supabase/functions/_shared/cors.mjs'), 'utf8').replace(/\r\n/g, '\n');
const edgeHelpers = readFileSync(path.join(repoRoot, 'supabase/functions/_shared/mod.mjs'), 'utf8');
const intakeTesterSource = readFileSync(path.join(repoRoot, 'apps/console-v2/src/lib/data-source.ts'), 'utf8');
const leaseMigration = readFileSync(
  path.join(repoRoot, 'supabase/migrations/202608161600_b3_api_caller_bounded_batch_v1.sql'),
  'utf8',
);
const callSpecResolver = leaseMigration
  .split('CREATE OR REPLACE FUNCTION public.get_claimed_edge_job_call_spec_v1(')[1]
  .split('CREATE OR REPLACE FUNCTION public.renew_claimed_edge_job_lease_v1(')[0];
const edgeRegistry = JSON.parse(readFileSync(path.join(repoRoot, 'config/edge/functions.json'), 'utf8')) as {
  functions: Array<{ name?: string; auth_mode?: string; enabled?: boolean }>;
};

describe('api-gateway edge browser contract', () => {
  it('prefers the canonical reachable Supabase URL for local API Gateway edge readback', () => {
    expect(apiGatewaySource).toContain('const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);');
    expect(apiCallerSource).toContain('const SUPABASE_URL = readEnv("EDGE_SUPABASE_URL", ["SUPABASE_URL", "API_URL"]);');
  });

  it('keeps browser-invoked API Gateway responses CORS-safe for Console V2 requests', () => {
    expect(apiGatewaySource).toContain('const API_GATEWAY_CORS_HEADERS = [');
    expect(apiGatewaySource).toContain('"apikey"');
    expect(apiGatewaySource).toContain('"x-client-info"');
    expect(apiGatewaySource).toContain('"x-webhook-token"');
    expect(apiGatewaySource).toContain('"idempotency-key"');
    expect(apiGatewaySource).toContain('"x-request-id"');

    const allowList = apiGatewaySource.match(/const API_GATEWAY_CORS_HEADERS = \[([\s\S]*?)\];/)?.[1] ?? '';
    const allowedHeaders = [...allowList.matchAll(/"([^"]+)"/g)].map(([, name]) => name);
    const testerRequest = intakeTesterSource.split('export async function runApiGatewayRequestTest(')[1]
      .split('const invokeName =')[0];
    const testerHeaders = [...testerRequest.matchAll(/headers\['([^']+)'\]\s*=/g)].map(([, name]) => name);
    const directFetch = intakeTesterSource.split('async function invokeApiGatewayEdge(')[1]
      .split('const text = await response.text()')[0];
    const directHeaderBlock = directFetch.match(/headers: \{\s*\.\.\.args\.headers,([\s\S]*?)\},/)?.[1] ?? '';
    const directHeaders = [...directHeaderBlock.matchAll(/^\s*(?:'([^']+)'|(\w+)):/gm)]
      .map(([, quoted, bare]) => quoted ?? bare);
    expect(testerHeaders).toEqual(expect.arrayContaining([
      'x-webhook-token', 'x-correlation-id', 'idempotency-key', 'x-masarx-replay-of',
    ]));
    expect(testerHeaders).not.toContain('x-idempotency-key');
    expect(directHeaders).toEqual(expect.arrayContaining([
      'apikey', 'authorization', 'content-type', 'x-client-info',
    ]));
    expect(allowedHeaders).toEqual(expect.arrayContaining([...testerHeaders, ...directHeaders]));
    expect(corsSource).toContain('headers["Access-Control-Allow-Origin"] = requestOrigin.origin;');
    expect(apiGatewaySource).toContain('const API_GATEWAY_CORS_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];');
    expect(apiGatewaySource).toContain('allowedHeaders: API_GATEWAY_CORS_HEADERS,');
    expect(corsSource).toContain('const DEFAULT_EXPOSED_HEADERS = [\n  "x-correlation-id",\n  "traceparent",\n  "tracestate",\n];');
    expect(apiGatewaySource).toContain('if (req.method === "OPTIONS")');
    expect(corsSource).toContain('headers["Access-Control-Max-Age"] = "86400";');
    expect(corsSource).toContain('headers["Access-Control-Expose-Headers"] = exposed.join(", ");');
  });

  it('keeps rejected ingress traceable through the request and tester correlation identifiers', () => {
    expect(apiGatewaySource).toContain('const requestId = req.headers.get("x-request-id")?.trim() || null;');
    expect(apiGatewaySource).toContain('const correlationId = resolveCorrelationId(req);');
    expect(apiGatewaySource).toContain('request_id: requestId,');
    expect(webhookReceiverSource).toContain('const requestId = req.headers.get("x-request-id")?.trim() || null;');
    expect(webhookReceiverSource).toContain('const correlationId = resolveCorrelationId(req);');
    expect(webhookReceiverSource).toContain('request_id: requestId,');
    expect(edgeHelpers).toContain('const fromCorrelationHeader = normalizeUuid(req?.headers?.get?.("x-correlation-id"));');
    expect(intakeTesterSource).toContain("'x-correlation-id': idempotencyKey,");
    expect(apiGatewaySource).toContain('p_headers: requestHeaders,');
    expect(webhookReceiverSource).toContain('p_headers: normalizedHeaders,');
  });

  it('dispatches accepted-async API Gateway jobs through waitUntil with a local-runtime fallback', () => {
    expect(apiGatewaySource).toContain('const runAcceptedAsyncDispatch = ({');
    expect(apiGatewaySource).toContain('if (workflowRunId && apiGatewayRequestId) {');
    expect(apiGatewaySource).toContain('const progressApiGatewayWorkflow = async ({');
    expect(apiGatewaySource).toContain('const resolveApiGatewayEdgeDispatchJobs = async (');
    expect(apiGatewaySource).toContain('const LOCAL_EDGE_RUNTIME =');
    expect(apiGatewaySource).toContain('const edgeRuntime = (globalThis as any).EdgeRuntime;');
    expect(apiGatewaySource).toContain('if (!LOCAL_EDGE_RUNTIME && edgeRuntime && typeof edgeRuntime.waitUntil === "function")');
    expect(apiGatewaySource).toContain('edgeRuntime.waitUntil(task);');
    expect(apiGatewaySource).toContain('return Promise.resolve();');
    expect(apiGatewaySource).toContain('return task;');
    expect(apiGatewaySource).toContain('if (action === "accepted_async") {');
    expect(apiGatewaySource).toContain('bodyRecord.workflow_run_id');
    expect(apiGatewaySource).toContain('bodyRecord.api_gateway_request_id');
    expect(apiGatewaySource).toContain('} else if (jobId) {');
    expect(apiGatewaySource).toContain('await runAcceptedAsyncDispatch({');
    expect(apiGatewaySource).toContain('} else if (jobId) {\n      await invokeApiCaller(\n        jobId,');
    expect(apiGatewaySource).toContain('/rest/v1/rpc/progress_api_gateway_request_workflow_v1');
    expect(apiGatewaySource).toContain('p_api_gateway_request_id: apiGatewayRequestId');
    expect(apiGatewaySource).toContain('p_input: {}');
    expect(apiGatewaySource).toContain('/rest/v1/rpc/get_api_gateway_edge_dispatch_jobs_v1');
    expect(apiGatewaySource).toContain('attempt <= 2');
    expect(apiGatewaySource).toContain('jobs = await resolveApiGatewayEdgeDispatchJobs(apiGatewayRequestId, authAttempts);');
    expect(apiGatewaySource).toContain('traceparent: apiCallerTraceparent');
    expect(apiGatewaySource).toContain('"edge.accepted_async.background_completed"');
    expect(apiGatewaySource).toContain('"edge.accepted_async.background_failed"');
    expect(apiGatewaySource).toContain('workflow_run_id: workflowRunId ?? null,');
    expect(apiGatewaySource).toContain('outbound_call_id: jobId ?? null,');
  });

  it('keeps the browser-invoked gateway registered without Supabase JWT enforcement', () => {
    const entry = edgeRegistry.functions.find((item) => item.name === 'api-gateway');

    expect(entry).toBeTruthy();
    expect(entry?.auth_mode).toBe('public_no_jwt');
    expect(entry?.enabled).toBe(true);
  });

  it('keeps browser-invoked webhook receiver responses CORS-safe for Console V2 tester requests', () => {
    expect(webhookReceiverSource).toContain('import { applyCorsHeaders, resolveCorsPolicy } from "./_shared/cors.mjs";');
    expect(webhookReceiverSource).toContain('const addStandardHeaders = (');
    expect(webhookReceiverSource).toContain('const corsHeaders = corsPolicy.headers;');
    expect(webhookReceiverSource).toContain('if (req.method === "OPTIONS")');
    expect(webhookReceiverSource).toContain('headers: addStandardHeaders({}, correlationId, trace, corsHeaders)');
    expect(webhookReceiverSource).toContain(
      'headers: addStandardHeaders({ "content-type": "application/json" }, correlationId, trace, corsHeaders)',
    );
  });

  it('keeps the browser-invoked webhook receiver registered without Supabase JWT enforcement', () => {
    const entry = edgeRegistry.functions.find((item) => item.name === 'webhook-receiver');

    expect(entry).toBeTruthy();
    expect(entry?.auth_mode).toBe('public_no_jwt');
    expect(entry?.enabled).toBe(true);
  });

  it('marks API caller spec-resolution failures as terminal outbound failures', () => {
    expect(apiCallerSource).toContain('await client.rpc("get_claimed_edge_job_call_spec_v1", {');
    expect(callSpecResolver).toContain("'reason', 'spec_resolution_failed'");
    expect(callSpecResolver).toContain("status = 'permanently_failed',");
    expect(callSpecResolver).toContain('AND oc.edge_lease_token = p_lease_token');
    expect(apiCallerSource).toContain('error: "job_spec_invalid",');
    expect(apiCallerSource).not.toContain('throw new Error(`Failed to resolve call spec for job ${jobId}:');
  });
});
