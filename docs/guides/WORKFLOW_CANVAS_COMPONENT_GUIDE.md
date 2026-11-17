# Workflow Canvas Component Guide

## Overview

The Workflow Canvas (`<WorkflowCanvas />`) is a React Flow v12-based interactive canvas for visualizing and editing workflow template steps. It lives in `packages/ui/src/workflow-canvas/` and is exported from `@masarx/ui`.

Feature-flagged via `workflow_canvas_version` (`"legacy"` | `"v2"`).

## Architecture

```
WorkflowCanvas (main component)
├── ReactFlow (canvas engine)
│   ├── WorkflowTriggerNode (trigger card)
│   ├── WorkflowStepNode (step card with numbering)
│   ├── WorkflowEdge (custom edge with arrow + "+" insert button)
│   ├── Background (dot grid)
│   ├── Controls (zoom in/out/fit)
│   └── MiniMap (pannable overview)
├── EmptyCanvasState (shown when no steps)
└── WorkflowCanvasContext (provides onInsertStep callback)
```

**State management:** Zustand store (`useWorkflowCanvasStore`) with undo/redo history stack. Nodes and edges are derived from step data via `useWorkflowNodes` and `useWorkflowEdges` hooks, then synced into the store.

## Props

| Prop | Type | Description |
|------|------|-------------|
| `steps` | `Record<string, unknown>[]` | Workflow template steps (row-driven from DB) |
| `idKey` | `string` | Key to extract step ID from each step record |
| `triggers` | `Record<string, unknown>[] \| null` | Optional trigger data |
| `runs` | `Record<string, unknown>[] \| null` | Optional run data for run-preview overlay |
| `onNodeClick` | `(stepId: string) => void` | Step selection callback |
| `onConnect` | `(sourceId: string, targetId: string) => void` | New connection callback |
| `onInsertStep` | `(sourceId: string, targetId: string) => void` | Edge "+" button callback |
| `onAddFirstStep` | `() => void` | Empty state CTA callback |
| `className` | `string` | Additional CSS classes |
| `testIdPrefix` | `string \| null` | Test ID prefix for `data-testid` attributes |

## Visual Features (Phase 1 Polish)

1. **Custom edges with arrows** — smooth-step paths (`borderRadius: 16`) with `ArrowClosed` marker at target. Hover highlights edge in accent color.
2. **"+" insert button** — appears at edge midpoint on hover via `EdgeLabelRenderer`. Calls `onInsertStep(sourceId, targetId)`.
3. **Step numbering** — 1-based index badge on top-right corner of each step node.
4. **Hidden handles** — connection handles hidden by default (`opacity-0`), visible on node hover or selection.
5. **Card shadows** — multi-layer CSS shadows for depth. Elevated shadow on hover.
6. **In-progress pulse** — `animate-pulse-dot` animation on status badge when `runStatus === "in_progress"`.
7. **Empty canvas state** — SVG illustration with dashed rectangles/lines, "No steps yet" heading, and "+ Add Step" CTA.

## File Structure

| File | Purpose |
|------|---------|
| `workflow-canvas.tsx` | Main component with ReactFlow setup |
| `workflow-canvas-types.ts` | TypeScript types for nodes, edges, state |
| `workflow-canvas-store.ts` | Zustand store with undo/redo |
| `workflow-canvas-theme.css` | CSS for shadows, edge hover, animations |
| `use-workflow-nodes.ts` | Derives React Flow nodes from step data |
| `use-workflow-edges.ts` | Derives React Flow edges from step routing |
| `index.ts` | Barrel exports |
| `edges/workflow-edge.tsx` | Custom edge component (arrow + "+" button) |
| `edges/workflow-canvas-context.ts` | React context for edge callbacks |
| `nodes/workflow-step-node.tsx` | Step card with accent stripe + numbering |
| `nodes/workflow-trigger-node.tsx` | Trigger card |
| `nodes/node-handle.tsx` | Connection handle with visibility toggle |
| `nodes/node-status-badge.tsx` | Status badge with pulse animation |
| `empty-canvas-state.tsx` | Empty state with SVG illustration |
| `workflow-canvas.stories.tsx` | Storybook stories (8 variants) |

## Storybook

Run `npm run storybook` (port 6006). Stories cover:

- **Default** — 3-step workflow with trigger
- **WithRunPreview** — run overlay with status badges + durations
- **EmptyCanvas** — empty state with CTA
- **SingleStep** — minimal single step
- **DisabledStep** — step with `enabled: false`
- **InProgressRun** — pulse animation for running status
- **LargeWorkflow** — 8 steps with full color palette
- **DarkMode** — dark theme variant

## Testing

46 unit tests in `tests/ui/`:
- `workflow-canvas-store.test.ts` — store operations + undo/redo
- `use-workflow-nodes.test.ts` — node derivation from step data
- `use-workflow-edges.test.ts` — edge derivation from routing
- `workflow-canvas-group-operations.test.ts` — operation grouping

Run: `npx jest --config config/tooling/jest.config.ui.js --testPathPattern="workflow-canvas|use-workflow-(nodes|edges)"`

## Integration

The canvas integrates into the workflow template studio via the feature flag:

```tsx
import { WorkflowCanvas } from "@masarx/ui";

// In workflow-template-studio-page.tsx, gated by workflow_canvas_version
<WorkflowCanvas
  steps={steps}
  idKey="id"
  triggers={triggers}
  runs={selectedRun ? [selectedRun] : null}
  onNodeClick={handleStepSelect}
  onInsertStep={handleInsertStep}
  onAddFirstStep={handleAddStep}
/>
```

## Dependencies

- `@xyflow/react` ^12 (React Flow)
- `zustand` ^5 (state management)
- `next-intl` (i18n for labels)

