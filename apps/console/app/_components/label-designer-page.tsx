import { Suspense } from "react";
import {
  LabelDesignerPage as UiLabelDesignerPage,
  LoadingState,
} from "@masarx/ui";

type LabelDesignerPageProps = Parameters<typeof UiLabelDesignerPage>[0];
const LabelDesignerPageInner = UiLabelDesignerPage as unknown as (
  props: LabelDesignerPageProps
) => React.JSX.Element;

export function LabelDesignerPage(props: LabelDesignerPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState
          variant="page"
          testId="console-label-designer-loading"
        />
      }
    >
      <LabelDesignerPageInner {...props} />
    </Suspense>
  );
}
