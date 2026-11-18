import { Suspense } from "react";
import { LoadingState, DashboardPage as UiDashboardPage } from "@masarx/ui";

type DashboardPageProps = Parameters<typeof UiDashboardPage>[0];
const DashboardPageInner = UiDashboardPage as unknown as (
  props: DashboardPageProps
) => React.JSX.Element;

export function DashboardPage(props: DashboardPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState variant="page" testId="console-dashboard-loading" />
      }
    >
      <DashboardPageInner {...props} />
    </Suspense>
  );
}
