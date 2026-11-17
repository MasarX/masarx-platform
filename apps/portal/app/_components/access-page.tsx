import { Suspense } from "react";
import { LoadingState, AccessPage as UiAccessPage } from "@masarx/ui";

type AccessPageProps = Parameters<typeof UiAccessPage>[0];
const AccessPageInner = UiAccessPage as unknown as (
  props: AccessPageProps
) => React.JSX.Element;

export function AccessPage(props: AccessPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState variant="page" testId="portal-access-loading" />
      }
    >
      <AccessPageInner {...props} />
    </Suspense>
  );
}
