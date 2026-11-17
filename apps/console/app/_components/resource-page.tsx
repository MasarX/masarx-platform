import { InvestigationLinks } from "./investigation-links";
import { Suspense } from "react";
import { LoadingState, ResourcePage as UiResourcePage } from "@masarx/ui";

type ResourcePageProps = Parameters<typeof UiResourcePage>[0];
const ResourcePageInner = UiResourcePage as unknown as (
  props: ResourcePageProps
) => React.JSX.Element;

export function ResourcePage(props: ResourcePageProps) {
  const isInvestigation = ["audit_table_changes", "decision_log"].includes(props.resourceKey);
  const renderInvestigation: ResourcePageProps["renderDetailFooter"] = ({ detail, detailError }) =>
    detail && !detailError ? <InvestigationLinks detail={detail} appBasePath={props.appBasePath} /> : null;
  return (
    <Suspense
      fallback={
        <LoadingState variant="page" testId="console-resource-loading" />
      }
    >
      <ResourcePageInner {...props} renderDetailFooter={props.renderDetailFooter ?? (isInvestigation ? renderInvestigation : undefined)} />
    </Suspense>
  );
}
