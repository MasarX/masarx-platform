import {
  useWorkflowCanvasStore,
  createLegacyHistoryStack,
} from "../../packages/ui/src/workflow-canvas/workflow-canvas-store";
import type {
  WorkflowStepNode,
  WorkflowEdge,
} from "../../packages/ui/src/workflow-canvas/workflow-canvas-types";

/* ---------------------------------------------------------------------------
 * Test fixtures.
 * -------------------------------------------------------------------------*/

function createStepNode(id: string, operationName: string): WorkflowStepNode {
  return {
    id,
    type: "workflowStep",
    position: { x: 0, y: 0 },
    data: {
      stepId: id,
      operationName,
      handlerKey: null,
      enabled: true,
      manualActionRequired: false,
      transitionCondition: null,
      nextOperationName: null,
      nextOperationPriority: null,
      nextOperationDelaySeconds: null,
      conditionJsonlogic: null,
      metadata: null,
      runStatus: null,
      runDurationMs: null,
      stepIndex: 0,
    },
  };
}

function createEdge(sourceId: string, targetId: string): WorkflowEdge {
  return {
    id: `edge-${sourceId}-${targetId}`,
    source: sourceId,
    target: targetId,
    data: {
      sourceStepId: sourceId,
      targetStepId: targetId,
      conditionJsonlogic: null,
      routeStatus: "target",
    },
  };
}

/* ---------------------------------------------------------------------------
 * Store tests.
 * -------------------------------------------------------------------------*/

beforeEach(() => {
  useWorkflowCanvasStore.getState().reset();
});

test("initial state has empty nodes and edges", () => {
  const state = useWorkflowCanvasStore.getState();
  expect(state.nodes).toEqual([]);
  expect(state.edges).toEqual([]);
  expect(state.selectedNodeId).toBeNull();
  expect(state.editorOpen).toBe(false);
  expect(state.saving).toBe(false);
  expect(state.runPreviewId).toBeNull();
});

test("setNodes updates node list", () => {
  const nodes = [createStepNode("s1", "op_a"), createStepNode("s2", "op_b")];
  useWorkflowCanvasStore.getState().setNodes(nodes);
  expect(useWorkflowCanvasStore.getState().nodes).toEqual(nodes);
});

test("setEdges updates edge list", () => {
  const edges = [createEdge("s1", "s2")];
  useWorkflowCanvasStore.getState().setEdges(edges);
  expect(useWorkflowCanvasStore.getState().edges).toEqual(edges);
});

test("selectNode opens the editor", () => {
  useWorkflowCanvasStore.getState().selectNode("s1");
  const state = useWorkflowCanvasStore.getState();
  expect(state.selectedNodeId).toBe("s1");
  expect(state.editorStepId).toBe("s1");
  expect(state.editorOpen).toBe(true);
});

test("selectNode(null) deselects and does not open the editor", () => {
  useWorkflowCanvasStore.getState().selectNode("s1");
  useWorkflowCanvasStore.getState().selectNode(null);
  const state = useWorkflowCanvasStore.getState();
  expect(state.selectedNodeId).toBeNull();
  expect(state.editorStepId).toBeNull();
  expect(state.editorOpen).toBe(false);
});

test("openEditor sets editor state", () => {
  useWorkflowCanvasStore.getState().openEditor("s1");
  const state = useWorkflowCanvasStore.getState();
  expect(state.editorStepId).toBe("s1");
  expect(state.editorOpen).toBe(true);
  expect(state.selectedNodeId).toBe("s1");
});

test("closeEditor hides the editor", () => {
  useWorkflowCanvasStore.getState().openEditor("s1");
  useWorkflowCanvasStore.getState().closeEditor();
  const state = useWorkflowCanvasStore.getState();
  expect(state.editorOpen).toBe(false);
});

test("setSaving updates saving state", () => {
  useWorkflowCanvasStore.getState().setSaving(true);
  expect(useWorkflowCanvasStore.getState().saving).toBe(true);
  useWorkflowCanvasStore.getState().setSaving(false);
  expect(useWorkflowCanvasStore.getState().saving).toBe(false);
});

