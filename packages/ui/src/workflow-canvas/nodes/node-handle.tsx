"use client";

import * as React from "react";
import { Handle, Position } from "@xyflow/react";
import type { HandleProps } from "@xyflow/react";

type NodeHandleProps = Omit<HandleProps, "position"> & {
  position?: Position;
  className?: string;
  /** Force-show the handle (e.g. when node is selected). Default: hidden until group hover. */
  visible?: boolean;
};

export const NodeHandle = React.memo(function NodeHandle({
  type,
  position,
  className,
  visible,
  ...rest
}: NodeHandleProps) {
  const resolvedPosition =
    position ?? (type === "source" ? Position.Right : Position.Left);

  return (
    <Handle
      type={type}
      position={resolvedPosition}
      className={[
        "!h-3 !w-3 !rounded-full !border-2 !bg-white dark:!bg-gray-900",
        "!border-gray-300 dark:!border-gray-600",
        "group-hover:!border-blue-400 dark:group-hover:!border-blue-500",
        "hover:!scale-[1.3] hover:!border-blue-500 hover:!bg-blue-50 dark:hover:!bg-blue-900/50",
        "!transition-all !duration-150",
        "!shadow-sm",
        visible
          ? "!opacity-100"
          : "!opacity-0 group-hover:!opacity-100",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
});
