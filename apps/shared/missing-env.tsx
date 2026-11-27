import { AppShell, PageContainer, PageHeader, Section } from "@masarx/ui";
import { getUiDefaults } from "@masarx/config";
import { resolveLocaleDir } from "./i18n/direction";

type MissingEnvNoticeProps = {
  appName: string;
  title: string;
  description: string;
  required: string;
  optional: string;
  errorLabel: string;
  locale: string;
  testIdPrefix?: string;
};

export function MissingEnvNotice({
  appName,
  title,
  description,
  required,
  optional,
  errorLabel,
  locale,
  testIdPrefix,
}: MissingEnvNoticeProps) {
  const uiDefaults = getUiDefaults();
  const testId = testIdPrefix ? `${testIdPrefix}-missing-env` : undefined;
  return (
    <html lang={locale} dir={resolveLocaleDir(locale, uiDefaults.rtlLocales)}>
      <body>
        <AppShell
          appName={appName}
          layout={uiDefaults.layout.mode}
          layoutMaxWidth={uiDefaults.layout.maxWidth}
        >
          <PageContainer className="space-y-6" data-testid={testId}>
            <PageHeader title={title} description={description} />
            <Section className="space-y-2 text-sm text-ui-muted">
              <p>{required}</p>
              <p>{optional}</p>
              <p>{errorLabel}</p>
            </Section>
          </PageContainer>
        </AppShell>
      </body>
    </html>
  );
}
