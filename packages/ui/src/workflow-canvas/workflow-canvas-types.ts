import type { Node, Edge } from "@xyflow/react";

/* ---------------------------------------------------------------------------
 * Step & operation types (mirrors the untyped Record<string, unknown> shapes
 * used in the legacy builder, kept narrow for React Flow node data).
 * -------------------------------------------------------------------------*/

export type WorkflowStepData = {
  stepId: string;
  operationName: string;
  handlerKey: string | null;
  enabled: boolean;
  manualActionRequired: boolean;
  transitionCondition: string | null;
  nextOperationName: string | null;
  nextOperationPriority: number | null;
  nextOperationDelaySeconds: number | null;
  conditionJsonlogic: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  /** Run overlay (populated only in run-preview mode). */
  runStatus: string | null;
  runDurationMs: number | null;
  /** 1-based step index for display numbering. */
  stepIndex: number;
};

export type WorkflowTriggerData = {
  triggerId: string;
  kind: "webhook" | "schedule" | "workflow_run";
  label: string;
  enabled: boolean;
};

/* ---------------------------------------------------------------------------
 * React Flow node/edge type aliases.
 * -------------------------------------------------------------------------*/

export type WorkflowStepNode = Node<WorkflowStepData, "workflowStep">;

export type WorkflowTriggerNode = Node<WorkflowTriggerData, "workflowTrigger">;

export type WorkflowNode = WorkflowStepNode | WorkflowTriggerNode;

export type WorkflowEdgeData = {
  sourceStepId: string;
  targetStepId: string | null;
  conditionJsonlogic: Record<string, unknown> | null;
  routeStatus: "target" | "missing" | "ambiguous" | "self" | "none";
};

export type WorkflowEdge = Edge<WorkflowEdgeData>;

/* ---------------------------------------------------------------------------
 * Canvas state slices (consumed by Zustand store).
 * -------------------------------------------------------------------------*/

export type CanvasSlice = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  selectedNodeId: string | null;
  hoveredNodeId: string | null;
};

export type EditorSlice = {
  editorStepId: string | null;
  editorOpen: boolean;
  saving: boolean;
  dirty: boolean;
};

export type RunPreviewSlice = {
  runPreviewId: string | null;
  runPreviewActive: boolean;
  runSteps: Record<string, unknown>[];
};

export type WorkflowCanvasState = CanvasSlice & EditorSlice & RunPreviewSlice;

/* ---------------------------------------------------------------------------
 * Feature flag.
 * -------------------------------------------------------------------------*/

export type WorkflowCanvasVersion = "legacy" | "v2";

/* ---------------------------------------------------------------------------
 * History entry (mirrors legacy FlowHistoryEntry).
 * -------------------------------------------------------------------------*/

export type WorkflowStepPatch = Record<string, unknown>;

export type FlowHistoryEntry =
  | { kind: "order"; before: string[]; after: string[] }
  | { kind: "patch"; stepId: string; before: WorkflowStepPatch; after: WorkflowStepPatch };