test("setRunPreview activates run preview mode", () => {
  useWorkflowCanvasStore.getState().setRunPreview("run-1");
  const state = useWorkflowCanvasStore.getState();
  expect(state.runPreviewId).toBe("run-1");
  expect(state.runPreviewActive).toBe(true);
});

test("setRunPreview(null) deactivates run preview mode", () => {
  useWorkflowCanvasStore.getState().setRunPreview("run-1");
  useWorkflowCanvasStore.getState().setRunPreview(null);
  const state = useWorkflowCanvasStore.getState();
  expect(state.runPreviewId).toBeNull();
  expect(state.runPreviewActive).toBe(false);
});

test("reset returns to initial state", () => {
  useWorkflowCanvasStore
    .getState()
    .setNodes([createStepNode("s1", "op_a")]);
  useWorkflowCanvasStore.getState().selectNode("s1");
  useWorkflowCanvasStore.getState().setSaving(true);
  useWorkflowCanvasStore.getState().setRunPreview("run-1");
  useWorkflowCanvasStore.getState().reset();
  const state = useWorkflowCanvasStore.getState();
  expect(state.nodes).toEqual([]);
  expect(state.edges).toEqual([]);
  expect(state.selectedNodeId).toBeNull();
  expect(state.editorOpen).toBe(false);
  expect(state.saving).toBe(false);
  expect(state.runPreviewId).toBeNull();
});

test("hoverNode updates hoveredNodeId", () => {
  useWorkflowCanvasStore.getState().hoverNode("s1");
  expect(useWorkflowCanvasStore.getState().hoveredNodeId).toBe("s1");
  useWorkflowCanvasStore.getState().hoverNode(null);
  expect(useWorkflowCanvasStore.getState().hoveredNodeId).toBeNull();
});

/* ---------------------------------------------------------------------------
 * Legacy history stack tests.
 * -------------------------------------------------------------------------*/

test("createLegacyHistoryStack push and undo", () => {
  const stack = createLegacyHistoryStack();
  stack.push({ kind: "order", before: ["a", "b"], after: ["b", "a"] });
  expect(stack.canUndo()).toBe(true);
  expect(stack.canRedo()).toBe(false);

  const entry = stack.undo();
  expect(entry).toEqual({ kind: "order", before: ["a", "b"], after: ["b", "a"] });
  expect(stack.canUndo()).toBe(false);
  expect(stack.canRedo()).toBe(true);
});

test("createLegacyHistoryStack undo and redo", () => {
  const stack = createLegacyHistoryStack();
  stack.push({ kind: "order", before: ["a", "b"], after: ["b", "a"] });
  stack.undo();

  const entry = stack.redo();
  expect(entry).toEqual({ kind: "order", before: ["a", "b"], after: ["b", "a"] });
  expect(stack.canUndo()).toBe(true);
  expect(stack.canRedo()).toBe(false);
});

test("createLegacyHistoryStack push clears redo", () => {
  const stack = createLegacyHistoryStack();
  stack.push({ kind: "order", before: ["a"], after: ["b"] });
  stack.undo();
  expect(stack.canRedo()).toBe(true);

  stack.push({ kind: "order", before: ["a"], after: ["c"] });
  expect(stack.canRedo()).toBe(false);
});

test("createLegacyHistoryStack clear empties both stacks", () => {
  const stack = createLegacyHistoryStack();
  stack.push({ kind: "order", before: ["a"], after: ["b"] });
  stack.undo();
  stack.clear();
  expect(stack.canUndo()).toBe(false);
  expect(stack.canRedo()).toBe(false);
});

test("createLegacyHistoryStack handles patch entries", () => {
  const stack = createLegacyHistoryStack();
  stack.push({
    kind: "patch",
    stepId: "s1",
    before: { next_operation_name: null },
    after: { next_operation_name: "op_b" },
  });
  expect(stack.canUndo()).toBe(true);
  const entry = stack.undo();
  expect(entry?.kind).toBe("patch");
  if (entry?.kind === "patch") {
    expect(entry.stepId).toBe("s1");
    expect(entry.before).toEqual({ next_operation_name: null });
    expect(entry.after).toEqual({ next_operation_name: "op_b" });
  }
});
