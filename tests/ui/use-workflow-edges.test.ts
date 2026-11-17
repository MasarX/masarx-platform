/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { useWorkflowEdges } from "../../packages/ui/src/workflow-canvas/use-workflow-edges";

/* ---------------------------------------------------------------------------
 * Test fixtures.
 * -------------------------------------------------------------------------*/

function createStep(
  id: string,
  operationName: string,
  nextOperationName: string | null = null,
  conditionJsonlogic: Record<string, unknown> | null = null
): Record<string, unknown> {
  return {
    id,
    operation_name: operationName,
    next_operation_name: nextOperationName,
    condition_jsonlogic: conditionJsonlogic,
  };
}

/* ---------------------------------------------------------------------------
 * Tests.
 * -------------------------------------------------------------------------*/

test("creates edges from step routing", () => {
  const steps = [
    createStep("s1", "op_a", "op_b"),
    createStep("s2", "op_b", null),
  ];
  const { result } = renderHook(() =>
    useWorkflowEdges({ steps, idKey: "id" })
  );
  expect(result.current).toHaveLength(1);

  const edge = result.current[0]!;
  expect(edge.source).toBe("s1");
  expect(edge.target).toBe("s2");
  expect(edge.data?.routeStatus).toBe("target");
});

test("creates trigger-to-first-step edge", () => {
  const steps = [
    createStep("s1", "op_a", null),
    createStep("s2", "op_b", null),
  ];
  const { result } = renderHook(() =>
    useWorkflowEdges({ steps, idKey: "id", hasTriggers: true })
  );
  const triggerEdge = result.current.find((e) =>
    e.source === "__workflow_triggers__"
  );
  expect(triggerEdge).toBeDefined();
  expect(triggerEdge!.target).toBe("s1");
});

test("no trigger edge when hasTriggers is false", () => {
  const steps = [createStep("s1", "op_a", null)];
  const { result } = renderHook(() =>
    useWorkflowEdges({ steps, idKey: "id", hasTriggers: false })
  );
  expect(result.current.every((e) => e.source !== "__workflow_triggers__")).toBe(true);
});

test("handles missing routes (no edge)", () => {
  const steps = [
    createStep("s1", "op_a", "nonexistent_op"),
    createStep("s2", "op_b", null),
  ];
  const { result } = renderHook(() =>
    useWorkflowEdges({ steps, idKey: "id" })
  );
  // "missing" produces no edges.
  expect(result.current).toHaveLength(0);
});

test("handles self-loop routes", () => {
  const steps = [createStep("s1", "op_a", "op_a")];
  const { result } = renderHook(() =>
    useWorkflowEdges({ steps, idKey: "id" })
  );
  expect(result.current).toHaveLength(1);
  const edge = result.current[0]!;
  expect(edge.source).toBe("s1");
  expect(edge.target).toBe("s1");
  expect(edge.data?.routeStatus).toBe("self");
});

test("handles ambiguous routes (multiple edges)", () => {
  const steps = [
    createStep("s1", "op_a", "op_b"),
    createStep("s2", "op_b", null),
    createStep("s3", "op_b", null), // same operation name
  ];
  const { result } = renderHook(() =>
    useWorkflowEdges({ steps, idKey: "id" })
  );
  // Ambiguous: one edge per match.
  const ambiguousEdges = result.current.filter((e) =>
    e.data?.routeStatus === "ambiguous"
  );
  expect(ambiguousEdges).toHaveLength(2);
  expect(ambiguousEdges.map((e) => e.target).sort()).toEqual(["s2", "s3"]);
});

test("empty steps produces empty edges", () => {
  const { result } = renderHook(() =>
    useWorkflowEdges({ steps: [], idKey: "id" })
  );
  expect(result.current).toEqual([]);
});

test("conditional edges use conditionalEdge type", () => {
  const steps = [
    createStep("s1", "op_a", "op_b", { "==": [{ var: "status" }, "ok"] }),
    createStep("s2", "op_b", null),
  ];
  const { result } = renderHook(() =>
    useWorkflowEdges({ steps, idKey: "id" })
  );
  expect(result.current).toHaveLength(1);
  const edge = result.current[0]!;
  expect(edge.type).toBe("conditionalEdge");
  expect(edge.data?.conditionJsonlogic).toEqual({
    "==": [{ var: "status" }, "ok"],
  });
});

test("steps without next_operation_name produce no edges", () => {
  const steps = [
    createStep("s1", "op_a", null),
    createStep("s2", "op_b", null),
  ];
  const { result } = renderHook(() =>
    useWorkflowEdges({ steps, idKey: "id" })
  );
  expect(result.current).toHaveLength(0);
});

test("complex chain: s1 -> s2 -> s3", () => {
  const steps = [
    createStep("s1", "op_a", "op_b"),
    createStep("s2", "op_b", "op_c"),
    createStep("s3", "op_c", null),
  ];
  const { result } = renderHook(() =>
    useWorkflowEdges({ steps, idKey: "id" })
  );
  expect(result.current).toHaveLength(2);
  const sources = result.current.map((e) => e.source);
  expect(sources).toContain("s1");
  expect(sources).toContain("s2");
});
