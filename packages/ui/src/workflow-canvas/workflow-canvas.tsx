"use client";

import * as React from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  MarkerType,
  type OnNodesChange,
  type OnEdgesChange,
  type OnConnect,
  type NodeTypes,
  type EdgeTypes,
  type DefaultEdgeOptions,
  type Connection,
  applyNodeChanges,
  applyEdgeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./workflow-canvas-theme.css";
import { useWorkflowCanvasStore } from "./workflow-canvas-store";
import { useWorkflowNodes } from "./use-workflow-nodes";
import { useWorkflowEdges } from "./use-workflow-edges";
import { WorkflowStepNode } from "./nodes/workflow-step-node";
import { WorkflowTriggerNode } from "./nodes/workflow-trigger-node";
import { WorkflowEdge as WorkflowEdgeComponent } from "./edges/workflow-edge";
import {
  WorkflowCanvasContext,
  type WorkflowCanvasCallbacks,
} from "./edges/workflow-canvas-context";
import { EmptyCanvasState } from "./empty-canvas-state";
import type { WorkflowNode, WorkflowEdge } from "./workflow-canvas-types";

/* ---------------------------------------------------------------------------
 * Registered node/edge types (stable references — never inline in JSX).
 * -------------------------------------------------------------------------*/

const nodeTypes: NodeTypes = {
  workflowStep: WorkflowStepNode as unknown as NodeTypes[string],
  workflowTrigger: WorkflowTriggerNode as unknown as NodeTypes[string],
};

const edgeTypes: EdgeTypes = {
  workflowEdge: WorkflowEdgeComponent,
  conditionalEdge: WorkflowEdgeComponent,
};

const defaultEdgeOptions: DefaultEdgeOptions = {
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 16,
    height: 16,
  },
};

/* ---------------------------------------------------------------------------
 * Props.
 * -------------------------------------------------------------------------*/

export type WorkflowCanvasProps = {
  steps: Record<string, unknown>[];
  idKey: string;
  triggers?: Record<string, unknown>[] | null;
  runs?: Record<string, unknown>[] | null;
  className?: string;
  testIdPrefix?: string | null;
  onNodeClick?: (stepId: string) => void;
  onConnect?: (sourceId: string, targetId: string) => void;
  onInsertStep?: (sourceId: string, targetId: string) => void;
  onAddFirstStep?: () => void;
};

/* ---------------------------------------------------------------------------
 * Component.
 * -------------------------------------------------------------------------*/

export function WorkflowCanvas({
  steps,
  idKey,
  triggers,
  runs,
  className,
  testIdPrefix,
  onNodeClick,
  onConnect: onConnectProp,
  onInsertStep,
  onAddFirstStep,
}: WorkflowCanvasProps) {
  const resolvedTestIdPrefix = testIdPrefix?.trim() ?? "";
  const store = useWorkflowCanvasStore();
  const hasTriggers =
    Array.isArray(triggers) && triggers.length > 0;

  /* Build runStepMap from the latest run (if any). */
  const runStepMap = React.useMemo<Map<string, Record<string, unknown>> | null>(() => {
    if (!Array.isArray(runs) || runs.length === 0) return null;
    const latestRun = runs[0] as Record<string, unknown>;
    const runSteps = latestRun?.run_steps;
    if (!Array.isArray(runSteps)) return null;
    const map = new Map<string, Record<string, unknown>>();
    for (const rs of runSteps) {
      const rec = rs as Record<string, unknown>;
      const stepId = typeof rec.workflow_template_step_id === "string" ? rec.workflow_template_step_id : null;
      if (stepId) map.set(stepId, rec);
    }
    return map.size > 0 ? map : null;
  }, [runs]);

  /* Derive nodes/edges from steps via hooks. */
  const derivedNodes = useWorkflowNodes({ steps, idKey, triggers, runStepMap });
  const derivedEdges = useWorkflowEdges({ steps, idKey, hasTriggers });

  /* Sync derived nodes/edges into the store on data changes. */
  const prevStepsRef = React.useRef(steps);
  React.useEffect(() => {
    if (prevStepsRef.current !== steps) {
      store.setNodes(derivedNodes);
      store.setEdges(derivedEdges);
      prevStepsRef.current = steps;
    }
  }, [steps, derivedNodes, derivedEdges, store]);

  /* Initial population. */
  React.useEffect(() => {
    if (store.nodes.length === 0 && derivedNodes.length > 0) {
      store.setNodes(derivedNodes);
      store.setEdges(derivedEdges);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Use store nodes/edges if populated, otherwise derived. */
  const nodes =
    store.nodes.length > 0 ? store.nodes : derivedNodes;
  const edges =
    store.edges.length > 0 ? store.edges : derivedEdges;

  /* Handlers. */
  const handleNodesChange: OnNodesChange = React.useCallback(
    (changes) => {
      const updated = applyNodeChanges(changes, nodes) as WorkflowNode[];
      store.setNodes(updated);
    },
    [nodes, store]
  );

  const handleEdgesChange: OnEdgesChange = React.useCallback(
    (changes) => {
      const updated = applyEdgeChanges(changes, edges) as WorkflowEdge[];
      store.setEdges(updated);
    },
    [edges, store]
  );

  const handleConnect: OnConnect = React.useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target && onConnectProp) {
        onConnectProp(connection.source, connection.target);
      }
    },
    [onConnectProp]
  );

  const handleNodeClick = React.useCallback(
    (_event: React.MouseEvent, node: WorkflowNode) => {
      store.selectNode(node.id);
      if (onNodeClick) {
        onNodeClick(node.id);
      }
    },
    [store, onNodeClick]
  );

  const handlePaneClick = React.useCallback(() => {
    store.selectNode(null);
  }, [store]);

  const canvasCallbacks = React.useMemo<WorkflowCanvasCallbacks>(
    () => ({ onInsertStep }),
    [onInsertStep],
  );

  const isEmpty = nodes.length === 0;

  return (
    <div
      className={["workflow-canvas relative w-full", className]
        .filter(Boolean)
        .join(" ")}
      style={{ height: "100%", minHeight: 400 }}
      data-testid={
        resolvedTestIdPrefix ? `${resolvedTestIdPrefix}-canvas` : undefined
      }
    >
      {isEmpty ? (
        <EmptyCanvasState onAddFirstStep={onAddFirstStep} />
      ) : (
        <WorkflowCanvasContext.Provider value={canvasCallbacks}>
          <ReactFlow
            style={{ position: "absolute", inset: 0 }}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={handleConnect}
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            snapToGrid
            snapGrid={[20, 20]}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.5 }}
            minZoom={0.25}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={null}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              className="!rounded-lg !border !border-ui-border !shadow-sm"
            />
          </ReactFlow>
        </WorkflowCanvasContext.Provider>
      )}
    </div>
  );
}
