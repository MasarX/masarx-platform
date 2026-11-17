import { create } from "zustand";
import { temporal } from "zundo";
import type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowCanvasState,
  FlowHistoryEntry,
} from "./workflow-canvas-types";

/* ---------------------------------------------------------------------------
 * Actions exposed by the store.
 * -------------------------------------------------------------------------*/

type WorkflowCanvasActions = {
  /* Canvas ----------------------------------------------------------------*/
  setNodes: (nodes: WorkflowNode[]) => void;
  setEdges: (edges: WorkflowEdge[]) => void;
  selectNode: (nodeId: string | null) => void;
  hoverNode: (nodeId: string | null) => void;

  /* Editor ----------------------------------------------------------------*/
  openEditor: (stepId: string) => void;
  closeEditor: () => void;
  setSaving: (saving: boolean) => void;
  setDirty: (dirty: boolean) => void;

  /* Run preview -----------------------------------------------------------*/
  setRunPreview: (runId: string | null) => void;
  setRunSteps: (steps: Record<string, unknown>[]) => void;

  /* Bulk reset ------------------------------------------------------------*/
  reset: () => void;
};

export type WorkflowCanvasStore = WorkflowCanvasState & WorkflowCanvasActions;

/* ---------------------------------------------------------------------------
 * Initial / default state.
 * -------------------------------------------------------------------------*/

const initialState: WorkflowCanvasState = {
  /* canvas */
  nodes: [],
  edges: [],
  selectedNodeId: null,
  hoveredNodeId: null,

  /* editor */
  editorStepId: null,
  editorOpen: false,
  saving: false,
  dirty: false,

  /* run preview */
  runPreviewId: null,
  runPreviewActive: false,
  runSteps: [],
};

/* ---------------------------------------------------------------------------
 * Store factory — uses zundo temporal middleware for undo/redo.
 *
 * Call `useWorkflowCanvasStore.temporal.getState().undo()` to undo, etc.
 * Only `nodes` and `edges` diffs are tracked (editor/run-preview state
 * is ephemeral).
 * -------------------------------------------------------------------------*/

export const useWorkflowCanvasStore = create<WorkflowCanvasStore>()(
  temporal(
    (set) => ({
      ...initialState,

      /* Canvas -------------------------------------------------------------*/
      setNodes: (nodes) => set({ nodes }),
      setEdges: (edges) => set({ edges }),
      selectNode: (nodeId) =>
        set({
          selectedNodeId: nodeId,
          editorStepId: nodeId,
          editorOpen: nodeId !== null,
        }),
      hoverNode: (nodeId) => set({ hoveredNodeId: nodeId }),

      /* Editor -------------------------------------------------------------*/
      openEditor: (stepId) =>
        set({ editorStepId: stepId, editorOpen: true, selectedNodeId: stepId }),
      closeEditor: () => set({ editorOpen: false }),
      setSaving: (saving) => set({ saving }),
      setDirty: (dirty) => set({ dirty }),

      /* Run preview --------------------------------------------------------*/
      setRunPreview: (runId) =>
        set({
          runPreviewId: runId,
          runPreviewActive: runId !== null,
          runSteps: [],
        }),
      setRunSteps: (steps) => set({ runSteps: steps }),

      /* Bulk reset ---------------------------------------------------------*/
      reset: () => set(initialState),
    }),
    {
      /* Only track nodes/edges changes for undo/redo (skip ephemeral UI). */
      partialize: (state) => ({
        nodes: state.nodes,
        edges: state.edges,
      }),
      limit: 50,
    }
  )
);

/* ---------------------------------------------------------------------------
 * Legacy undo/redo stack helpers (imperative, used during migration period).
 * These mirror the FlowHistoryEntry-based approach so the legacy canvas and
 * the v2 canvas share the same undo semantics during the feature-flag period.
 * -------------------------------------------------------------------------*/

export function createLegacyHistoryStack() {
  let undoStack: FlowHistoryEntry[] = [];
  let redoStack: FlowHistoryEntry[] = [];

  return {
    push(entry: FlowHistoryEntry) {
      undoStack = [...undoStack, entry];
      redoStack = [];
    },
    undo() {
      if (undoStack.length === 0) return null;
      const entry = undoStack[undoStack.length - 1]!;
      undoStack = undoStack.slice(0, -1);
      redoStack = [...redoStack, entry];
      return entry;
    },
    redo() {
      if (redoStack.length === 0) return null;
      const entry = redoStack[redoStack.length - 1]!;
      redoStack = redoStack.slice(0, -1);
      undoStack = [...undoStack, entry];
      return entry;
    },
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    clear() {
      undoStack = [];
      redoStack = [];
    },
    getUndoStack() {
      return undoStack;
    },
    getRedoStack() {
      return redoStack;
    },
  };
}
