import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import type { UiResourceList } from "@masarx/api";
import { createUiTranslator } from "./i18n";
import { PageHeader } from "./page-header";
import { Button } from "./button";
import { Input } from "./input";
import { Badge } from "./badge";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { resolvePaginationSettings } from "./pagination-utils";
import { resolveSafeHref } from "./url-guard";
import { readCodAmounts, formatCodMinor, totalCodAmounts, type CodAmounts } from "./cod-reconciliation-values";

type Props = {
  appBasePath: string;
  testIdPrefix?: string;
  searchParams?: Record<string, string | string[] | undefined>;
};
const resourceKey = "cod_reconciliation";
const filterKeys = ["id", "client_id", "sender_id", "tracking_number"] as const;
const moneyKeys = ["expected", "collected", "variance"] as const;
const fields = ["id", "order_reference", "tracking_number", "original_cod_amount", "original_cod_currency", "payment_collection_present", "payment_collection"];

function displayState(amounts: CodAmounts) {
  if (amounts.state !== "collected") return amounts.state;
  return amounts.variance !== null && amounts.variance > 0n ? "shortfall" :
    amounts.variance !== null && amounts.variance < 0n ? "overcollection" : "collected";
}

export async function CodReconciliationPage({ appBasePath, searchParams = {}, testIdPrefix = "cod-reconciliation" }: Props) {
  const t = createUiTranslator("ui.codReconciliation");
  const ui = createUiServerClient();
  const header = <PageHeader title={t("title")} description={t("description")} />;
  const unavailable = () => <div className="space-y-6" data-testid={`${testIdPrefix}-error`}>{header}<p role="alert">{t("unavailable")}</p></div>;
  const baseHref = resolveSafeHref(appBasePath, "/marketplace/cod-reconciliation");
  if (!baseHref) return unavailable();
  let list: UiResourceList;
  let page = 1;
  let limit = 0;
  const filters: Record<string, string> = {};
  try {
    const [registry, me] = await Promise.all([ui.readRegistry(), ui.me()]);
    const resources = Array.isArray(registry?.resources) ? registry.resources.filter((item) => item?.key === resourceKey) : [];
    const resource = resources[0];
    if (resources.length !== 1 || !resource || resource.relation !== "api.cod_reconciliation" ||
        resource.id_column !== "id" || resource.capability_read !== "shipments.read" ||
        !fields.every((field) => resource.select?.includes(field)) ||
        !hasCapability(resolveCapabilitySet(Array.isArray(me?.capabilities) ? me.capabilities : []), resource.capability_read)) return unavailable();
    const supportedFilters = resource.filters ?? [];
    if (!filterKeys.every((key) => {
      const matches = supportedFilters.filter((filter) => filter.key === key);
      return matches.length === 1 && matches[0]?.column === key && matches[0]?.op === (key === "tracking_number" ? "ilike" : "eq");
    })) return unavailable();
    for (const key of filterKeys) {
      const raw = searchParams[key];
      const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
      if (value) filters[key] = value;
    }
    const first = (key: string) => {
      const value = searchParams[key];
      return Array.isArray(value) ? value[0] : value;
    };
    let settings = resolvePaginationSettings(null);
    try { settings = resolvePaginationSettings((await ui.settingsPreview({ category: "ui_pagination" }))?.value); } catch { /* Shared pagination defaults remain bounded. */ }
    const requested = Number(first("limit") ?? settings.defaultPageSize);
    limit = settings.allowedSizes.includes(requested) ? requested : settings.defaultPageSize;
    page = Number(first("page") ?? 1);
    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 ||
        limit > settings.maxPageSize || !Number.isSafeInteger(offset)) return unavailable();
    list = await ui.listResource(resourceKey, filters, limit, offset, { key: "id", direction: "asc" });
    if (!list || list.resource !== resourceKey || !Array.isArray(list.items) ||
        list.limit !== limit || list.offset !== offset ||
        typeof list.total !== "number" || !Number.isSafeInteger(list.total) || list.total < 0 ||
        list.total_strategy !== "exact" || list.total_is_estimate !== false ||
        list.items.length !== Math.min(limit, Math.max(list.total - offset, 0)) ||
        list.items.some((row) => !row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string" || !row.id.trim()) ||
        new Set(list.items.map((row) => row.id)).size !== list.items.length) return unavailable();
  } catch { return unavailable(); }

  const rows = list.items.map((row) => ({ row, amounts: readCodAmounts(row) }));
  const totals = totalCodAmounts(rows.map(({ amounts }) => amounts));
  const money = (value: bigint | null, currency: string | null) => formatCodMinor(value, currency) ?? t("unknown");
  const href = (nextPage: number) => {
    const query = new URLSearchParams({ ...filters, limit: String(limit), page: String(nextPage) });
    return baseHref + "?" + query.toString();
  };
  const next = page * limit < (list.total ?? 0);
  return <div className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
    {header}
    <form action={baseHref} method="get" className="flex flex-wrap items-end gap-3">
      {filterKeys.map((key) => <div key={key}>
        <label htmlFor={"cod-filter-" + key}>{t("filters." + key)}</label>
        <Input id={"cod-filter-" + key} name={key} defaultValue={filters[key] ?? ""} />
      </div>)}
      <input type="hidden" name="limit" value={limit} />
      <Button type="submit">{t("apply")}</Button>
      <Button asChild variant="ghost"><a href={baseHref}>{t("clear")}</a></Button>
    </form>
    <section>
      <h2 className="text-lg font-semibold">{t("displayedRows")}</h2>
      <p className="text-sm text-ui-muted">{t("totalsNote")}</p>
      {totals.unassigned ? <p>{t("unassigned")}</p> : null}
      {totals.groups.map((group) => <dl key={group.currency} className="grid gap-3 sm:grid-cols-3">
        {moneyKeys.map((key) => <div key={key} className={key === "variance" && group.variance !== null && group.variance > 0n
          ? "rounded-lg border border-[rgb(var(--ui-danger)/0.35)] bg-[rgb(var(--ui-danger)/0.06)] p-3"
          : key === "variance" && group.variance !== null && group.variance < 0n
            ? "rounded-lg border border-[rgb(var(--ui-warning)/0.35)] bg-[rgb(var(--ui-warning)/0.06)] p-3"
            : "rounded-lg border border-ui-border p-3"}>
          <dt>{t(key)} ({group.currency})</dt><dd><bdi>{money(group[key], group.currency)}</bdi></dd>
        </div>)}
      </dl>)}
    </section>
    {rows.length === 0 ? <p>{t("empty")}</p> : <div className="overflow-x-auto">
      <table className="w-full text-start text-sm">
        <caption className="text-start">{t("tableCaption")}</caption>
        <thead><tr>{["order", "tracking", ...moneyKeys, "status"].map((key) =>
          <th key={key} scope="col" className="p-3 text-start">{t(key)}</th>)}</tr></thead>
        <tbody>{rows.map(({ row, amounts }) => {
          const state = displayState(amounts);
          const danger = state === "shortfall" || state === "refused" || state === "invalid";
          const warning = state === "overcollection" || state === "unknown";
          return <tr key={row.id as string} className={"border-t border-ui-border " + (danger
            ? "bg-[rgb(var(--ui-danger)/0.06)]"
            : warning ? "bg-[rgb(var(--ui-warning)/0.06)]" : "")}>
          <th scope="row" className="p-3 text-start">{typeof row.order_reference === "string" ? row.order_reference : t("unknown")}</th>
          <td className="p-3"><bdi>{typeof row.tracking_number === "string" ? row.tracking_number : t("unknown")}</bdi></td>
          {moneyKeys.map((key) => <td className="p-3" key={key}><bdi>{money(amounts[key], amounts.currency)}</bdi></td>)}
          <td className="p-3"><Badge tone={danger ? "danger" : warning ? "warning" : "success"}>{t("states." + state)}</Badge></td>
        </tr>})}</tbody>
      </table>
    </div>}
    <nav aria-label={t("pagination")} className="flex items-center gap-3">
      {page > 1 ? <Button asChild variant="ghost"><a href={href(page - 1)}>{t("previous")}</a></Button> : null}
      <span>{t("page", { page: String(page) })}</span>
      {next && Number.isSafeInteger(page * limit) ? <Button asChild variant="ghost"><a href={href(page + 1)}>{t("next")}</a></Button> : null}
    </nav>
  </div>;
}
