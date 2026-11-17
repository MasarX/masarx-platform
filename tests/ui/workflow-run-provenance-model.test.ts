import {
  extractWorkflowRunCorrelationId,
  extractWorkflowRunProvenance,
} from "../../packages/ui/src/workflow-run-provenance-model";

describe("workflow run provenance model", () => {
  it("extracts provenance fields (including run id)", () => {
    const run = {
      id: "run-1",
      triggered_by_request_id: "corr-1",
      context: {
        trigger_source: "schedule",
        requested_by: "user@example.com",
        request_context_id: "ctx-1",
        idempotency_key: "idem-1",
        scope_type: "client",
        scope_id: "client-1",
        workflow_schedule_trigger_id: "sched-1",
        workflow_run_trigger_id: "run-trigger-1",
        workflow_trigger_fire_id: "fire-1",
        source: {
          workflow_run_id: "source-run-1",
          workflow_status: "completed",
          completed_at: "2026-01-01T00:00:00Z",
        },
      },
    };

    expect(extractWorkflowRunCorrelationId(run)).toBe("corr-1");
    expect(extractWorkflowRunProvenance(run)).toEqual({
      workflowRunId: "run-1",
      correlationId: "corr-1",
      triggerSource: "schedule",
      requestedBy: "user@example.com",
      requestContextId: "ctx-1",
      idempotencyKey: "idem-1",
      scopeType: "client",
      scopeId: "client-1",
      workflowScheduleTriggerId: "sched-1",
      workflowRunTriggerId: "run-trigger-1",
      workflowTriggerFireId: "fire-1",
      sourceWorkflowRunId: "source-run-1",
      sourceWorkflowStatus: "completed",
      sourceCompletedAt: "2026-01-01T00:00:00Z",
      rawContext: {
        trigger_source: "schedule",
        requested_by: "user@example.com",
        request_context_id: "ctx-1",
        idempotency_key: "idem-1",
        scope_type: "client",
        scope_id: "client-1",
        workflow_schedule_trigger_id: "sched-1",
        workflow_run_trigger_id: "run-trigger-1",
        workflow_trigger_fire_id: "fire-1",
        source: {
          workflow_run_id: "source-run-1",
          workflow_status: "completed",
          completed_at: "2026-01-01T00:00:00Z",
        },
      },
    });
  });

  it("returns a stable shape when context is missing", () => {
    const run = {
      id: "run-2",
      metadata: { correlation_id: "corr-meta" },
    };

    expect(extractWorkflowRunCorrelationId(run)).toBe("corr-meta");
    expect(extractWorkflowRunProvenance(run)).toEqual({
      workflowRunId: "run-2",
      correlationId: "corr-meta",
      triggerSource: null,
      requestedBy: null,
      requestContextId: null,
      idempotencyKey: null,
      scopeType: null,
      scopeId: null,
      workflowScheduleTriggerId: null,
      workflowRunTriggerId: null,
      workflowTriggerFireId: null,
      sourceWorkflowRunId: null,
      sourceWorkflowStatus: null,
      sourceCompletedAt: null,
      rawContext: null,
    });
  });
});

