/* ---------------------------------------------------------------------------
 * Workflow Canvas (React Flow v2) — barrel export.
 * -------------------------------------------------------------------------*/

/* Canvas */
export { WorkflowCanvas } from "./workflow-canvas";
export type { WorkflowCanvasProps } from "./workflow-canvas";

/* Store */
export { useWorkflowCanvasStore, createLegacyHistoryStack } from "./workflow-canvas-store";

/* Types */
export type {
  WorkflowStepData,
  WorkflowTriggerData,
  WorkflowStepNode,
  WorkflowTriggerNode,
  WorkflowNode,
  WorkflowEdge,
  WorkflowEdgeData,
  WorkflowCanvasState,
  WorkflowCanvasVersion,
  WorkflowStepPatch,
  FlowHistoryEntry,
} from "./workflow-canvas-types";

/* Hooks */
export { useWorkflowNodes } from "./use-workflow-nodes";
export { useWorkflowEdges } from "./use-workflow-edges";

/* Nodes */
export { WorkflowStepNode as WorkflowStepNodeComponent } from "./nodes/workflow-step-node";
export { WorkflowTriggerNode as WorkflowTriggerNodeComponent } from "./nodes/workflow-trigger-node";
export { NodeHandle } from "./nodes/node-handle";
export { NodeStatusBadge } from "./nodes/node-status-badge";

/* Edges */
export { WorkflowEdge as WorkflowEdgeComponent } from "./edges/workflow-edge";
export {
  WorkflowCanvasContext,
  useWorkflowCanvasCallbacks,
} from "./edges/workflow-canvas-context";
export type { WorkflowCanvasCallbacks } from "./edges/workflow-canvas-context";

/* Empty state */
export { EmptyCanvasState } from "./empty-canvas-state";

/* Panels */
export { StepEditorPanel } from "./panels/step-editor-panel";
export type { StepEditorPanelProps } from "./panels/step-editor-panel";
export { StepRoutingSection } from "./panels/step-routing-section";
export { StepMetadataSection } from "./panels/step-metadata-section";

/* Palette */
export { OperationPalette, OPERATION_DND_TYPE } from "./palette/operation-palette";
export { OperationPaletteItem } from "./palette/operation-palette-item";
export { useOperationMatches } from "./palette/use-operation-matches";
export {
  groupOperationMatches,
  resolveOperationLabel,
  resolveOperationDescription,
} from "./palette/group-operation-matches";
export type {
  OperationMatch,
  OperationGroup,
  GroupedOperationMatches,
} from "./palette/group-operation-matches";
