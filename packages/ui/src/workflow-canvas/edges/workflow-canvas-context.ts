"use client";

import { createContext, useContext } from "react";

export type WorkflowCanvasCallbacks = {
  onInsertStep?: (sourceId: string, targetId: string) => void;
};

export const WorkflowCanvasContext = createContext<WorkflowCanvasCallbacks>({});

export function useWorkflowCanvasCallbacks(): WorkflowCanvasCallbacks {
  return useContext(WorkflowCanvasContext);
}
