"use client";

import { useTranslations } from "next-intl";
import { PageContainer, PageHeader } from "@masarx/ui/client";
import { WebhookTester } from "../../../../packages/ui/src/integrations/webhook-tester";

async function previewWebhook() {
  return {
    status: 0,
    statusText: "Preview only",
    body: "Webhook delivery is unavailable on this page. No request was sent.",
    durationMs: 0,
  };
}

export function WebhookTesterPage() {
  const t = useTranslations("webhookTester");
  return (
    <PageContainer className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <div data-testid="console-webhook-tester-ready">
        <WebhookTester onSendTest={previewWebhook} />
      </div>
    </PageContainer>
  );
}
