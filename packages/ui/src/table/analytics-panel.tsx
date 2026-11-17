import type { ResourceColumn } from "./columns";
import { resolveColumnLabelByKey } from "./columns";
import type { ResourceMetrics } from "./metrics";
import { EMPTY_METRIC, formatMetricValue } from "./metrics";
import type { TranslateFn } from "./types";

type TableAnalyticsPanelProps = {
  t: TranslateFn;
  metricKeys: string[];
  pageMetrics: ResourceMetrics;
  datasetMetrics?: ResourceMetrics | null;
  selectedMetrics?: ResourceMetrics | null;
  selectedMetricKeys: string[];
  columnsByKey: Map<string, ResourceColumn>;
  pageShareLabel?: string | null;
  selectedShareLabel?: string | null;
  hasGrouping: boolean;
};

export function TableAnalyticsPanel({
  t,
  metricKeys,
  pageMetrics,
  datasetMetrics,
  selectedMetrics,
  selectedMetricKeys,
  columnsByKey,
  pageShareLabel,
  selectedShareLabel,
  hasGrouping,
}: TableAnalyticsPanelProps) {
  const scrollRegionClassName =
    "mt-3 overflow-x-auto rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper";
  return (
    <div className="rounded-lg border border-ui-border/40 bg-ui-highlight/30 p-4 text-sm motion-safe:animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-medium text-ui-muted">
          {t("analytics.title")}
        </span>
        <div className="flex flex-wrap items-center gap-3 text-xs text-ui-muted">
          <span>{t("analytics.pageRows", { count: pageMetrics.total })}</span>
          {datasetMetrics ? (
            <span>
              {t("analytics.datasetRows", { count: datasetMetrics.total })}
            </span>
          ) : null}
          {pageShareLabel ? (
            <span>{t("analytics.pageShare", { share: pageShareLabel })}</span>
          ) : null}
          {selectedMetrics ? (
            <span>
              {t("analytics.selectedRows", { count: selectedMetrics.total })}
            </span>
          ) : null}
          {selectedShareLabel ? (
            <span>
              {t("analytics.selectedShare", { share: selectedShareLabel })}
            </span>
          ) : null}
          {hasGrouping ? <span>{t("analytics.groupNote")}</span> : null}
        </div>
      </div>
      {metricKeys.length > 0 ? (
        <div
          className={scrollRegionClassName}
          tabIndex={0}
          aria-label={t("analytics.title")}
        >
          <table className="min-w-full border-collapse text-left text-xs">
            <thead className="text-[10px] font-medium text-ui-muted">
              <tr>
                <th className="px-3 py-2 font-medium">
                  {t("analytics.columns.column")}
                </th>
                <th className="px-3 py-2 font-medium text-right">
                  {t("analytics.columns.pageCount")}
                </th>
                <th className="px-3 py-2 font-medium text-right">
                  {t("analytics.columns.pageSum")}
                </th>
                <th className="px-3 py-2 font-medium text-right">
                  {t("analytics.columns.pageAvg")}
                </th>
                <th className="px-3 py-2 font-medium text-right">
                  {t("analytics.columns.pageMin")}
                </th>
                <th className="px-3 py-2 font-medium text-right">
                  {t("analytics.columns.pageMax")}
                </th>
                {datasetMetrics ? (
                  <>
                    <th className="px-3 py-2 font-medium text-right">
                      {t("analytics.columns.datasetCount")}
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      {t("analytics.columns.datasetSum")}
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      {t("analytics.columns.datasetAvg")}
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      {t("analytics.columns.datasetMin")}
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      {t("analytics.columns.datasetMax")}
                    </th>
                  </>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {metricKeys.map((key) => {
                const page = pageMetrics.columns[key] ?? EMPTY_METRIC;
                const dataset = datasetMetrics?.columns[key] ?? null;
                return (
                  <tr key={key} className="border-t border-ui-border/40">
                    <td className="px-3 py-2 text-ui-ink">
                      {resolveColumnLabelByKey(columnsByKey, key)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {page.count}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMetricValue(page.sum)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMetricValue(page.avg)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMetricValue(page.min)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMetricValue(page.max)}
                    </td>
                    {dataset ? (
                      <>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {dataset.count}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMetricValue(dataset.sum)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMetricValue(dataset.avg)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMetricValue(dataset.min)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMetricValue(dataset.max)}
                        </td>
                      </>
                    ) : datasetMetrics ? (
                      <>
                        <td className="px-3 py-2 text-right text-ui-muted">--</td>
                        <td className="px-3 py-2 text-right text-ui-muted">--</td>
                        <td className="px-3 py-2 text-right text-ui-muted">--</td>
                        <td className="px-3 py-2 text-right text-ui-muted">--</td>
                        <td className="px-3 py-2 text-right text-ui-muted">--</td>
                      </>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 text-xs text-ui-muted">{t("analytics.empty")}</div>
      )}
      {selectedMetrics ? (
        <details className="mt-4 rounded-lg bg-ui-highlight/20 p-3 text-xs">
          <summary className="cursor-pointer list-none text-xs font-medium text-ui-muted">
            {t("analytics.selectedTitle")}
          </summary>
          {selectedMetricKeys.length > 0 ? (
            <div
              className={scrollRegionClassName}
              tabIndex={0}
              aria-label={t("analytics.selectedTitle")}
            >
              <table className="min-w-full border-collapse text-left text-xs">
                <thead className="text-[10px] font-medium text-ui-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">
                      {t("analytics.columns.column")}
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      {t("analytics.columns.selectedCount")}
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      {t("analytics.columns.selectedSum")}
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      {t("analytics.columns.selectedAvg")}
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      {t("analytics.columns.selectedMin")}
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      {t("analytics.columns.selectedMax")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {selectedMetricKeys.map((key) => {
                    const selected = selectedMetrics.columns[key] ?? EMPTY_METRIC;
                    return (
                      <tr key={key} className="border-t border-ui-border/40">
                        <td className="px-3 py-2 text-ui-ink">
                          {resolveColumnLabelByKey(columnsByKey, key)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {selected.count}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMetricValue(selected.sum)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMetricValue(selected.avg)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMetricValue(selected.min)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMetricValue(selected.max)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mt-2 text-xs text-ui-muted">
              {t("analytics.selectedEmpty")}
            </div>
          )}
        </details>
      ) : null}
    </div>
  );
}
