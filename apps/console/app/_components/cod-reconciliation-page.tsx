import { Suspense } from "react";
import { LoadingState, CodReconciliationPage as UiCodReconciliationPage } from "@masarx/ui";

type Props = Parameters<typeof UiCodReconciliationPage>[0];
const Inner = UiCodReconciliationPage as unknown as (props: Props) => React.JSX.Element;

export function CodReconciliationPage(props: Props) {
  return <Suspense fallback={<LoadingState variant="page" testId="console-cod-reconciliation-loading" />}>
    <Inner {...props} testIdPrefix="console-cod-reconciliation" />
  </Suspense>;
}
