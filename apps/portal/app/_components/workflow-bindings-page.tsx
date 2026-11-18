import { Suspense } from "react";
import { LoadingState, WorkflowBindingsPage as UiWorkflowBindingsPage } from "@masarx/ui";

type WorkflowBindingsPageProps = Parameters<typeof UiWorkflowBindingsPage>[0];

const WorkflowBindingsPageInner =
  UiWorkflowBindingsPage as unknown as (props: WorkflowBindingsPageProps) => React.JSX.Element;

export function WorkflowBindingsPage(props: WorkflowBindingsPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="portal-workflow-bindings-loading"
        />
      }
    >
      <WorkflowBindingsPageInner {...props} />
    </Suspense>
  );
}
