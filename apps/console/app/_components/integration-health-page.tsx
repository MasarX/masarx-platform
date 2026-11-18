"use client";

import { useTranslations } from "next-intl";
import {
  IntegrationHealth,
  type IntegrationHealthEntry,
  PageHeader,
  PageContainer,
} from "@masarx/ui/client";

type IntegrationHealthPageProps = {
  testIdPrefix?: string;
  integrations?: IntegrationHealthEntry[];
};

/**
 * Integration Health dashboard showing per-integration status, success rates,
 * and call volumes. Data is fetched server-side from the `providers` table
 * via `ui_list_resource_v1` and passed as props.
 */
export function IntegrationHealthPage({
  testIdPrefix = "console-integration-health",
  integrations = [],
}: IntegrationHealthPageProps) {
  const t = useTranslations("integrationHealth");
  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
      />
      <div data-testid={`${testIdPrefix}-ready`}>
        {integrations.length === 0 ? (
          <div className="rounded-lg border border-ui-border/40 bg-ui-surface p-8 text-center">
            <p className="text-sm text-ui-muted">
              {t("empty")}
            </p>
          </div>
        ) : (
          <IntegrationHealth integrations={integrations} />
        )}
      </div>
    </PageContainer>
  );
}
