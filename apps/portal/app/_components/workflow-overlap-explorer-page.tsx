import { Suspense } from "react";
import {
  LoadingState,
  WorkflowOverlapExplorerPage as UiWorkflowOverlapExplorerPage,
} from "@masarx/ui";

type WorkflowOverlapExplorerPageProps = Parameters<
  typeof UiWorkflowOverlapExplorerPage
>[0];
const WorkflowOverlapExplorerPageInner =
  UiWorkflowOverlapExplorerPage as unknown as (
    props: WorkflowOverlapExplorerPageProps
  ) => JSX.Element;

export function WorkflowOverlapExplorerPage(
  props: WorkflowOverlapExplorerPageProps
) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="portal-workflow-overlaps-loading"
        />
      }
    >
      <WorkflowOverlapExplorerPageInner {...props} />
    </Suspense>
  );
}
