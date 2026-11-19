import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(process.cwd(), '../..');
const apiGatewaySource = readFileSync(path.join(repoRoot, 'supabase/functions/api-gateway/index.ts'), 'utf8');
const apiCallerSource = readFileSync(path.join(repoRoot, 'supabase/functions/api-caller/index.ts'), 'utf8');
const webhookReceiverSource = readFileSync(path.join(repoRoot, 'supabase/functions/webhook-receiver/index.ts'), 'utf8');
const edgeRegistry = JSON.parse(readFileSync(path.join(repoRoot, 'config/edge/functions.json'), 'utf8')) as {
  functions: Array<{ name?: string; auth_mode?: string; enabled?: boolean }>;
};

describe('api-gateway edge browser contract', () => {
  it('prefers the canonical reachable Supabase URL for local API Gateway edge readback', () => {
    expect(apiGatewaySource).toContain('const SUPABASE_URL = readEnv("SUPABASE_URL", ["EDGE_SUPABASE_URL", "API_URL"]);');
    expect(apiCallerSource).toContain('const SUPABASE_URL = readEnv("SUPABASE_URL", ["EDGE_SUPABASE_URL", "API_URL"]);');
  });

  it('keeps browser-invoked API Gateway responses CORS-safe for Console V2 requests', () => {
    expect(apiGatewaySource).toContain('const CORS_ALLOW_HEADERS = [');
    expect(apiGatewaySource).toContain('"apikey"');
    expect(apiGatewaySource).toContain('"x-client-info"');
    expect(apiGatewaySource).toContain('"x-webhook-token"');
    expect(apiGatewaySource).toContain('"idempotency-key"');
    expect(apiGatewaySource).toContain('"x-idempotency-key"');
    expect(apiGatewaySource).toContain('out.set("access-control-allow-origin", "*")');
    expect(apiGatewaySource).toContain('out.set("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")');
    expect(apiGatewaySource).toContain('out.set("access-control-allow-headers", CORS_ALLOW_HEADERS)');
    expect(apiGatewaySource).toContain('out.set("access-control-expose-headers", "x-correlation-id,traceparent,tracestate")');
    expect(apiGatewaySource).toContain('if (req.method === "OPTIONS")');
    expect(apiGatewaySource).toContain('"access-control-max-age": "86400"');
  });

  it('records rejected-auth evidence with tester idempotency fallback request ids', () => {
    expect(apiGatewaySource).toContain('req.headers.get("x-request-id")?.trim() ||');
    expect(apiGatewaySource).toContain('req.headers.get("idempotency-key")?.trim() ||');
    expect(apiGatewaySource).toContain('req.headers.get("x-idempotency-key")?.trim() ||');
    expect(webhookReceiverSource).toContain('req.headers.get("x-request-id")?.trim() ||');
    expect(webhookReceiverSource).toContain('req.headers.get("idempotency-key")?.trim() ||');
    expect(webhookReceiverSource).toContain('req.headers.get("x-idempotency-key")?.trim() ||');
  });

  it('dispatches accepted-async API Gateway jobs through waitUntil with a local-runtime fallback', () => {
    expect(apiGatewaySource).toContain('const dispatchAcceptedAsyncJob = ({');
    expect(apiGatewaySource).toContain('const dispatchAcceptedAsyncWorkflow = ({');
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
    expect(apiGatewaySource).toContain('if (workflowRunId) {');
    expect(apiGatewaySource).toContain('await dispatchAcceptedAsyncWorkflow({');
    expect(apiGatewaySource).toContain('await dispatchAcceptedAsyncJob({');
    expect(apiGatewaySource).toContain('/rest/v1/rpc/progress_api_gateway_request_workflow_v1');
    expect(apiGatewaySource).toContain('p_api_gateway_request_id: apiGatewayRequestId');
    expect(apiGatewaySource).toContain('p_input: {}');
    expect(apiGatewaySource).toContain('/rest/v1/rpc/get_api_gateway_edge_dispatch_jobs_v1');
    expect(apiGatewaySource).toContain('attempt <= 2');
    expect(apiGatewaySource).toContain('"edge.workflow.dispatch_jobs_resolved"');
    expect(apiGatewaySource).toContain('traceparent: apiCallerTraceparent');
    expect(apiGatewaySource).toContain('"edge.dispatch.background_completed"');
    expect(apiGatewaySource).toContain('"edge.dispatch.background_failed"');
    expect(apiGatewaySource).toContain('"edge.workflow.background_completed"');
    expect(apiGatewaySource).toContain('"edge.workflow.background_failed"');
  });

  it('keeps the browser-invoked gateway registered without Supabase JWT enforcement', () => {
    const entry = edgeRegistry.functions.find((item) => item.name === 'api-gateway');

    expect(entry).toBeTruthy();
    expect(entry?.auth_mode).toBe('public_no_jwt');
    expect(entry?.enabled).toBe(true);
  });

  it('keeps browser-invoked webhook receiver responses CORS-safe for Console V2 tester requests', () => {
    expect(webhookReceiverSource).toContain('import { buildCorsHeaders } from "./_shared/cors.mjs";');
    expect(webhookReceiverSource).toContain('const addStandardHeaders = (');
    expect(webhookReceiverSource).toContain('const corsHeaders = buildCorsHeaders(req);');
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
    expect(apiCallerSource).toContain('const markCallSpecResolutionFailure = async (');
    expect(apiCallerSource).toContain('reason: "call_spec_resolution_failed"');
    expect(apiCallerSource).toContain('status: 424');
    expect(apiCallerSource).toContain('client.rpc("mark_outbound_call_failure"');
    expect(apiCallerSource).toContain('return await markCallSpecResolutionFailure(');
    expect(apiCallerSource).not.toContain('throw new Error(`Failed to resolve call spec for job ${jobId}:');
  });
});
