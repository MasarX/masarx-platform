import {
  Button,
  LoadingState,
  PageContainer,
  PageHeader,
  Section,
} from "@masarx/ui";
import { resolveSafeAppBasePath } from "../../packages/ui/src/url-guard";
import { createAppContext, type AppKey, type LoadMessages } from "./app-layout";

type FallbackParams = {
  appKey: AppKey;
  appBasePath: string;
  loadMessages: LoadMessages;
};

export function createLoadingPage({
  appKey,
  appBasePath,
  loadMessages,
}: FallbackParams) {
  return async function Loading() {
    const { appName, t } = await createAppContext({
      appKey,
      appBasePath,
      loadMessages,
    });
    return (
      <PageContainer className="space-y-6" data-testid={`${appKey}-loading`}>
        <PageHeader title={appName} description={t("app.loading")} />
        <Section>
          <LoadingState />
        </Section>
      </PageContainer>
    );
  };
}

export function createNotFoundPage({
  appKey,
  appBasePath,
  loadMessages,
}: FallbackParams) {
  return async function NotFound() {
    const { appName, t } = await createAppContext({
      appKey,
      appBasePath,
      loadMessages,
    });
    const safeHomeHref = resolveSafeAppBasePath(appBasePath) || "/";
    return (
      <PageContainer className="space-y-6" data-testid={`${appKey}-not-found`}>
        <PageHeader
          title={t("app.notFound.title")}
          description={t("app.notFound.description")}
        />
        <Section className="space-y-3 text-sm text-ui-muted">
          <p>{t("app.notFound.hint")}</p>
          <Button asChild>
            <a href={safeHomeHref}>
              {t("app.notFound.action", { appLabel: appName })}
            </a>
          </Button>
        </Section>
      </PageContainer>
    );
  };
}
