import { Suspense } from "react";
import { LoadingState, WorkflowRunPage as UiWorkflowRunPage } from "@masarx/ui";

type WorkflowRunPageProps = Parameters<typeof UiWorkflowRunPage>[0];
const WorkflowRunPageInner = UiWorkflowRunPage as unknown as (
  props: WorkflowRunPageProps
) => JSX.Element;

export function WorkflowRunPage(props: WorkflowRunPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState variant="page" testId="portal-workflow-run-loading" />
      }
    >
      <WorkflowRunPageInner {...props} />
    </Suspense>
  );
}
