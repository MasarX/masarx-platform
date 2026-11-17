"use client";

import * as React from "react";

type EmptyCanvasStateProps = {
  onAddFirstStep?: () => void;
  className?: string;
};

export function EmptyCanvasState({
  onAddFirstStep,
  className,
}: EmptyCanvasStateProps) {
  return (
    <div
      className={[
        "flex h-full w-full flex-col items-center justify-center gap-6",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid="workflow-canvas-empty"
    >
      {/* Dashed placeholder illustration — 3 boxes connected by dashed lines */}
      <svg
        width="200"
        height="64"
        viewBox="0 0 200 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="text-gray-300 dark:text-gray-600"
        aria-hidden="true"
      >
        {/* Box 1 */}
        <rect
          x="2"
          y="12"
          width="48"
          height="40"
          rx="10"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="4 3"
        />
        {/* Line 1→2 */}
        <line
          x1="50"
          y1="32"
          x2="76"
          y2="32"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="4 3"
        />
        {/* Box 2 */}
        <rect
          x="76"
          y="12"
          width="48"
          height="40"
          rx="10"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="4 3"
        />
        {/* Line 2→3 */}
        <line
          x1="124"
          y1="32"
          x2="150"
          y2="32"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="4 3"
        />
        {/* Box 3 */}
        <rect
          x="150"
          y="12"
          width="48"
          height="40"
          rx="10"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="4 3"
        />
      </svg>

      <div className="text-center">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400">
          No steps yet
        </h3>
        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
          Add your first step to build the workflow
        </p>
      </div>

      {onAddFirstStep ? (
        <button
          type="button"
          onClick={onAddFirstStep}
          className={[
            "inline-flex items-center gap-1.5 rounded-lg px-4 py-2",
            "border border-gray-200 bg-white text-sm font-medium text-gray-700 shadow-sm",
            "hover:border-blue-300 hover:text-blue-600 hover:shadow",
            "dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300",
            "dark:hover:border-blue-600 dark:hover:text-blue-400",
            "transition-all duration-150",
          ].join(" ")}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="h-4 w-4"
          >
            <path d="M8.75 3.75a.75.75 0 0 0-1.5 0v3.5h-3.5a.75.75 0 0 0 0 1.5h3.5v3.5a.75.75 0 0 0 1.5 0v-3.5h3.5a.75.75 0 0 0 0-1.5h-3.5v-3.5Z" />
          </svg>
          Add Step
        </button>
      ) : null}
    </div>
  );
}
