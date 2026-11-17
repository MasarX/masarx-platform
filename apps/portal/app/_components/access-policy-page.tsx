import { Suspense } from "react";
import { AccessPolicyPage as UiAccessPolicyPage, LoadingState } from "@masarx/ui";

type AccessPolicyPageProps = Parameters<typeof UiAccessPolicyPage>[0];
const AccessPolicyPageInner = UiAccessPolicyPage as unknown as (
  props: AccessPolicyPageProps
) => JSX.Element;

export function AccessPolicyPage(props: AccessPolicyPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState variant="page" testId="portal-access-policy-loading" />
      }
    >
      <AccessPolicyPageInner {...props} />
    </Suspense>
  );
}
