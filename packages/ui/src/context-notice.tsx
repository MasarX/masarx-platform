import * as React from "react";
import { Section } from "./section";
import { createUiTranslator } from "./i18n";

type ContextNoticeProps = {
  title: string;
  action: string;
  detail?: string | null;
  detailNode?: React.ReactNode;
  links?: Array<{
    href: string;
    label: string;
    testId?: string;
  }> | null;
  linksTitle?: string | null;
  testId?: string;
};

const t = createUiTranslator("ui.context");

export function ContextNotice({
  title,
  action,
  detail,
  detailNode,
  links,
  linksTitle,
  testId,
}: ContextNoticeProps) {
  const hasLinks = Array.isArray(links) && links.length > 0;

  return (
    <Section>
      <div data-testid={testId} className="space-y-2 text-sm text-ui-muted">
        <p>{title}</p>
        <p className="text-xs text-ui-muted">
          {t("nextStep", { action })}
        </p>
        {detailNode ? (
          detailNode
        ) : detail ? (
          <p className="text-xs text-ui-muted">{detail}</p>
        ) : null}
        {hasLinks ? (
          <div className="space-y-2 text-xs text-ui-muted">
            {linksTitle ? <p>{linksTitle}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              {links.map((link) => (
                <a
                  key={`${link.href}:${link.label}`}
                  href={link.href}
                  className="rounded-full border border-ui-border bg-ui-surface/70 px-3 py-1 text-ui-ink underline underline-offset-4"
                  data-testid={link.testId}
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
