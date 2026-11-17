import { createUiServerClient } from "@masarx/api/server";
import { UiTrace } from "@masarx/api";
import {
  resolvePaginationSettings,
  formatUiError,
} from "@masarx/ui";
import { withPortalConfig } from "../../../app-context";
import { ObservabilityTracePage } from "../../../../../shared/observability-trace-page";

type PageProps = {
  params: { correlation_id: string };
};

export default withPortalConfig<PageProps>(async ({ t }, { params }) => {
  const ui = createUiServerClient();
  let trace: UiTrace | null = null;
  let errorMessage: string | null = null;
  let paginationSettings = resolvePaginationSettings(null);

  try {
    trace = await ui.getTrace(params.correlation_id);
  } catch (error) {
    errorMessage = formatUiError(error, t("observability.trace.errors.load"));
  }

  try {
    const preview = await ui.settingsPreview({ category: "ui_pagination" });
    paginationSettings = resolvePaginationSettings(preview?.value);
  } catch {
    paginationSettings = resolvePaginationSettings(null);
  }

  return (
    <ObservabilityTracePage
      correlationId={params.correlation_id}
      trace={trace}
      errorMessage={errorMessage}
      paginationSettings={paginationSettings}
      testIdPrefix="portal"
      t={t}
    />
  );
});
