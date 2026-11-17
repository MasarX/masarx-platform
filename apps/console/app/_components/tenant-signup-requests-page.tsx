import { Suspense } from "react";
import {
  LoadingState,
  TenantSignupRequestsPage as UiTenantSignupRequestsPage,
} from "@masarx/ui";

type TenantSignupRequestsPageProps = Parameters<
  typeof UiTenantSignupRequestsPage
>[0];

const TenantSignupRequestsPageInner =
  UiTenantSignupRequestsPage as unknown as (
    props: TenantSignupRequestsPageProps,
  ) => JSX.Element;

export function TenantSignupRequestsPage(props: TenantSignupRequestsPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="console-tenant-signup-requests-loading"
        />
      }
    >
      <TenantSignupRequestsPageInner {...props} />
    </Suspense>
  );
}
