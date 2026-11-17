/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { useWorkflowNodes } from "../../packages/ui/src/workflow-canvas/use-workflow-nodes";

/* ---------------------------------------------------------------------------
 * Test fixtures.
 * -------------------------------------------------------------------------*/

const STEPS: Record<string, unknown>[] = [
  {
    id: "step-1",
    operation_name: "validate_input",
    handler_key: "handler_v1",
    enabled: true,
    manual_action_required: false,
    transition_condition: "always",
    next_operation_name: "transform_data",
    next_operation_priority: 10,
    next_operation_delay_seconds: 5,
    condition_jsonlogic: { "==": [{ var: "status" }, "ok"] },
    metadata: { key: "value" },
  },
  {
    id: "step-2",
    operation_name: "transform_data",
    handler_key: null,
    enabled: false,
    manual_action_required: true,
    transition_condition: null,
    next_operation_name: null,
  },
];

const TRIGGERS: Record<string, unknown>[] = [
  {
    webhook_source_id: "ws-1",
    source_identifier: "webhook-a",
    name: "My Webhook",
    provider_type: "generic",
    enabled: true,
  },
];

/* ---------------------------------------------------------------------------
 * Tests.
 * -------------------------------------------------------------------------*/

test("converts steps to React Flow nodes", () => {
  const { result } = renderHook(() =>
    useWorkflowNodes({ steps: STEPS, idKey: "id" })
  );
  const nodes = result.current;
  expect(nodes).toHaveLength(2);

  const first = nodes[0]!;
  expect(first.id).toBe("step-1");
  expect(first.type).toBe("workflowStep");
  expect(first.data.operationName).toBe("validate_input");
  expect(first.data.handlerKey).toBe("handler_v1");
  expect(first.data.enabled).toBe(true);
  expect(first.data.nextOperationName).toBe("transform_data");
  expect(first.data.nextOperationPriority).toBe(10);
  expect(first.data.nextOperationDelaySeconds).toBe(5);
  expect(first.data.conditionJsonlogic).toEqual({ "==": [{ var: "status" }, "ok"] });
  expect(first.data.metadata).toEqual({ key: "value" });

  const second = nodes[1]!;
  expect(second.id).toBe("step-2");
  expect(second.data.operationName).toBe("transform_data");
  expect(second.data.enabled).toBe(false);
  expect(second.data.manualActionRequired).toBe(true);
  expect(second.data.nextOperationName).toBeNull();
});

test("adds trigger node when triggers are provided", () => {
  const { result } = renderHook(() =>
    useWorkflowNodes({
      steps: STEPS,
      idKey: "id",
      triggers: TRIGGERS,
    })
  );
  const nodes = result.current;
  expect(nodes).toHaveLength(3);

  const trigger = nodes[0]!;
  expect(trigger.id).toBe("__workflow_triggers__");
  expect(trigger.type).toBe("workflowTrigger");
  expect(trigger.data.label).toBe("1 trigger");
  expect(trigger.draggable).toBe(false);
});

test("no trigger node when triggers is null", () => {
  const { result } = renderHook(() =>
    useWorkflowNodes({ steps: STEPS, idKey: "id", triggers: null })
  );
  expect(result.current.every((n) => n.type !== "workflowTrigger")).toBe(true);
});

test("no trigger node when triggers is empty", () => {
  const { result } = renderHook(() =>
    useWorkflowNodes({ steps: STEPS, idKey: "id", triggers: [] })
  );
  expect(result.current.every((n) => n.type !== "workflowTrigger")).toBe(true);
});

test("empty steps produces empty nodes", () => {
  const { result } = renderHook(() =>
    useWorkflowNodes({ steps: [], idKey: "id" })
  );
  expect(result.current).toEqual([]);
});

test("steps without id are skipped", () => {
  const { result } = renderHook(() =>
    useWorkflowNodes({
      steps: [{ operation_name: "orphan" }],
      idKey: "id",
    })
  );
  expect(result.current).toEqual([]);
});

test("nodes have incrementing x positions", () => {
  const { result } = renderHook(() =>
    useWorkflowNodes({ steps: STEPS, idKey: "id" })
  );
  const xValues = result.current.map((n) => n.position.x);
  expect(xValues[0]!).toBeLessThan(xValues[1]!);
});

test("run step map populates runStatus and runDurationMs", () => {
  const runStepMap = new Map<string, Record<string, unknown>>();
  runStepMap.set("step-1", { status: "completed", duration_ms: 1234 });
  runStepMap.set("step-2", { status: "failed", duration_ms: 567 });

  const { result } = renderHook(() =>
    useWorkflowNodes({
      steps: STEPS,
      idKey: "id",
      runStepMap,
    })
  );

  expect(result.current[0]!.data.runStatus).toBe("completed");
  expect(result.current[0]!.data.runDurationMs).toBe(1234);
  expect(result.current[1]!.data.runStatus).toBe("failed");
  expect(result.current[1]!.data.runDurationMs).toBe(567);
});

test("plural trigger label for multiple triggers", () => {
  const triggers = [...TRIGGERS, { ...TRIGGERS[0]!, webhook_source_id: "ws-2" }];
  const { result } = renderHook(() =>
    useWorkflowNodes({
      steps: STEPS,
      idKey: "id",
      triggers,
    })
  );
  const trigger = result.current.find((n) => n.type === "workflowTrigger");
  expect(trigger?.data.label).toBe("2 triggers");
});
