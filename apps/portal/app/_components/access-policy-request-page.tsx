import { Suspense } from "react";
import {
  LoadingState,
  AccessPolicyRequestPage as UiAccessPolicyRequestPage,
} from "@masarx/ui";

type AccessPolicyRequestPageProps = Parameters<
  typeof UiAccessPolicyRequestPage
>[0];
const AccessPolicyRequestPageInner =
  UiAccessPolicyRequestPage as unknown as (
    props: AccessPolicyRequestPageProps
  ) => JSX.Element;

export function AccessPolicyRequestPage(props: AccessPolicyRequestPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="portal-access-policy-request-loading"
        />
      }
    >
      <AccessPolicyRequestPageInner {...props} />
    </Suspense>
  );
}
