import * as React from "react";

type PageHeaderProps = {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
};

/**
 * Page header with title, description, and optional actions.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: PageHeaderProps) {
  const eyebrowNodes = React.Children.toArray(eyebrow);
  const actionNodes = React.Children.toArray(actions);

  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-4 border-b border-ui-accent/15 pb-4">
      <div className="min-w-0">
        {eyebrowNodes.length > 0 ? (
          <div className="text-[11px] font-medium text-ui-accent/70">{eyebrowNodes}</div>
        ) : null}
        <h1
          className={[
            "text-2xl font-semibold tracking-tight text-ui-ink",
            eyebrowNodes.length > 0 ? "mt-1" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-prose text-sm text-ui-muted">{description}</p>
        ) : null}
      </div>
      {actionNodes.length > 0 ? (
        <div className="flex items-center gap-3">{actionNodes}</div>
      ) : null}
    </div>
  );
}
