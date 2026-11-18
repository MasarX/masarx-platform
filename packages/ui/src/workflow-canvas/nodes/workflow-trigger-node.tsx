"use client";

import * as React from "react";
import type { NodeProps } from "@xyflow/react";
import type { WorkflowTriggerData } from "../workflow-canvas-types";
import { NodeHandle } from "./node-handle";

type WorkflowTriggerNodeProps = NodeProps & {
  data: WorkflowTriggerData;
};

export const WorkflowTriggerNode = React.memo(function WorkflowTriggerNode({
  data,
  selected,
}: WorkflowTriggerNodeProps) {
  const { label } = data;

  return (
    <div
      data-testid="workflow-trigger-node"
      data-flow-node
      data-flow-node-id="__workflow_triggers__"
      className={[
        "group relative w-[200px] rounded-2xl border bg-white transition-all duration-200 dark:bg-gray-900",
        selected
          ? "border-transparent ring-2 ring-blue-500/20"
          : "border-blue-200 hover:-translate-y-0.5 dark:border-blue-800/60",
      ].join(" ")}
    >
      {/* Left accent stripe */}
      <div className="absolute start-0 top-0 h-full w-1 rounded-s-2xl bg-blue-500" />

      <div className="py-3.5 ps-5 pe-3.5">
        <div className="flex items-center gap-3">
          {/* Lightning icon in circle */}
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-100 dark:bg-blue-950/40">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-5 w-5 text-blue-500 dark:text-blue-400"
            >
              <path d="M11.983 1.907a.75.75 0 0 0-1.292-.657l-8.5 9.5A.75.75 0 0 0 2.75 12h6.572l-1.305 6.093a.75.75 0 0 0 1.292.657l8.5-9.5A.75.75 0 0 0 17.25 8h-6.572l1.305-6.093Z" />
            </svg>
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-blue-500 dark:text-blue-400">
              Trigger
            </div>
            <div className="mt-0.5 text-sm font-semibold leading-snug text-gray-800 dark:text-gray-100">
              {label}
            </div>
          </div>
        </div>
      </div>

      <NodeHandle type="source" visible={selected} />
    </div>
  );
});
