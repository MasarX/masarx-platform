import { Suspense } from "react";
import { LoadingState, ResourcePage as UiResourcePage } from "@masarx/ui";

type ResourcePageProps = Parameters<typeof UiResourcePage>[0];
const ResourcePageInner = UiResourcePage as unknown as (
  props: ResourcePageProps
) => JSX.Element;

export function ResourcePage(props: ResourcePageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState variant="page" testId="console-resource-loading" />
      }
    >
      <ResourcePageInner {...props} />
    </Suspense>
  );
}
