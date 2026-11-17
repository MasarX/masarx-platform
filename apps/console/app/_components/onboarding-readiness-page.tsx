import { Suspense } from "react";
import { LoadingState, OnboardingReadinessPage as UiOnboardingReadinessPage } from "@masarx/ui";

type OnboardingReadinessPageProps = Parameters<typeof UiOnboardingReadinessPage>[0];

const OnboardingReadinessPageInner =
  UiOnboardingReadinessPage as unknown as (props: OnboardingReadinessPageProps) => JSX.Element;

export function OnboardingReadinessPage(props: OnboardingReadinessPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="console-onboarding-readiness-loading"
        />
      }
    >
      <OnboardingReadinessPageInner {...props} />
    </Suspense>
  );
}
