import { Suspense } from "react";
import {
  LoadingState,
  WorkflowTemplateCreatePage as UiWorkflowTemplateCreatePage,
} from "@masarx/ui";

type WorkflowTemplateCreatePageProps = Parameters<
  typeof UiWorkflowTemplateCreatePage
>[0];
const WorkflowTemplateCreatePageInner =
  UiWorkflowTemplateCreatePage as unknown as (
    props: WorkflowTemplateCreatePageProps
  ) => JSX.Element;

export function WorkflowTemplateCreatePage(
  props: WorkflowTemplateCreatePageProps
) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="console-workflow-template-create-loading"
        />
      }
    >
      <WorkflowTemplateCreatePageInner {...props} />
    </Suspense>
  );
}
