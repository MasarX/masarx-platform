import "server-only";
import { createUiServerClient } from "@masarx/api/server";
import { createUiTranslator } from "./i18n";
import { loadTrackingDataset } from "./tracking-map-composer";
import { TrackingMap } from "./tracking-map";
import { resolveTrackingMapConfiguration } from "./tracking-map-policy";

type Props = {
  searchParams: Record<string, string | string[] | undefined>;
  locale: string;
  baseHref: string;
  testIdPrefix: string;
};
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
export async function TrackingMapPage({ searchParams, locale, baseHref, testIdPrefix }: Props) {
  const t = createUiTranslator("ui.trackingMap", { locale });
  const ui = createUiServerClient();
  try {
    const data = await loadTrackingDataset({ limit: first(searchParams.limit), offset: first(searchParams.offset) }, ui);
    let map = null;
    if (data.pins.length) {
      const me = await ui.me();
      const scopeType = me?.access_scope?.scope_type;
      const scopeId = me?.access_scope?.scope_id;
      const orgId = me?.org?.id;
      const context: Record<string, unknown> = orgId ? { organization_id: orgId } : {};
      if (scopeType === "tenant") {
        if (!scopeId && !orgId) throw new Error("tracking_policy_scope_unavailable");
        context.organization_id = scopeId ?? orgId;
      } else if (scopeType === "client" || scopeType === "sender") {
        if (!scopeId) throw new Error("tracking_policy_scope_unavailable");
        context[scopeType === "client" ? "client_id" : "sender_id"] = scopeId;
      } else if (scopeType !== "platform" && scopeType !== "global") throw new Error("tracking_policy_scope_unavailable");
      const resolved = await ui.mapPolicy(context);
      const policy = resolveTrackingMapConfiguration(resolved?.value);
      map = policy.ok
        ? <TrackingMap key={data.identity} identity={data.identity} pins={data.pins} policy={policy} labels={{ map: t("map"), loading: t("loading"), unavailable: t("unavailable"), empty: t("empty") }} />
        : <p role="alert" data-testid="tracking-map-policy-blocked">{t("unavailable")}</p>;
    }
    const href = (offset: number) => `${baseHref}?${new URLSearchParams({ offset: String(offset), limit: String(data.limit) })}`;
    return <main data-testid={`${testIdPrefix}-ready`}>
      <h1>{t("title")}</h1>
      {map}
      {data.resource === "tracking_shipments" && data.locations.length > 0 ? <table>
        <caption>{t("fallback")} — {t("pageCount", { count: data.locations.length })}</caption>
        <thead><tr>{["trackingNumber", "status", "originCity", "destinationCity", "serviceType", "updatedAt"].map(key => <th key={key} scope="col">{t(key)}</th>)}</tr></thead>
        <tbody>{data.locations.map(row => <tr key={row.id}>
          <td>{row.trackingNumber ?? "-"}</td><td>{row.status?.replace(/_/g, " ") ?? "-"}</td>
          <td>{row.originCity ?? "-"}</td><td>{row.destinationCity ?? "-"}</td><td>{row.serviceType ?? "-"}</td>
          <td>{row.updatedAt && Number.isFinite(Date.parse(row.updatedAt)) ? new Intl.DateTimeFormat(locale).format(new Date(row.updatedAt)) : "-"}</td>
        </tr>)}</tbody>
      </table> : null}
      {!data.pins.length && !data.locations.length ? <p role="status">{t(data.datasetEmpty ? "empty" : "emptyPage")}</p> : null}
      <nav aria-label={t("pagination")}>
        {data.offset > 0 ? <a href={href(Math.max(0, data.offset - data.limit))}>{t("previous")}</a> : null}
        {data.hasNext ? <a href={href(data.offset + data.limit)}>{t("next")}</a> : null}
      </nav>
    </main>;
  } catch {
    return <main><h1>{t("title")}</h1><p role="alert" data-testid={`${testIdPrefix}-error`}>{t("unavailable")}</p></main>;
  }
}
