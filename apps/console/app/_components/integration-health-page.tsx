"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  EmptyState,
  ErrorState,
  IntegrationHealth,
  type IntegrationHealthEntry,
  PageHeader,
  PageContainer,
} from "@masarx/ui/client";

export type IntegrationHealthLoadState = "ready" | "error" | "denied";

type IntegrationHealthPageProps = {
  testIdPrefix?: string;
  integrations?: IntegrationHealthEntry[];
  loadState?: IntegrationHealthLoadState;
};

/**
 * Integration Health dashboard showing per-integration status, success rates,
 * and call volumes. Data is fetched server-side from the `providers` table
 * via `ui_list_resource_v1` and passed as props.
 */
export function IntegrationHealthPage({
  testIdPrefix = "console-integration-health",
  integrations = [],
  loadState = "ready",
}: IntegrationHealthPageProps) {
  const t = useTranslations("integrationHealth");
  const router = useRouter();
  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
      />
      {loadState === "error" ? (
        <div role="alert">
          <ErrorState
            title={t("error.title")}
            description={t("error.description")}
            actionLabel={t("error.retry")}
            onAction={() => router.refresh()}
            testId={`${testIdPrefix}-error`}
          />
        </div>
      ) : loadState === "denied" ? (
        <EmptyState
          title={t("denied.title")}
          description={t("denied.description")}
          testId={`${testIdPrefix}-denied`}
        />
      ) : (
        <div data-testid={`${testIdPrefix}-ready`}>
          {integrations.length === 0 ? (
            <EmptyState
              title={t("empty")}
              variant="card"
              testId={`${testIdPrefix}-empty`}
            />
          ) : (
            <IntegrationHealth integrations={integrations} />
          )}
        </div>
      )}
    </PageContainer>
  );
}
