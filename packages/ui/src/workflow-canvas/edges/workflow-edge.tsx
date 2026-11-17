"use client";

import * as React from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import { useWorkflowCanvasCallbacks } from "./workflow-canvas-context";

/* ---------------------------------------------------------------------------
 * Custom workflow edge with:
 * - Smooth-step (right-angled, rounded) path instead of bezier
 * - Arrow marker at target end
 * - Hover highlight (stroke color change)
 * - "+" insert button at midpoint (hidden by default, visible on hover)
 * -------------------------------------------------------------------------*/

export function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
  selected,
}: EdgeProps) {
  const { onInsertStep } = useWorkflowCanvasCallbacks();
  const [hovered, setHovered] = React.useState(false);

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 16,
  });

  const sourceId =
    (data as Record<string, unknown> | undefined)?.sourceStepId as
      | string
      | undefined;
  const targetId =
    (data as Record<string, unknown> | undefined)?.targetStepId as
      | string
      | undefined;

  const handleInsertClick = React.useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (onInsertStep && sourceId && targetId) {
        onInsertStep(sourceId, targetId);
      }
    },
    [onInsertStep, sourceId, targetId],
  );

  return (
    <>
      {/* Invisible wider hit area for hover detection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: selected
            ? "var(--xy-edge-stroke-selected)"
            : hovered
              ? "var(--xy-edge-stroke-selected)"
              : undefined,
          transition: "stroke 150ms ease",
        }}
        className={hovered ? "workflow-edge-hovered" : undefined}
      />
      {onInsertStep && sourceId && targetId ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            className={[
              "nodrag nopan",
              "flex h-6 w-6 items-center justify-center rounded-full",
              "border border-gray-200 bg-white text-gray-400 shadow-sm",
              "hover:border-blue-400 hover:text-blue-500 hover:shadow-md",
              "dark:border-gray-700 dark:bg-gray-800 dark:text-gray-500",
              "dark:hover:border-blue-500 dark:hover:text-blue-400",
              "transition-all duration-150",
              hovered || selected
                ? "scale-100 opacity-100"
                : "pointer-events-none scale-75 opacity-0",
            ].join(" ")}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            onClick={handleInsertClick}
            aria-label="Insert step"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-3.5 w-3.5"
            >
              <path d="M8.75 3.75a.75.75 0 0 0-1.5 0v3.5h-3.5a.75.75 0 0 0 0 1.5h3.5v3.5a.75.75 0 0 0 1.5 0v-3.5h3.5a.75.75 0 0 0 0-1.5h-3.5v-3.5Z" />
            </svg>
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
