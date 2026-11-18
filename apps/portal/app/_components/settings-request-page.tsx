import { Suspense } from "react";
import {
  LoadingState,
  SettingsRequestPage as UiSettingsRequestPage,
} from "@masarx/ui";

type SettingsRequestPageProps = Parameters<typeof UiSettingsRequestPage>[0];
const SettingsRequestPageInner = UiSettingsRequestPage as unknown as (
  props: SettingsRequestPageProps
) => React.JSX.Element;

export function SettingsRequestPage(props: SettingsRequestPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="portal-settings-request-loading"
        />
      }
    >
      <SettingsRequestPageInner {...props} />
    </Suspense>
  );
}
